import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import type { Doc } from "../../../convex/_generated/dataModel.js";
import {
  EmptyState,
  HeaderPill,
  PanelPage,
  mutedTextClass,
  panelCardClass,
  subtlePanelClass,
} from "./PanelPrimitives.js";
import { SettingShell } from "./SettingsPanel.js";

/** Same key as server/freetime/checkin.ts BUSY_CALENDARS_KEY. */
const BUSY_CALENDARS_KEY = "freetime_busy_calendars";
const STATUS_REFRESH_MS = 60_000;

interface StatusResponse {
  automation: {
    automationId: string;
    enabled: boolean;
    lastRunAt: number | null;
    nextRunAt: number | null;
    lastError: string | null;
  } | null;
  status:
    | { ready: false; reason: string }
    | {
        ready: true;
        timezone: string;
        nowLabel: string;
        wouldWake: boolean;
        trigger?: "event_ended" | "heartbeat";
        reason: string;
        freeMinutes: number | null;
        next: { title: string; startLabel: string } | null;
        upcomingEnds: { title: string; startLabel: string; endLabel: string; start: number; end: number }[];
        lastCheckAt: number | null;
        lastCheckLabel: string | null;
        minutesSinceMessage: number | null;
        quiet: { start: string; end: string; enabled: boolean; description: string; active: boolean };
        busyCalendars: string[] | null;
        openTasks: number;
        activeGoals: number;
        model: string;
        rules: {
          everySeconds: number;
          heartbeatMinutes: number;
          endWindowMinutes: number;
          cooldownMinutes: number;
          afterEventCooldownMinutes: number;
          minFreeMinutes: number;
        };
      };
}

function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "never";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function useHeartbeatStatus() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/freetime/status", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error ?? "Couldn't load the heartbeat status.");
      else {
        setData(body);
        setError(null);
      }
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  return { data, error, loading, refresh };
}

export function HeartbeatPanel({ isDark }: { isDark: boolean }) {
  const { data, error, loading, refresh } = useHeartbeatStatus();
  const events = useQuery(api.heartbeatEvents.recent, { limit: 60 });
  const sentToday = (events ?? []).filter(
    (e) => e.outcome === "sent" && new Date(e.at).toDateString() === new Date().toDateString(),
  ).length;

  return (
    <PanelPage
      eyebrow="Proactive"
      title="Heartbeat"
      description="Boop watches your calendar and checks in when a free slot opens. Everything it decides shows up here."
      stat={<HeaderPill isDark={isDark}>{sentToday} sent today</HeaderPill>}
      action={
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className={`rounded-2xl border px-3 py-1 text-xs ${
            isDark ? "border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10" : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
          } ${loading ? "opacity-50" : ""}`}
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      }
    >
      <StatusCard isDark={isDark} data={data} error={error} />

      <section className="space-y-3">
        <SectionTitle isDark={isDark}>Settings</SectionTitle>
        <EnabledRow isDark={isDark} data={data} onChange={refresh} />
        <QuietHoursRow isDark={isDark} onChange={refresh} />
        <BusyCalendarsRow isDark={isDark} />
        {data?.status.ready && <RulesNote isDark={isDark} rules={data.status.rules} />}
      </section>

      <section className="space-y-3">
        <SectionTitle isDark={isDark}>Activity</SectionTitle>
        <ActivityLog isDark={isDark} events={events} />
      </section>
    </PanelPage>
  );
}

function SectionTitle({ children, isDark }: { children: ReactNode; isDark: boolean }) {
  return (
    <h3 className={`pt-2 text-[11px] font-medium uppercase tracking-[0.08em] ${mutedTextClass(isDark)}`}>
      {children}
    </h3>
  );
}

function Fact({ label, value, isDark }: { label: string; value: ReactNode; isDark: boolean }) {
  return (
    <div className={subtlePanelClass(isDark, "px-3 py-2")}>
      <div className={`text-[11px] ${mutedTextClass(isDark)}`}>{label}</div>
      <div className="mt-0.5 text-sm">{value}</div>
    </div>
  );
}

