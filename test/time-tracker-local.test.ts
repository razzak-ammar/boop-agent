import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }));
import { convex } from "../server/convex-client.js";
import type { TimeTrackerClient } from "../server/time-tracker/client.js";
import { createTimeTrackerTools, loadPendingTimeTrackerNote, reviseTimeTrackerDraft } from "../server/time-tracker/tools.js";

const NY = async () => "America/New_York";
const project = { id: "lab", name: "Lab", updatedAt: "v1" };
type Row = Record<string, unknown> & { id: string };
function fakeClient(events: Row[] = [], current?: Row) {
  return {
    get: vi.fn().mockImplementation(async (resource: string) => resource === "projects" ? project : current),
    list: vi.fn().mockImplementation(async (resource: string) => resource === "projects" ? [project] : events),
    create: vi.fn().mockImplementation(async (_resource: string, body: Row) => ({ data: body })),
    request: vi.fn().mockImplementation(async (_method: string, _path: string, body: Row) => ({ data: { ...current, ...body } })),
  };
}
const tools = (client: ReturnType<typeof fakeClient>) => createTimeTrackerTools("chat", () => client as unknown as TimeTrackerClient, NY, "direct");
const tool = (client: ReturnType<typeof fakeClient>, name: string) => tools(client).find(t => t.name === name)!;
const created = (client: ReturnType<typeof fakeClient>) => client.create.mock.calls[0]?.[1] as Row | undefined;

beforeEach(() => vi.clearAllMocks());

describe("local wall-time writes", () => {
  it("converts local times on the server, rolling an overnight end to the next day", async () => {
    const client = fakeClient();
    const result = await tool(client, "create_event").handle({ projectId: "lab", start: { date: "2026-11-01", time: "22:30" }, end: { time: "00:20" } });
    expect(JSON.parse(result.text).status).toBe("saved");
    // 10:30 PM EST is 03:30Z the next day; the logged bug stored 08:30Z.
    expect(created(client)).toMatchObject({ startTime: "2026-11-02T03:30:00.000Z", endTime: "2026-11-02T05:20:00.000Z" });
  });
  it("uses the offset in effect on each date across the DST change", async () => {
    const client = fakeClient();
    await tool(client, "create_event").handle({ projectId: "lab", start: { date: "2026-10-30", time: "10:15" }, end: { time: "11:15" } });
    expect(created(client)).toMatchObject({ startTime: "2026-10-30T14:15:00.000Z", endTime: "2026-10-30T15:15:00.000Z" });
  });
  it("asks about repeated DST wall times instead of guessing", async () => {
    const client = fakeClient();
    const result = await tool(client, "create_event").handle({ projectId: "lab", start: { date: "2026-11-01", time: "01:30" }, end: { time: "02:30" } });
    expect(result.success).toBe(false);
    expect(result.text).toContain("occurs twice");
    expect(client.create).not.toHaveBeenCalled();
  });
  it("rejects an explicit end date before the start", async () => {
    const client = fakeClient();
    const result = await tool(client, "create_event").handle({ projectId: "lab", start: { date: "2026-11-02", time: "10:00" }, end: { date: "2026-11-01", time: "11:00" } });
    expect(result.success).toBe(false);
    expect(client.create).not.toHaveBeenCalled();
  });
  it("moves an existing entry using local times and keeps unchanged fields", async () => {
    const current = { id: "entry", projectId: "lab", startTime: "2026-11-01T15:30:00.000Z", endTime: "2026-11-01T16:59:00.000Z", isActive: false, updatedAt: "v1" };
    const client = fakeClient([], current);
    const result = await tool(client, "update_event").handle({ id: "entry", changes: { start: { date: "2026-11-01", time: "22:30" }, end: { time: "00:20" } } });
    expect(result.success).toBe(true);
    expect(client.request).toHaveBeenCalledWith("PATCH", "events/entry", { startTime: "2026-11-02T03:30:00.000Z", endTime: "2026-11-02T05:20:00.000Z" });
  });
  it("revises a pending draft's time from local values", async () => {
    const body = { id: "stable", projectId: "lab", startTime: "2026-10-30T14:15:00.000Z", endTime: "2026-10-30T15:15:00.000Z", description: "Meeting" };
    const revised = await reviseTimeTrackerDraft(JSON.stringify({ operation: "create_event", body }), { end: { time: "11:45" } }, undefined, NY);
    expect(JSON.parse(revised.payload).body).toEqual({ ...body, endTime: "2026-10-30T15:45:00.000Z" });
  });
  it("starts and stops timers now when no time is given", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T15:00:00Z"));
    try {
      const client = fakeClient([]);
      await tool(client, "start_timer").handle({ projectId: "lab" });
      expect(created(client)).toMatchObject({ startTime: "2026-11-02T15:00:00.000Z", isActive: true, endTime: null });
      const running = { id: "timer", projectId: "lab", startTime: "2026-11-02T14:00:00.000Z", endTime: null, isActive: true, updatedAt: "v1" };
      const stopper = fakeClient([], running);
      await tool(stopper, "stop_timer").handle({ id: "timer" });
      expect(stopper.request).toHaveBeenCalledWith("PATCH", "events/timer", { isActive: false, endTime: "2026-11-02T15:00:00.000Z" });
    } finally { vi.useRealTimers(); }
  });
});

