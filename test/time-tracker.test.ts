import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../server/convex-client.js", () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }));
import { convex } from "../server/convex-client.js";
import * as clientModule from "../server/time-tracker/client.js";
import { TimeTrackerClient } from "../server/time-tracker/client.js";
import { createTimeTrackerTools, executeTimeTrackerDraft } from "../server/time-tracker/tools.js";
import { createDraftDecisionTools } from "../server/draft-tools.js";

let dir: string;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const auth = () => json({ id_token: "secret-id-token", refresh_token: "rotated-refresh-token", expires_in: "3600" });
function client(fetcher: ReturnType<typeof vi.fn>) {
  return new TimeTrackerClient({ url: "https://tracker.example/agentApi", apiKey: "public-key", refreshToken: "secret-refresh-token", sessionFile: join(dir, "session.json"), fetch: fetcher as typeof fetch });
}
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boop-tt-test-")); vi.clearAllMocks(); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
describe("TimeTracker HTTP client", () => {
  it("coalesces token refresh, caches the token and persists rotations privately", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(auth()).mockImplementation(async () => json({ data: [], nextCursor: null }));
    const c = client(fetcher);
    await Promise.all([c.list("projects"), c.list("events")]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("securetoken"))).toHaveLength(1);
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe("Bearer secret-id-token");
    expect(JSON.parse(await readFile(join(dir, "session.json"), "utf8")).refreshToken).toBe("rotated-refresh-token");
    expect((await stat(join(dir, "session.json"))).mode & 0o777).toBe(0o600);
    const next = vi.fn().mockResolvedValueOnce(auth()).mockResolvedValueOnce(json({ data: [], nextCursor: null }));
    await client(next).list("projects");
    expect(next.mock.calls[0][1].body.get("refresh_token")).toBe("rotated-refresh-token");
  });
  it("refreshes once after 401 and stops if the retry is also unauthorized", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(auth()).mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(auth()).mockResolvedValueOnce(json({}, 401));
    await expect(client(fetcher).list("projects")).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("does not expose provider credential errors", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ error: "secret-refresh-token" }, 400));
    await expect(client(fetcher).list("projects")).rejects.toThrow("authentication_failed");
  });
  it("continues empty filtered pages with unchanged filters", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(auth()).mockResolvedValueOnce(json({ data: [], nextCursor: "first" })).mockResolvedValueOnce(json({ data: [{ id: "result" }], nextCursor: null }));
    expect(await client(fetcher).list("events", { projectId: "project", isActive: false })).toEqual([{ id: "result" }]);
    const url = fetcher.mock.calls[2][0] as URL;
    expect(url.searchParams.get("cursor")).toBe("first");
    expect(url.searchParams.get("projectId")).toBe("project");
    expect(url.searchParams.get("isActive")).toBe("false");
  });
  it("recovers a timed-out create using its original ID and normalized instants", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(auth()).mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(json({ data: { id: "stable", startTime: "2026-11-01T19:00:00Z", isActive: true } }));
    const result = await client(fetcher).create("events", { id: "stable", startTime: "2026-11-01T14:00:00-05:00", isActive: true });
    expect(result).toMatchObject({ recovered: true });
    expect(String(fetcher.mock.calls[2][0])).toContain("events/stable");
  });
  it("does not treat a 409 as successful when the payload differs", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(auth()).mockResolvedValueOnce(json({}, 409)).mockResolvedValueOnce(json({ data: { id: "stable", name: "different" } }));
    await expect(client(fetcher).create("projects", { id: "stable", name: "intended" })).rejects.toThrow("could not be verified");
  });
});

