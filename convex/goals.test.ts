// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.goals.create, {
    goalId: "goal_test",
    conversationId: "telegram:fixture",
    title: "Exam review",
    deadline: "2026-11-12",
    unit: "lectures",
    total: 12,
    milestones: [
      { date: "2026-11-09", label: "100%", target: 12 },
      { date: "2026-11-07", label: "75%", target: 9 },
    ],
  });
  return t;
}

describe("goals", () => {
  it("stores milestones in date order and starts at zero progress", async () => {
    const t = await setup();
    const goal = await t.query(api.goals.get, { goalId: "goal_test" });
    expect(goal?.progress).toBe(0);
    expect(goal?.milestones.map((m) => m.date)).toEqual(["2026-11-07", "2026-11-09"]);
  });

  it("logs cumulative progress with a history entry", async () => {
    const t = await setup();
    await t.mutation(api.goals.logProgress, { goalId: "goal_test", conversationId: "telegram:fixture", progress: 4 });
    await t.mutation(api.goals.logProgress, { goalId: "goal_test", conversationId: "telegram:fixture", progress: 6, note: "slow day" });
    expect((await t.query(api.goals.get, { goalId: "goal_test" }))?.progress).toBe(6);
    const updates = await t.query(api.goals.recentUpdates, { goalId: "goal_test" });
    expect(updates.map((u) => u.progress)).toEqual([4, 6]);
  });

  it("refuses writes from another conversation", async () => {
    const t = await setup();
    expect(await t.mutation(api.goals.logProgress, { goalId: "goal_test", conversationId: "telegram:other", progress: 3 })).toBeNull();
    expect(await t.mutation(api.goals.update, { goalId: "goal_test", conversationId: "telegram:other", status: "dropped" })).toBeNull();
  });

  it("lists only goals with the requested status", async () => {
    const t = await setup();
    await t.mutation(api.goals.update, { goalId: "goal_test", conversationId: "telegram:fixture", status: "done" });
    expect(await t.query(api.goals.list, { conversationId: "telegram:fixture" })).toHaveLength(0);
    expect(await t.query(api.goals.list, { conversationId: "telegram:fixture", status: "done" })).toHaveLength(1);
  });

  it("lists every status across conversations for the dashboard", async () => {
    const t = await setup();
    await t.mutation(api.goals.create, {
      goalId: "goal_other", conversationId: "telegram:other", title: "Essay", deadline: "2026-11-20", milestones: [],
    });
    await t.mutation(api.goals.update, { goalId: "goal_test", conversationId: "telegram:fixture", status: "done" });
    const goals = await t.query(api.goals.listForDashboard, {});
    expect(goals.map((g) => [g.goalId, g.status])).toEqual([["goal_other", "active"], ["goal_test", "done"]]);
  });

  it("rejects dates that aren't local YYYY-MM-DD", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.goals.create, {
      goalId: "goal_bad", conversationId: "telegram:fixture", title: "x", deadline: "Nov 12", milestones: [],
    })).rejects.toThrow("YYYY-MM-DD");
  });
});
