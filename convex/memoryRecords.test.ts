// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
const modules = import.meta.glob("./**/*.ts");
const base = { content: "User prefers tea", tier: "permanent" as const, segment: "preference" as const, importance: .7, decayRate: 0 };

describe("personal memory persistence", () => {
  it("atomically replaces an old preference and excludes it from recall/profile", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.memoryRecords.upsert, { ...base, memoryId: "old" });
    await t.mutation(api.memoryRecords.upsert, { ...base, memoryId: "unrelated", content: "User lives in Boston", segment: "identity" });
    await t.mutation(api.memoryRecords.upsert, { ...base, memoryId: "new", content: "User prefers coffee", segment: "correction", supersedes: ["old"], requireActiveSupersedes: true });
    const profile = await t.query(api.memoryRecords.profile, {});
    expect(profile.map(row => row.memoryId).sort()).toEqual(["new", "unrelated"]);
    expect(await t.query(api.memoryRecords.search, { query: "tea" })).toEqual([]);
    expect((await t.query(api.memoryRecords.list, { lifecycle: "archived" })).map(row => row.memoryId)).toEqual(["old"]);
  });
  it("rejects stale correction attempts without archiving the current fact", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.memoryRecords.upsert, { ...base, memoryId: "old" });
    await t.mutation(api.memoryRecords.upsert, { ...base, memoryId: "new", content: "User prefers coffee", supersedes: ["old"], requireActiveSupersedes: true });
    await expect(t.mutation(api.memoryRecords.upsert, { ...base, memoryId: "stale", supersedes: ["old", "new"], requireActiveSupersedes: true })).rejects.toThrow("stale");
    expect((await t.query(api.memoryRecords.profile, {})).map(row => row.memoryId)).toEqual(["new"]);
  });
  it("deduplicates foreground/background writes without downgrading retention", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(api.memoryRecords.upsert, { ...base, memoryId: "first", deduplicate: true });
    const second = await t.mutation(api.memoryRecords.upsert, { ...base, memoryId: "second", content: "  user PREFERS  tea  ", tier: "long", deduplicate: true });
    expect(second).toBe(first);
    const rows = await t.query(api.memoryRecords.list, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].tier).toBe("permanent");
  });
  it("prioritizes preference segments despite context volume and honors forgetting", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.memoryRecords.upsert, { ...base, memoryId: "pref" });
    await t.run(async ctx => {
      for (let i = 0; i < 110; i++) await ctx.db.insert("memoryRecords", { ...base, memoryId: `context${i}`, segment: "context", lifecycle: "active", accessCount: 0, lastAccessedAt: 0, createdAt: 0 });
    });
    expect((await t.query(api.memoryRecords.profile, {})).map(row => row.memoryId)).toEqual(["pref"]);
    await t.mutation(api.memoryRecords.setLifecycle, { memoryId: "pref", lifecycle: "archived" });
    expect(await t.query(api.memoryRecords.profile, {})).toEqual([]);
  });
  it("keeps important older preferences in the profile despite a burst of newer ones", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.memoryRecords.upsert, { ...base, memoryId: "emoji", content: "Never use emoji in replies", importance: .8 });
    for (let i = 0; i < 45; i++) await t.mutation(api.memoryRecords.upsert, { ...base, memoryId: `minor${i}`, content: `Minor preference ${i}`, importance: .6 });
    const profile = (await t.query(api.memoryRecords.profile, {})).map(row => row.memoryId);
    expect(profile[0]).toBe("emoji");
    expect(profile).toHaveLength(40);
  });
});

describe("memory reconciliation", () => {
  const seed = async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.memoryRecords.upsert, { ...base, memoryId: "old", content: "No Meet links unless asked", tier: "long", importance: .7, decayRate: .02 });
    await t.mutation(api.memoryRecords.upsert, { ...base, memoryId: "new", content: "Don't add Google Meet links unless requested", importance: .9 });
    return t;
  };
  const active = async (t: Awaited<ReturnType<typeof seed>>) =>
    (await t.query(api.memoryRecords.list, {})).map(row => row.memoryId).sort();

  it("drops a paraphrased duplicate and carries its stronger retention to the survivor", async () => {
    const t = await seed();
    expect(await t.mutation(api.memoryRecords.reconcile, { memoryId: "new", candidateIds: ["old"], drop: true, replaces: [] })).toBe("dropped");
    const rows = await t.query(api.memoryRecords.list, {});
    expect(rows.map(row => row.memoryId)).toEqual(["old"]);
    expect(rows[0]).toMatchObject({ importance: .9, tier: "permanent", decayRate: 0 });
  });
  it("never lets two concurrent duplicates drop each other", async () => {
    const t = await seed();
    await t.mutation(api.memoryRecords.reconcile, { memoryId: "new", candidateIds: ["old"], drop: true, replaces: [] });
    expect(await t.mutation(api.memoryRecords.reconcile, { memoryId: "old", candidateIds: ["new"], drop: true, replaces: [] })).toBe("kept");
    expect(await active(t)).toEqual(["old"]);
  });
  it("replaces an updated fact, merging rewritten content", async () => {
    const t = await seed();
    expect(await t.mutation(api.memoryRecords.reconcile, { memoryId: "new", candidateIds: ["old"], drop: false, replaces: ["old"], content: "Add Meet links only when asked" })).toBe("replaced");
    const [row] = await t.query(api.memoryRecords.list, {});
    expect(row).toMatchObject({ memoryId: "new", content: "Add Meet links only when asked", supersedes: ["old"] });
  });
  it("ignores replacement targets outside the candidates or already archived", async () => {
    const t = await seed();
    await t.mutation(api.memoryRecords.setLifecycle, { memoryId: "old", lifecycle: "archived" });
    expect(await t.mutation(api.memoryRecords.reconcile, { memoryId: "new", candidateIds: ["old"], drop: false, replaces: ["old"], content: "rewrite" })).toBe("kept");
    expect((await t.query(api.memoryRecords.list, {}))[0].content).toBe("Don't add Google Meet links unless requested");
  });
});