function StatusCard({ isDark, data, error }: { isDark: boolean; data: StatusResponse | null; error: string | null }) {
  if (error && !data) return <EmptyState isDark={isDark}>{error}</EmptyState>;
  if (!data) return <EmptyState isDark={isDark}>Checking what the heartbeat sees…</EmptyState>;
  const { automation, status } = data;

  let headline: string;
  let tone: "on" | "idle" | "off";
  if (!automation || !automation.enabled) {
    headline = automation ? "Off. Free-time check-ins are turned off." : "Not set up yet.";
    tone = "off";
  } else if (!status.ready) {
    headline = status.reason;
    tone = "off";
  } else if (status.quiet.active) {
    headline = `Asleep for quiet hours (${status.quiet.description}).`;
    tone = "idle";
  } else if (status.wouldWake) {
    headline = status.trigger === "event_ended"
      ? `Checking in: ${status.reason}.`
      : "Due for its hourly check while you're free.";
    tone = "on";
  } else {
    headline = `Watching: ${status.reason}.`;
    tone = "idle";
  }
  const dot = tone === "on" ? "bg-emerald-500" : tone === "idle" ? "bg-sky-500" : "bg-zinc-400";

  return (
    <div className={panelCardClass(isDark, "p-4")}>
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${dot} ${tone === "on" ? "animate-pulse" : ""}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{headline}</div>
          <div className={`mt-1 text-xs ${mutedTextClass(isDark)}`}>
            {automation?.enabled
              ? `Last looked ${timeAgo(automation.lastRunAt)}. It looks every 5 minutes; most looks don't wake the model.`
              : "Turn it on below to start watching."}
            {automation?.lastError ? ` Last error: ${automation.lastError}` : ""}
          </div>
        </div>
      </div>

      {status.ready && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Fact
            isDark={isDark}
            label="Free right now"
            value={
              status.quiet.active
                ? "Quiet hours"
                : status.freeMinutes === null
                  ? "Rest of the day"
                  : status.next
                    ? `${status.freeMinutes} min, until ${status.next.title.slice(0, 28)} at ${status.next.startLabel}`
                    : `${status.freeMinutes} min, until quiet hours`
            }
          />
          <Fact
            isDark={isDark}
            label="Next check-in moment"
            value={
              status.upcomingEnds[0]
                ? `${status.upcomingEnds[0].endLabel}, after ${status.upcomingEnds[0].title.slice(0, 28)}`
                : "No more busy events today"
            }
          />
          <Fact
            isDark={isDark}
            label="Last woke the model"
            value={status.lastCheckAt ? `${status.lastCheckLabel} (${timeAgo(status.lastCheckAt)})` : "Not yet"}
          />
          <Fact
            isDark={isDark}
            label="Last chat message"
            value={status.minutesSinceMessage === null ? "None yet" : `${status.minutesSinceMessage} min ago`}
          />
          <Fact isDark={isDark} label="Has something to suggest" value={`${status.openTasks} open tasks · ${status.activeGoals} goals`} />
          <Fact isDark={isDark} label="Model" value={<span className="mono text-xs">{status.model}</span>} />
          <Fact isDark={isDark} label="Quiet hours" value={status.quiet.description} />
          <Fact
            isDark={isDark}
            label="Busy calendars"
            value={status.busyCalendars?.length ? status.busyCalendars.join(", ") : "All calendars"}
          />
        </div>
      )}

      {status.ready && status.upcomingEnds.length > 1 && (
        <div className={`mt-3 text-xs ${mutedTextClass(isDark)}`}>
          Later today:{" "}
          {status.upcomingEnds.slice(1).map((e) => `${e.title.slice(0, 24)} ends ${e.endLabel}`).join(" · ")}
        </div>
      )}
    </div>
  );
}

function EnabledRow({ isDark, data, onChange }: { isDark: boolean; data: StatusResponse | null; onChange: () => void }) {
  const setEnabled = useMutation(api.automations.setEnabled);
  const automation = data?.automation;
  const enabled = automation?.enabled ?? false;
  return (
    <SettingShell
      label="Free-time check-ins"
      description={
        automation
          ? "When on, Boop may text you right after a class or meeting ends, or about once an hour while you're free, if something on your list fits the gap. You can also text Boop \"stop the free-time check-ins\"."
          : "Not set up yet. Text Boop \"check in on me when I'm free\", or add a task, and it appears here."
      }
      debugLine={automation ? `automation ${automation.automationId}` : "no free-time automation"}
      isDark={isDark}
      control={
        <Switch
          isDark={isDark}
          on={enabled}
          disabled={!automation}
          label="Toggle free-time check-ins"
          onClick={async () => {
            if (!automation) return;
            await setEnabled({ automationId: automation.automationId, enabled: !enabled });
            onChange();
          }}
        />
      }
    />
  );
}