describe("TimeTracker tools and drafts", () => {
  const record = { id: "entry", projectId: "project", startTime: "2026-11-01T19:00:00Z", endTime: null, isActive: true, updatedAt: "version-1" };
  function fake() {
    return { get: vi.fn().mockResolvedValue(record), list: vi.fn().mockResolvedValue([]), request: vi.fn().mockResolvedValue({ data: record }), create: vi.fn().mockResolvedValue({ data: record }) };
  }
  it("stages stopping a timer with both fields and performs no HTTP write", async () => {
    const c = fake();
    const tool = createTimeTrackerTools("chat", () => c as unknown as TimeTrackerClient, async () => "America/New_York").find(t => t.name === "stop_timer")!;
    const result = await tool.handle({ id: "entry", endTime: "2026-11-01T21:00:00Z" });
    expect(result.success).toBe(true);
    const draft = vi.mocked(convex.mutation).mock.calls[0][1] as any;
    expect(JSON.parse(draft.payload)).toMatchObject({ operation: "update_event", body: { isActive: false, endTime: "2026-11-01T21:00:00Z" }, expectedUpdatedAt: "version-1" });
    expect(c.request).not.toHaveBeenCalled();
    expect(c.create).not.toHaveBeenCalled();
  });
  it("applies only requested fields after approval and refuses stale drafts", async () => {
    const c = fake();
    const payload = JSON.stringify({ operation: "update_event", id: "entry", body: { description: "TA office hours" }, expectedUpdatedAt: "version-1" });
    await executeTimeTrackerDraft(payload, c as unknown as TimeTrackerClient);
    expect(c.request).toHaveBeenCalledWith("PATCH", "events/entry", { description: "TA office hours" });
    c.get.mockResolvedValueOnce({ ...record, updatedAt: "version-2" });
    await expect(executeTimeTrackerDraft(payload, c as unknown as TimeTrackerClient)).rejects.toThrow("changed since");
    expect(c.request).toHaveBeenCalledTimes(1);
  });
  it("persists a create ID in the pending draft and blocks a second active timer", async () => {
    const c = fake();
    const tool = createTimeTrackerTools("chat", () => c as unknown as TimeTrackerClient, async () => "America/New_York").find(t => t.name === "start_timer")!;
    expect((await tool.handle({ projectId: "project", startTime: record.startTime })).success).toBe(true);
    const draft = vi.mocked(convex.mutation).mock.calls[0][1] as any;
    expect(JSON.parse(draft.payload).body.id).toMatch(/^[a-f0-9-]{36}$/);
    c.list.mockResolvedValueOnce([record] as never[]);
    expect((await tool.handle({ projectId: "project", startTime: record.startTime })).success).toBe(false);
    expect(convex.mutation).toHaveBeenCalledTimes(1);
  });
  it("requires a conversation for write staging", async () => {
    const tool = createTimeTrackerTools(undefined).find(t => t.name === "create_project")!;
    expect((await tool.handle({ name: "Research", color: "#123456" })).success).toBe(false);
    expect(convex.mutation).not.toHaveBeenCalled();
  });
  it("executes approved drafts directly and marks sent only after success", async () => {
    const c = fake();
    vi.spyOn(clientModule, "getTimeTrackerClient").mockReturnValue(c as unknown as TimeTrackerClient);
    vi.mocked(convex.query).mockResolvedValueOnce({ status: "pending", kind: "timetracker.action", conversationId: "chat", payload: JSON.stringify({ operation: "create_project", body: { id: "stable", name: "TA", color: "#123456" } }) } as never);
    const tool = createDraftDecisionTools("chat").find(t => t.name === "send_draft")!;
    const result = await tool.handle({ draftId: "draft", integrations: ["timetracker"] });
    expect(result.success).toBe(true);
    expect(c.create).toHaveBeenCalledWith("projects", { id: "stable", name: "TA", color: "#123456" });
    expect(convex.mutation).toHaveBeenCalledWith(expect.anything(), { draftId: "draft", status: "sent" });
    expect(c.create.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(convex.mutation).mock.invocationCallOrder[0]);
  });
  it("rejects approval from another conversation", async () => {
    vi.mocked(convex.query).mockResolvedValueOnce({ status: "pending", kind: "timetracker.action", conversationId: "other", payload: "{}" } as never);
    const tool = createDraftDecisionTools("chat").find(t => t.name === "send_draft")!;
    expect((await tool.handle({ draftId: "draft", integrations: ["timetracker"] })).success).toBe(false);
    expect(convex.mutation).not.toHaveBeenCalled();
  });
  it("leaves a failed approved draft pending and never spawns another worker", async () => {
    vi.mocked(convex.query).mockResolvedValueOnce({ status: "pending", kind: "timetracker.action", conversationId: "chat", payload: "{}" } as never);
    const tool = createDraftDecisionTools("chat").find(t => t.name === "send_draft")!;
    const result = await tool.handle({ draftId: "draft", integrations: ["timetracker"] });
    expect(result.success).toBe(false);
    expect(convex.mutation).not.toHaveBeenCalled();
  });
});

describe("direct TimeTracker actions", () => {
  it("saves a requested entry immediately with a durable receipt, without a confirmation turn", async () => {
    const record = { id: "project", updatedAt: "v1" };
    const c = { get: vi.fn().mockResolvedValue(record), create: vi.fn().mockImplementation(async (_r, body) => ({ data: body })) } as unknown as TimeTrackerClient;
    const tool = createTimeTrackerTools("chat", () => c, async () => "America/New_York", "direct").find(t => t.name === "create_event")!;
    const result = await tool.handle({ projectId: "project", startTime: "2026-11-01T15:00:00-05:00", endTime: "2026-11-01T16:00:00-05:00", description: "Research" });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ status: "saved", result: { data: { description: "Research" } } });
    expect(c.create).toHaveBeenCalledTimes(1);
    expect(convex.mutation).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: "sent" }));
    const receipt = (vi.mocked(convex.mutation).mock.calls[0][1] as any);
    expect(JSON.parse(receipt.payload).body.id).toBe(vi.mocked(c.create).mock.calls[0][1].id);
  });
  it("still honors an explicit draft-only request without saving", async () => {
    const c = { get: vi.fn().mockResolvedValue({ id: "project", updatedAt: "v1" }), create: vi.fn() } as unknown as TimeTrackerClient;
    const tool = createTimeTrackerTools("chat", () => c, async () => "America/New_York", "direct").find(t => t.name === "create_event")!;
    const result = await tool.handle({ projectId: "project", startTime: "2026-11-01T15:00:00-05:00", endTime: "2026-11-01T16:00:00-05:00", draftOnly: true });
    expect(JSON.parse(result.text).status).toBe("pending");
    expect(c.create).not.toHaveBeenCalled();
  });
  it("keeps the original operation pending on failure rather than claiming it saved", async () => {
    const c = { create: vi.fn().mockRejectedValue(new Error("offline")) } as unknown as TimeTrackerClient;
    const tool = createTimeTrackerTools("chat", () => c, async () => "America/New_York", "direct").find(t => t.name === "create_project")!;
    const result = await tool.handle({ name: "Research", color: "#123456" });
    expect(result.success).toBe(false);
    expect(result.text).toContain("remains pending");
    expect(convex.mutation).toHaveBeenCalledTimes(1);
  });
});
