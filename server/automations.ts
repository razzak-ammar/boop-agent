import { redactPhoneNumbers } from "./privacy.js";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { spawnExecutionAgent } from "./execution-agent.js";
import { sendConversationNotification } from "./notifications.js";
import { broadcast } from "./broadcast.js";
import { getUserTimezone } from "./timezone-config.js";
import { followingRun, nextCronRun } from "./reminder-schedule.js";
import { runGoalCheckin } from "./goals/checkin.js";
import { recordLookaheadDelivered, runLookahead, type LookaheadResult } from "./tasks/lookahead.js";
import { runFreeTimeCheck } from "./freetime/checkin.js";
import { FREETIME_TASK } from "./tasks/tools.js";

export function nextRunFor(schedule: string, timezone = "UTC"): number | null {
  try {
    return nextCronRun(schedule, timezone);
  } catch {
    return null;
  }
}
export function validateSchedule(
  schedule: string,
  timezone = "UTC",
): { valid: boolean; error?: string } {
  try {
    if (nextCronRun(schedule, timezone) === null)
      return { valid: false, error: "No future occurrence" };
    return { valid: true };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}
function randomId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

type Automation = NonNullable<Awaited<ReturnType<typeof claimAutomation>>>["a"];

interface RunOptions {
  /** Reminders due for the same chat at the same moment. A check-in or
   * lookahead works them into its one message instead of sending them apart. */
  alsoDue?: string[];
  /** This reminder was already worked into that automation's message. */
  foldedInto?: string;
}

async function claimAutomation(automationId: string) {
  const runId = randomId();
  const a = await convex.mutation(api.automations.claimRun, {
    automationId,
    runId,
  });
  if (!a) return null;
  const claim = { automationId, runId };
  const state = { leaseLost: false };
  const heartbeat = setInterval(() => {
    convex
      .mutation(api.automations.renewClaim, claim)
      .then((ok) => {
        if (!ok) state.leaseLost = true;
      })
      .catch(() => {
        state.leaseLost = true;
      });
  }, 30000);
  broadcast("automation_started", { ...claim, name: a.name });
  return { a, claim, state, heartbeat };
}

type Claimed = NonNullable<Awaited<ReturnType<typeof claimAutomation>>>;

/** Returns whether a message reached the user. */
async function executeClaimed(
  { a, claim, state, heartbeat }: Claimed,
  opts: RunOptions = {},
): Promise<boolean> {
  const { automationId } = claim;
  let result: string | undefined;
  let agentId: string | undefined;
  let error: string | undefined;
  let goalInactive = false;
  let lookahead: LookaheadResult | undefined;
  let sent = false;
  const alsoDue = opts.alsoDue?.length ? opts.alsoDue : undefined;
  try {
    if (a.delivery === "reminder") {
      if (!a.reminderText) throw new Error("Reminder text is missing.");
      result = a.reminderText;
    } else if (a.delivery === "checkin") {
      // The model may decide there's nothing worth sending; no result means
      // no message, but the run still counts as successful.
      const res = alsoDue ? await runGoalCheckin(a, alsoDue) : await runGoalCheckin(a);
      result = res.text;
      goalInactive = res.inactive === true;
    } else if (a.delivery === "lookahead" && a.task === FREETIME_TASK) {
      lookahead = alsoDue ? await runFreeTimeCheck(a, alsoDue) : await runFreeTimeCheck(a);
      result = lookahead.text;
    } else if (a.delivery === "lookahead") {
      lookahead = alsoDue ? await runLookahead(a, alsoDue) : await runLookahead(a);
      result = lookahead.text;
    } else {
      const res = await spawnExecutionAgent({
        task: `AUTOMATION "${a.name}": ${a.task}`,
        integrations: a.integrations,
        conversationId: a.conversationId,
        name: `auto:${a.name}`,
      });
      result = res.result;
      agentId = res.agentId;
      if (res.status !== "completed")
        error = res.result || "Automation execution failed.";
    }
    if (
      state.leaseLost ||
      !(await convex.mutation(api.automations.renewClaim, claim))
    )
      throw new Error("Reminder paused, removed, or execution lease lost.");
    if (a.notifyConversationId && result && !opts.foldedInto) {
      const text = redactPhoneNumbers(a.delivery === "reminder"
        ? `Reminder: ${result}`
        : a.delivery === "checkin" || a.delivery === "lookahead"
          ? result
          : `[${a.name}]\n\n${result}`);
      await sendConversationNotification(a.notifyConversationId, text);
      sent = true;
      await convex.mutation(api.messages.send, {
        conversationId: a.notifyConversationId,
        role: "assistant",
        content: text,
      });
      if (lookahead) await recordLookaheadDelivered(a.notifyConversationId, lookahead);
    }
  } catch (err) {
    error = String(err);
  } finally {
    clearInterval(heartbeat);
  }
  const timezone = a.timezone ?? (await getUserTimezone());
  let nextRunAt: number | undefined;
  try {
    nextRunAt = followingRun(a, Date.now(), timezone) ?? undefined;
  } catch (err) {
    error ??= String(err);
  }
  await convex.mutation(api.automations.finishRun, {
    ...claim,
    success: error === undefined,
    result: opts.foldedInto && result ? `${result} (sent inside "${opts.foldedInto}")` : result,
    agentId,
    error,
    nextRunAt,
  });
  if (goalInactive)
    await convex.mutation(api.automations.setEnabled, { automationId, enabled: false });
  broadcast(error ? "automation_failed" : "automation_completed", {
    ...claim,
    ...(error ? { error } : {}),
  });
  return sent;
}

const writesOwnMessage = (a: Automation) =>
  a.delivery === "checkin" || a.delivery === "lookahead";

/** Everything due for one chat in this tick. Claimed up front so a slow
 * model-written message can't let a later tick send the same reminders
 * separately. Check-ins and lookaheads run one at a time (each sees the one
 * before it in the conversation) and the first one that sends a message
 * carries the plain reminders due with it, so the user gets one message
 * instead of a reminder and a check-in about the same exam. */
async function runConversationBatch(automationIds: string[]): Promise<void> {
  const claimed = (await Promise.all(automationIds.map(claimAutomation)))
    .filter((c): c is Claimed => c !== null);
  const writers = claimed.filter((c) => writesOwnMessage(c.a));
  let reminders = claimed.filter((c) => c.a.delivery === "reminder" && c.a.reminderText);
  const rest = claimed.filter((c) => !writers.includes(c) && !reminders.includes(c));
  const others = rest.map((c) => executeClaimed(c));
  for (const writer of writers) {
    const alsoDue = reminders.map((r) => r.a.reminderText!);
    const sent = await executeClaimed(writer, { alsoDue });
    if (sent && reminders.length) {
      await Promise.all(reminders.map((r) => executeClaimed(r, { foldedInto: writer.a.name })));
      reminders = [];
    }
  }
  await Promise.all([...others, ...reminders.map((r) => executeClaimed(r))]);
}

export async function tickAutomations(): Promise<void> {
  const now = Date.now();
  const all = await convex.query(api.automations.due, { now });
  const batches = new Map<string, string[]>();
  for (const a of all) {
    if (a.nextRunAt === undefined || a.nextRunAt > now) continue;
    const key = a.notifyConversationId ?? a.automationId;
    batches.set(key, [...(batches.get(key) ?? []), a.automationId]);
  }
  await Promise.all(
    [...batches.values()].map((ids) =>
      runConversationBatch(ids).catch((err) =>
        console.error("[automations] run error", err),
      ),
    ),
  );
}
export function startAutomationLoop(intervalMs = 10000): () => void {
  const tick = () =>
    tickAutomations().catch((err) =>
      console.error("[automations] tick error", err),
    );
  void tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