function Switch({ isDark, on, disabled, label, onClick }: { isDark: boolean; on: boolean; disabled?: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`toggle-switch relative inline-flex h-6 w-11 shrink-0 items-center rounded-full ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      } ${on ? "bg-emerald-500" : isDark ? "bg-zinc-700" : "bg-zinc-300"}`}
    >
      <span className={`toggle-thumb inline-block h-5 w-5 transform rounded-full bg-white shadow ${on ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

interface QuietHoursValue {
  start: string;
  end: string;
  enabled: boolean;
  description: string;
}

function QuietHoursRow({ isDark, onChange }: { isDark: boolean; onChange: () => void }) {
  const [value, setValue] = useState<QuietHoursValue | null>(null);
  const [draft, setDraft] = useState({ start: "22:00", end: "08:00" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/quiet-hours", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((q: QuietHoursValue) => {
        setValue(q);
        setDraft({ start: q.start, end: q.end });
      })
      .catch(() => setError("Couldn't load quiet hours."));
  }, []);

  async function save(patch: Partial<Pick<QuietHoursValue, "start" | "end" | "enabled">>) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/quiet-hours", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Couldn't save.");
        if (value) setDraft({ start: value.start, end: value.end });
        return;
      }
      setValue(body);
      setDraft({ start: body.start, end: body.end });
      onChange();
    } finally {
      setSaving(false);
    }
  }

  const enabled = value?.enabled ?? true;
  const input = `rounded-xl border px-2.5 py-1.5 text-sm mono ${
    isDark ? "border-white/10 bg-white/5 text-zinc-100" : "border-zinc-200 bg-white text-zinc-900"
  } ${enabled ? "" : "opacity-50"}`;

  return (
    <SettingShell
      label="Quiet hours"
      description={`Boop won't start a conversation in this window: no free-time check-ins or hourly task nudges. Reminders you scheduled for a specific time still go out. You can also text Boop, e.g. "quiet hours 11pm to 7am".${
        error ? ` ${error}` : ""
      }`}
      debugLine={`settings.quiet_hours = ${value ? JSON.stringify({ start: value.start, end: value.end, enabled: value.enabled }) : "…"}`}
      isDark={isDark}
      control={
        <div className="flex items-center gap-2">
          <input
            type="time"
            aria-label="Quiet hours start"
            value={draft.start}
            disabled={!value || saving || !enabled}
            onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))}
            onBlur={() => value && draft.start !== value.start && save({ start: draft.start })}
            className={input}
          />
          <span className={`text-xs ${mutedTextClass(isDark)}`}>to</span>
          <input
            type="time"
            aria-label="Quiet hours end"
            value={draft.end}
            disabled={!value || saving || !enabled}
            onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))}
            onBlur={() => value && draft.end !== value.end && save({ end: draft.end })}
            className={input}
          />
          <span className="ml-1">
            <Switch
              isDark={isDark}
              on={enabled}
              disabled={!value || saving}
              label="Toggle quiet hours"
              onClick={() => void save({ enabled: !enabled })}
            />
          </span>
        </div>
      }
    />
  );
}

function BusyCalendarsRow({ isDark }: { isDark: boolean }) {
  const value = useQuery(api.settings.get, { key: BUSY_CALENDARS_KEY });
  const setSetting = useMutation(api.settings.set);
  const clearSetting = useMutation(api.settings.clear);
  const [calendars, setCalendars] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/freetime/calendars", { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setError(body.error ?? "Couldn't load calendars.");
        else setCalendars(body.calendars ?? []);
      })
      .catch(() => !cancelled && setError("Couldn't reach the server."));
    return () => {
      cancelled = true;
    };
  }, []);

  let selected: string[] = [];
  try {
    const parsed = value ? JSON.parse(value) : [];
    if (Array.isArray(parsed)) selected = parsed.filter((n): n is string => typeof n === "string");
  } catch {
    /* treat a malformed value as unset */
  }
  const isOn = (name: string) => selected.some((s) => s.toLowerCase() === name.toLowerCase());

  async function toggle(name: string) {
    const next = isOn(name)
      ? selected.filter((s) => s.toLowerCase() !== name.toLowerCase())
      : [...selected, name];
    if (next.length) await setSetting({ key: BUSY_CALENDARS_KEY, value: JSON.stringify(next) });
    else await clearSetting({ key: BUSY_CALENDARS_KEY });
  }

  // Picked calendars first; names that were saved but no longer exist still
  // show, so they can be removed.
  const names = [...new Set([...selected, ...(calendars ?? [])])];
  const pill = (on: boolean) =>
    `rounded-full border px-3 py-1 text-xs transition-colors ${
      on
        ? "border-emerald-500 bg-emerald-500 text-white"
        : isDark
          ? "border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10"
          : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
    }`;

  return (
    <SettingShell
      label="Busy calendars"
      description={
        selected.length
          ? "Only events on these calendars mean you're busy. When one ends and you have time, Boop may check in. Other calendars are ignored for timing, though their all-day items still count as context."
          : "No calendars picked, so every calendar counts as busy time. Pick the ones that mean you're actually busy (classes, meetings) so shared or availability calendars don't hide your free time."
      }
      debugLine={`settings.${BUSY_CALENDARS_KEY} = ${value === undefined ? "…" : value === null ? "(unset: all calendars)" : value}`}
      isDark={isDark}
      control={
        <div className="flex max-w-[26rem] flex-wrap gap-2 lg:justify-end">
          {error && !names.length ? (
            <span className={`text-xs ${mutedTextClass(isDark)}`}>{error}</span>
          ) : calendars === null && !names.length ? (
            <span className={`text-xs ${mutedTextClass(isDark)}`}>Loading calendars…</span>
          ) : (
            names.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => toggle(name)}
                disabled={value === undefined}
                aria-pressed={isOn(name)}
                className={pill(isOn(name))}
              >
                {name}
              </button>
            ))
          )}
        </div>
      }
    />
  );
}

function RulesNote({ isDark, rules }: { isDark: boolean; rules: Extract<StatusResponse["status"], { ready: true }>["rules"] }) {
  return (
    <div className={subtlePanelClass(isDark, `px-4 py-3 text-xs leading-relaxed ${mutedTextClass(isDark)}`)}>
      <span className="font-medium">How it decides.</span> It looks every {Math.round(rules.everySeconds / 60)} minutes
      without calling the model. It wakes the model within {rules.endWindowMinutes} minutes of a busy event ending, or
      every {rules.heartbeatMinutes} minutes while you're free. It skips gaps under {rules.minFreeMinutes} minutes,
      times when there's nothing on your list, and anything within {rules.afterEventCooldownMinutes} minutes (after an
      event) or {rules.cooldownMinutes} minutes (hourly check) of a message in the chat. The model then decides whether
      a message is worth sending; usually it isn't.
    </div>
  );
}

const OUTCOME: Record<Doc<"heartbeatEvents">["outcome"], { label: string; dark: string; light: string }> = {
  sent: { label: "Sent", dark: "bg-emerald-500/15 text-emerald-300", light: "bg-emerald-50 text-emerald-700" },
  sending: { label: "Sending", dark: "bg-sky-500/15 text-sky-300", light: "bg-sky-50 text-sky-700" },
  quiet: { label: "Stayed quiet", dark: "bg-white/10 text-zinc-300", light: "bg-zinc-100 text-zinc-600" },
  skipped: { label: "Let it pass", dark: "bg-white/5 text-zinc-400", light: "bg-zinc-50 text-zinc-500" },
  send_failed: { label: "Send failed", dark: "bg-rose-500/15 text-rose-300", light: "bg-rose-50 text-rose-700" },
  error: { label: "Error", dark: "bg-rose-500/15 text-rose-300", light: "bg-rose-50 text-rose-700" },
};

function whenLabel(at: number) {
  const d = new Date(at);
  const today = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return today ? time : `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

function ActivityLog({ isDark, events }: { isDark: boolean; events: Doc<"heartbeatEvents">[] | undefined }) {
  if (events === undefined) return <EmptyState isDark={isDark}>Loading activity…</EmptyState>;
  if (!events.length)
    return (
      <EmptyState isDark={isDark}>
        Nothing yet. Every time the heartbeat wakes the model, or lets an event end pass, it shows up here.
      </EmptyState>
    );
  return (
    <div className={panelCardClass(isDark, "divide-y divide-zinc-500/15")}>
      {events.map((e) => {
        const o = OUTCOME[e.outcome];
        const trigger = e.trigger === "event_ended"
          ? `After ${e.eventTitle ?? "an event"}`
          : e.trigger === "heartbeat"
            ? "Hourly check"
            : e.eventTitle
              ? `After ${e.eventTitle}`
              : "Check";
        const meta = [
          e.freeMinutes !== undefined ? `${e.freeMinutes} min free` : "",
          e.model ?? "",
          e.inputTokens !== undefined ? `${e.inputTokens.toLocaleString()} in / ${e.outputTokens ?? 0} out` : "",
          e.durationMs !== undefined ? `${(e.durationMs / 1000).toFixed(1)}s` : "",
        ].filter(Boolean).join(" · ");
        return (
          <div key={e._id} className="flex gap-3 px-4 py-3">
            <div className={`w-24 shrink-0 pt-0.5 text-xs mono ${mutedTextClass(isDark)}`}>{whenLabel(e.at)}</div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${isDark ? o.dark : o.light}`}>{o.label}</span>
                <span className="text-sm font-medium">{trigger}</span>
              </div>
              {e.message && e.outcome !== "error" && (
                <div className={subtlePanelClass(isDark, "mt-2 px-3 py-2 text-sm whitespace-pre-wrap")}>{e.message}</div>
              )}
              <div className={`mt-1 text-xs ${mutedTextClass(isDark)}`}>
                {e.outcome === "error" && e.message ? e.message : e.reason}
                {meta ? ` · ${meta}` : ""}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
