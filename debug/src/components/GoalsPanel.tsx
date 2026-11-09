import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import type { Doc } from "../../../convex/_generated/dataModel.js";
import { computePacing, type GoalPacing } from "../../../server/goals/pacing.js";
import { PanelPage, panelCardClass, subtlePanelClass } from "./PanelPrimitives.js";

type Status = Doc<"goals">["status"];

const STATUSES: { id: Status; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "done", label: "Done" },
  { id: "dropped", label: "Dropped" },
];

const PACING: Record<GoalPacing["status"], { label: string; dark: string; light: string }> = {
  on_track: { label: "On track", dark: "text-emerald-400", light: "text-emerald-700" },
  behind: { label: "Behind", dark: "text-amber-400", light: "text-amber-700" },
  past_deadline: { label: "Past deadline", dark: "text-rose-400", light: "text-rose-700" },
  done: { label: "Target reached", dark: "text-emerald-400", light: "text-emerald-700" },
  unknown: { label: "No target", dark: "text-zinc-400", light: "text-zinc-500" },
};

/** Goal dates are in the user's configured timezone, which may not be the browser's. */
function localToday(timezone: string | null | undefined): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone ?? undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function deadlineText(days: number): string {
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  if (days > 1) return `${days} days left`;
  return days === -1 ? "1 day overdue" : `${-days} days overdue`;
}

function channel(conversationId: string): string {
  if (conversationId.startsWith("telegram:")) return "Telegram";
  if (conversationId.startsWith("sms:")) return "iMessage";
  return "Chat";
}

function progressText(goal: Doc<"goals">): string {
  if (goal.total === undefined && !goal.unit) return "No count tracked";
  const unit = goal.unit ? ` ${goal.unit}` : "";
  return goal.total === undefined ? `${goal.progress}${unit}` : `${goal.progress} of ${goal.total}${unit}`;
}

