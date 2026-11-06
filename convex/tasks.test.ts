// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
const modules = import.meta.glob("./**/*.ts");
const conversationId = "telegram:fixture";

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.tasks.create, {
    taskId: "task_form",
    conversationId,
    title: "Fill out the reflection form",
    earliest: "2026-11-20",
    latest: "2026-11-27",
    anchor: { eventId: "evt1", calendarId: "primary", title: "DL 1234", date: "2026-11-20", relation: "after", days: 7 },
    importance: "high",
    cadenceDays: 1,
  });
  return t;
}

describe("tasks", () => {
  it("creates an open task once per id", async () => {
    const t = await setup();
    await t.mutation(api.tasks.create, { taskId: "task_form", conversationId, title: "dup", importance: "normal", cadenceDays: 2 });
    const open = await t.query(api.tasks.list, { conversationId });
    expect(open.map((x) => x.title)).toEqual(["Fill out the reflection form"]);
    expect(open[0].nudgeCount).toBe(0);
  });

  it("rejects bad windows and cadences", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.tasks.create, { taskId: "x", conversationId, title: "x", earliest: "2026-11-10", latest: "2026-11-01", importance: "normal", cadenceDays: 2 })).rejects.toThrow();
    await expect(t.mutation(api.tasks.create, { taskId: "y", conversationId, title: "y", importance: "normal", cadenceDays: 0 })).rejects.toThrow();
  });

  it("marks done, clears fields with null, and hides it from the open list", async () => {
    const t = await setup();
    const updated = await t.mutation(api.tasks.update, { taskId: "task_form", conversationId, waitingOn: null, clearWindow: true });
    expect(updated?.earliest).toBeUndefined();
    expect(updated?.anchor).toBeUndefined();
    await t.mutation(api.tasks.update, { taskId: "task_form", conversationId, status: "done" });
    expect(await t.query(api.tasks.list, { conversationId })).toHaveLength(0);
    expect(await t.query(api.tasks.list, { conversationId, status: "done" })).toHaveLength(1);
  });

  it("won't touch another conversation's task", async () => {
    const t = await setup();
    expect(await t.mutation(api.tasks.update, { taskId: "task_form", conversationId: "telegram:other", status: "done" })).toBeNull();
    expect(await t.mutation(api.tasks.logUpdate, { taskId: "task_form", conversationId: "telegram:other", note: "x" })).toBeNull();
  });

  it("logs updates, counts nudges, and follows a moved anchor", async () => {
    const t = await setup();
    await t.mutation(api.tasks.logUpdate, { taskId: "task_form", conversationId, note: "Found the link" });
    expect((await t.query(api.tasks.recentUpdates, { taskId: "task_form" })).map((u) => u.note)).toEqual(["Found the link"]);
    await t.mutation(api.tasks.markNudged, { conversationId, taskIds: ["task_form", "missing"] });
    await t.mutation(api.tasks.markNudged, { conversationId, taskIds: ["task_form"] });
    expect((await t.query(api.tasks.get, { taskId: "task_form" }))?.nudgeCount).toBe(2);
    const moved = await t.mutation(api.tasks.reanchor, { taskId: "task_form", date: "2026-11-22", earliest: "2026-11-22", latest: "2026-11-29" });
    expect(moved?.anchor?.date).toBe("2026-11-22");
    expect(moved?.latest).toBe("2026-11-29");
  });

  it("remembers which calendar events were already asked about", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.tasks.markEventsSeen, { conversationId, eventKeys: ["primary:a"] });
    await t.mutation(api.tasks.markEventsSeen, { conversationId, eventKeys: ["primary:a"] });
    expect(await t.query(api.tasks.seenEvents, { conversationId, eventKeys: ["primary:a", "primary:b"] })).toEqual(["primary:a"]);
    expect(await t.query(api.tasks.seenEvents, { conversationId: "telegram:other", eventKeys: ["primary:a"] })).toEqual([]);
  });
});
