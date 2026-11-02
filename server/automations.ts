import { redactPhoneNumbers } from "./privacy.js";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { spawnExecutionAgent } from "./execution-agent.js";
import { sendConversationNotification } from "./notifications.js";
import { broadcast } from "./broadcast.js";
import { getUserTimezone } from "./timezone-config.js";
import { followingRun, nextCronRun } from "./reminder-schedule.js";

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

async function runAutomation(automationId: string): Promise<void> {
  const runId = randomId();
  const a = await convex.mutation(api.automations.claimRun, {
    automationId,
    runId,
  });
  if (!a) return;
  const claim = { automationId, runId };
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    convex
      .mutation(api.automations.renewClaim, claim)
      .then((ok) => {
        if (!ok) leaseLost = true;
      })
      .catch(() => {
        leaseLost = true;
      });
  }, 30000);
  broadcast("automation_started", { ...claim, name: a.name });
  let result: string | undefined;
  let agentId: string | undefined;
  let error: string | undefined;
  try {
    if (a.delivery === "reminder") {
      if (!a.reminderText) throw new Error("Reminder text is missing.");
      result = a.reminderText;
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
      leaseLost ||
      !(await convex.mutation(api.automations.renewClaim, claim))
    )
      throw new Error("Reminder paused, removed, or execution lease lost.");
    if (a.notifyConversationId && result) {
      const text = redactPhoneNumbers(a.delivery === "reminder"
        ? `Reminder: ${result}`
        : `[${a.name}]\n\n${result}`);
      await sendConversationNotification(a.notifyConversationId, text);
      await convex.mutation(api.messages.send, {
        conversationId: a.notifyConversationId,
        role: "assistant",
        content: text,
      });
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
    result,
    agentId,
    error,
    nextRunAt,
  });
  broadcast(error ? "automation_failed" : "automation_completed", {
    ...claim,
    ...(error ? { error } : {}),
  });
}
export async function tickAutomations(): Promise<void> {
  const now = Date.now();
  const all = await convex.query(api.automations.due, { now });
  await Promise.all(
    all
      .filter((a) => a.nextRunAt !== undefined && a.nextRunAt <= now)
      .map((a) =>
        runAutomation(a.automationId).catch((err) =>
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