function GoalDetails({ goal, today, isDark }: { goal: Doc<"goals">; today: string; isDark: boolean }) {
  const updates = useQuery(api.goals.recentUpdates, { goalId: goal.goalId, limit: 10 });
  const milestoneState = (m: Doc<"goals">["milestones"][number]) => {
    if (m.target !== undefined && goal.progress >= m.target) return "Reached";
    if (m.date < today) return m.target === undefined ? "Passed" : "Missed";
    return "Upcoming";
  };
  return (
    <div className="mt-4 grid gap-3 border-t border-zinc-500/20 pt-4 sm:grid-cols-2">
      <section className={subtlePanelClass(isDark, "p-3")}>
        <h4 className="text-xs font-medium">Milestones</h4>
        {goal.milestones.length ? (
          <ul className="mt-2 space-y-2 text-sm">
            {goal.milestones.map((m) => (
              <li key={`${m.date}-${m.label}`} className="flex justify-between gap-3">
                <span className="min-w-0 break-words">
                  {m.label}
                  <span className="block text-xs text-zinc-500">
                    {formatDate(m.date)}
                    {m.target !== undefined ? ` · target ${m.target}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-zinc-500">{milestoneState(m)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-zinc-500">No milestones.</p>
        )}
      </section>
      <section className={subtlePanelClass(isDark, "p-3")}>
        <h4 className="text-xs font-medium">Progress history</h4>
        {updates === undefined ? (
          <p className="mt-2 text-sm text-zinc-500">Loading…</p>
        ) : updates.length ? (
          <ul className="mt-2 space-y-2 text-sm">
            {[...updates].reverse().map((u) => (
              <li key={u._id} className="flex justify-between gap-3">
                <span className="min-w-0 break-words">
                  {u.progress}
                  {goal.unit ? ` ${goal.unit}` : ""}
                  {u.note && <span className="block text-xs text-zinc-500">{u.note}</span>}
                </span>
                <span className="shrink-0 text-xs text-zinc-500">{new Date(u.createdAt).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-zinc-500">No progress reported yet.</p>
        )}
      </section>
      {goal.notes && (
        <section className={subtlePanelClass(isDark, "p-3 sm:col-span-2")}>
          <h4 className="text-xs font-medium">Plan notes</h4>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-zinc-500">{goal.notes}</p>
        </section>
      )}
    </div>
  );
}

function GoalCard({ goal, today, isDark }: { goal: Doc<"goals">; today: string; isDark: boolean }) {
  const [open, setOpen] = useState(false);
  const active = goal.status === "active";
  const pacing = computePacing(goal, today);
  const tone = PACING[pacing.status];
  return (
    <article className={panelCardClass(isDark, "p-4")}>
      <button className="w-full text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <div className="flex justify-between gap-3">
          <span className="min-w-0 break-words font-medium">{goal.title}</span>
          {active && <span className={`shrink-0 text-xs font-medium ${isDark ? tone.dark : tone.light}`}>{tone.label}</span>}
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          {formatDate(goal.deadline)}
          {active ? ` · ${deadlineText(pacing.daysToDeadline)}` : ""} · {channel(goal.conversationId)}
        </p>
        {pacing.percent !== undefined && (
          <div
            role="progressbar"
            aria-label={`${goal.title} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(pacing.percent, 100)}
            className={`mt-3 h-1.5 overflow-hidden rounded-full ${isDark ? "bg-white/10" : "bg-zinc-200"}`}
          >
            <div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.min(pacing.percent, 100)}%` }} />
          </div>
        )}
        <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-zinc-500">
          <span>
            {progressText(goal)}
            {pacing.percent !== undefined ? ` · ${pacing.percent}%` : ""}
          </span>
          {active && pacing.next && (
            <span>
              Next: {pacing.next.label}, {formatDate(pacing.next.date)}
              {pacing.next.perDay ? ` · ${pacing.next.perDay}/day` : ""}
            </span>
          )}
        </div>
      </button>
      {open && <GoalDetails goal={goal} today={today} isDark={isDark} />}
    </article>
  );
}

export function GoalsPanel({ isDark, demoMode = false }: { isDark: boolean; demoMode?: boolean }) {
  const [status, setStatus] = useState<Status>("active");
  const goals = useQuery(api.goals.listForDashboard, demoMode ? "skip" : {});
  const timezone = useQuery(api.settings.get, { key: "user_timezone" }) as string | null | undefined;
  const today = localToday(timezone);
  const shown = (goals ?? [])
    .filter((goal) => goal.status === status)
    .sort((a, b) => (status === "active" ? a.deadline.localeCompare(b.deadline) : b.updatedAt - a.updatedAt));
  const tab = "rounded-lg border px-3 py-1.5 text-sm";
  return (
    <PanelPage eyebrow="Planning" title="Goals" description="Deadlines Boop is tracking, with pacing and progress. Text Boop to change them.">
      {demoMode ? (
        <p className="text-sm text-zinc-500">Your goals are hidden in demo mode.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {STATUSES.map((s) => (
              <button
                key={s.id}
                aria-pressed={status === s.id}
                onClick={() => setStatus(s.id)}
                className={`${tab} ${isDark ? "border-white/10 bg-[#202024]" : "border-zinc-200 bg-white"} ${status === s.id ? "ring-1 ring-violet-500" : ""}`}
              >
                {s.label} ({(goals ?? []).filter((goal) => goal.status === s.id).length})
              </button>
            ))}
          </div>
          {goals === undefined ? (
            <p className="text-sm text-zinc-500">Loading goals…</p>
          ) : !shown.length ? (
            <p className="py-10 text-sm text-zinc-500">
              {status === "active" ? 'No active goals. Text Boop something like "Midterm is Nov 12, 12 lectures to review."' : `No ${status} goals.`}
            </p>
          ) : (
            <div className="space-y-3">
              {shown.map((goal) => (
                <GoalCard key={goal._id} goal={goal} today={today} isDark={isDark} />
              ))}
            </div>
          )}
        </>
      )}
    </PanelPage>
  );
}