describe("duplicate and overlap protection", () => {
  const existing = { id: "first", projectId: "lab", startTime: "2026-10-30T14:15:00.000Z", endTime: "2026-10-30T15:15:00.000Z", isActive: false };
  it("returns the existing entry instead of logging the same work twice", async () => {
    const client = fakeClient([existing]);
    const result = await tool(client, "create_event").handle({ projectId: "lab", start: { date: "2026-10-30", time: "10:15" }, end: { time: "11:15" }, description: "Repeat" });
    expect(JSON.parse(result.text)).toMatchObject({ status: "already_saved", entry: { id: "first", project: "Lab" } });
    expect(client.create).not.toHaveBeenCalled();
    expect(convex.mutation).not.toHaveBeenCalled();
  });
  it("saves an overlapping entry but reports the overlap", async () => {
    const client = fakeClient([existing]);
    const result = JSON.parse((await tool(client, "create_event").handle({ projectId: "lab", start: { date: "2026-10-30", time: "11:00" }, end: { time: "12:00" } })).text);
    expect(result.status).toBe("saved");
    expect(result.overlaps.map((row: Row) => row.id)).toEqual(["first"]);
    expect(client.create).toHaveBeenCalledTimes(1);
  });
});

describe("bounded listing and totals", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-02T17:00:00Z")); });
  afterEach(() => vi.useRealTimers());
  it("defaults to the last 14 local days and returns compact rows", async () => {
    const client = fakeClient([{ id: "e", projectId: "lab", startTime: "2026-11-01T15:30:00.000Z", endTime: "2026-11-01T16:00:00.000Z", description: "x".repeat(500), isActive: false, updatedAt: "v1" }]);
    const result = JSON.parse((await tool(client, "list_events").handle({})).text);
    expect(result.range).toEqual({ fromDate: "2026-10-20", toDate: "2026-11-02", defaulted: true });
    expect(client.list).toHaveBeenCalledWith("events", { from: "2026-10-20T04:00:00.000Z", to: "2026-11-03T05:00:00.000Z" });
    expect(result.entries[0]).toEqual({ id: "e", project: "Lab", projectId: "lab", start: "Sunday, Nov 1, 2026, 10:30 AM EST", end: "Sunday, Nov 1, 2026, 11:00 AM EST", minutes: 30, description: `${"x".repeat(200)}…` });
  });
  it("keeps only the newest rows of a very long range", async () => {
    const events = Array.from({ length: 250 }, (_, i) => ({ id: `e${i}`, projectId: "lab", startTime: new Date(Date.parse("2026-10-01T12:00:00Z") + i * 3600_000).toISOString(), endTime: new Date(Date.parse("2026-10-01T12:30:00Z") + i * 3600_000).toISOString(), isActive: false }));
    const result = JSON.parse((await tool(fakeClient(events), "list_events").handle({ fromDate: "2026-10-01" })).text);
    expect(result).toMatchObject({ count: 250, truncated: true });
    expect(result.entries).toHaveLength(200);
    expect(result.entries.at(-1).id).toBe("e249");
  });
  it("splits overnight entries by local day and counts a running timer to now", async () => {
    const client = fakeClient([
      { id: "overnight", projectId: "lab", startTime: "2026-11-02T03:30:00.000Z", endTime: "2026-11-02T05:20:00.000Z", isActive: false },
      { id: "running", projectId: "lab", startTime: "2026-11-02T16:00:00.000Z", endTime: null, isActive: true },
      { id: "before", projectId: "lab", startTime: "2026-10-30T14:00:00.000Z", endTime: "2026-10-30T15:00:00.000Z", isActive: false },
    ]);
    const result = JSON.parse((await tool(client, "summarize_time").handle({ fromDate: "2026-11-01", toDate: "2026-11-02" })).text);
    expect(result.byDay).toEqual([{ date: "2026-11-01", minutes: 90 }, { date: "2026-11-02", minutes: 80 }]);
    expect(result.byProject).toEqual([{ project: "Lab", projectId: "lab", minutes: 170, entries: 2 }]);
    expect(result).toMatchObject({ totalMinutes: 170, note: expect.stringContaining("running timer") });
  });
});

describe("unsaved operations", () => {
  it("surfaces recent pending TimeTracker receipts to the dispatcher", async () => {
    vi.mocked(convex.query).mockResolvedValueOnce([
      { draftId: "draft_a", kind: "timetracker.action", summary: "Log TimeTracker entry: Friday 10:15 AM", createdAt: Date.now() - 3600_000 },
      { draftId: "draft_old", kind: "timetracker.action", summary: "Old", createdAt: Date.now() - 8 * 86_400_000 },
      { draftId: "draft_mail", kind: "gmail.new", summary: "Email", createdAt: Date.now() },
    ] as never);
    const note = await loadPendingTimeTrackerNote("chat");
    expect(note).toContain("draft_a");
    expect(note).toContain("NOT saved");
    expect(note).not.toContain("draft_old");
    expect(note).not.toContain("draft_mail");
    vi.mocked(convex.query).mockResolvedValueOnce([] as never);
    expect(await loadPendingTimeTrackerNote("chat")).toBe("");
  });
});
