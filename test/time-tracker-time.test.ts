import { describe, expect, it, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }));
import { localInstant, resolveLocalTime } from "../server/time-tracker/time.js";
import { buildExecutionPrompt } from "../server/execution-agent.js";
import { createTimeTrackerTools, executeTimeTrackerDraft } from "../server/time-tracker/tools.js";
import type { TimeTrackerClient } from "../server/time-tracker/client.js";
import { convex } from "../server/convex-client.js";

describe("TimeTracker local time handling", () => {
  it("recognizes the UTC entry in the screenshot as local noon, not a missing entry", () => {
    const local = localInstant("2026-11-01T17:00:00Z", "America/New_York");
    expect(local.iso).toBe("2026-11-01T12:00:00-05:00");
    expect(local.label).toContain("Sunday");
    expect(local.label).toContain("12:00 PM");
    expect(local.label).toContain("EST");
  });
  it("resolves the intended Saturday and Sunday sessions using their respective DST offsets", () => {
    expect(resolveLocalTime("2026-10-31", "17:00", "America/New_York")).toMatchObject({ utc: "2026-10-31T21:00:00.000Z", local: "2026-10-31T17:00:00-04:00" });
    expect(resolveLocalTime("2026-11-01", "15:00", "America/New_York")).toMatchObject({ utc: "2026-11-01T20:00:00.000Z", local: "2026-11-01T15:00:00-05:00" });
  });
  it("uses different offsets for midnight boundaries on a DST transition day", () => {
    expect(resolveLocalTime("2026-11-01", "00:00", "America/New_York").utc).toBe("2026-11-01T04:00:00.000Z");
    expect(resolveLocalTime("2026-11-02", "00:00", "America/New_York").utc).toBe("2026-11-02T05:00:00.000Z");
  });
  it("requires clarification for repeated clocks and rejects nonexistent times", () => {
    expect(() => resolveLocalTime("2026-11-01", "01:30", "America/New_York")).toThrow("occurs twice");
    expect(resolveLocalTime("2026-11-01", "01:30", "America/New_York", "earlier").utc).toBe("2026-11-01T05:30:00.000Z");
    expect(resolveLocalTime("2026-11-01", "01:30", "America/New_York", "later").utc).toBe("2026-11-01T06:30:00.000Z");
    expect(() => resolveLocalTime("2026-03-08", "02:30", "America/New_York")).toThrow("does not exist");
  });
  it("rejects invalid dates instead of normalizing them and supports fractional-hour zones", () => {
    expect(() => resolveLocalTime("2026-02-30", "12:00", "America/New_York")).toThrow("valid local date");
    expect(() => resolveLocalTime("2026-11-01", "25:00", "America/New_York")).toThrow("valid local date");
    expect(resolveLocalTime("2026-11-01", "12:00", "Asia/Kolkata").utc).toBe("2026-11-01T06:30:00.000Z");
  });
  it("supplies workers the local date and hides server fallback when timezone is unset", () => {
    const prompt = buildExecutionPrompt(["timetracker"], { timezone: "America/New_York", isExplicit: true, now: "Sunday, November 1, 2026 at 7:16 PM EST", isoDate: "2026-11-01" });
    expect(prompt).toContain('"currentLocalDate":"2026-11-01"');
    expect(prompt).toContain('"userTimezone":"America/New_York"');
    expect(prompt).toContain("never construct UTC timestamps");
    const unset = buildExecutionPrompt([], { timezone: "UTC", isExplicit: false, now: "server time", isoDate: "2026-11-02" });
    expect(unset).toContain('"userTimezone":null');
    expect(unset).not.toContain("server time");
    expect(unset).not.toContain("2026-11-02");
  });
  it("returns local labels with read results and shows local dates in draft previews", async () => {
    vi.clearAllMocks();
    const event = { id: "entry", projectId: "project", startTime: "2026-11-01T17:00:00Z", endTime: "2026-11-01T18:00:00Z", isActive: false, updatedAt: "v1" };
    const c = { list: vi.fn().mockImplementation(async (resource: string) => resource === "projects" ? [{ id: "project", name: "Research" }] : [event]), get: vi.fn().mockResolvedValue(event) } as unknown as TimeTrackerClient;
    const tools = createTimeTrackerTools("chat", () => c, async () => "America/New_York");
    const result = await tools.find(t => t.name === "list_events")!.handle({ fromDate: "2026-11-01", toDate: "2026-11-01" });
    expect(JSON.parse(result.text).entries[0]).toMatchObject({ project: "Research", start: "Sunday, Nov 1, 2026, 12:00 PM EST", minutes: 60 });
    vi.mocked(c.list).mockResolvedValue([]);
    const draftResult = await tools.find(t => t.name === "create_event")!.handle({ projectId: "project", start: { date: "2026-11-01", time: "12:00" }, end: { time: "13:00" } });
    const draft = JSON.parse(draftResult.text);
    expect(draft.summary).toContain("Sunday, Nov 1, 2026");
    expect(draft.summary).toContain("12:00 PM EST");
    expect(draft.preview.localTime.timezone).toBe("America/New_York");
    expect(Date.parse(JSON.parse((vi.mocked(convex.mutation).mock.calls[0][1] as any).payload).body.startTime)).toBe(Date.parse(event.startTime));
  });
  it("returns localized saved timestamps after executing an approved event draft", async () => {
    const event = { id: "entry", projectId: "project", startTime: "2026-11-01T20:00:00Z", endTime: "2026-11-01T21:00:00Z", isActive: false };
    const c = { create: vi.fn().mockResolvedValue({ data: event }) } as unknown as TimeTrackerClient;
    const result = await executeTimeTrackerDraft(JSON.stringify({ operation: "create_event", body: event }), c, async () => "America/New_York") as any;
    expect(result.data.localTime.start.iso).toBe("2026-11-01T15:00:00-05:00");
    expect(result.data.localTime.end.iso).toBe("2026-11-01T16:00:00-05:00");
    expect(result.data.localTime.start.label).toContain("Sunday");
  });
  it("does not calculate wall-clock times or stage events without a confirmed timezone", async () => {
    const tools = createTimeTrackerTools("chat", undefined, async () => null);
    const result = await tools.find(t => t.name === "resolve_local_time")!.handle({ date: "2026-11-01", time: "15:00" });
    expect(result.success).toBe(false);
    expect(result.text).toContain("for their timezone");
  });
});
