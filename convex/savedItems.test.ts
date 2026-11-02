// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { PaginationResult } from "convex/server";
const modules = import.meta.glob("./**/*.ts");
const note = { collection: "Movies", title: "Arrival", content: "Sam recommended this after our conversation.", kind: "note" as const, sourceConversationId: "telegram:fixture", status: "want-to-watch", recommendedBy: "Sam" };

describe("saved notes and named collections", () => {
  it("stores exact text outside decaying memory and normalizes collection names", async () => {
    const t = convexTest(schema, modules);
    const content = "First paragraph.\n\nSecond paragraph with exact details.";
    const id = await t.mutation(api.savedItems.save, { ...note, collection: "  MOVIES  ", content });
    await t.mutation(api.savedItems.save, { ...note, title: "Past Lives", collection: "movies" });
    const collections = await t.query(api.savedItems.listCollections, { paginationOpts: { cursor: null, numItems: 10 } });
    expect(collections.page).toHaveLength(1);
    expect((await t.query(api.savedItems.get, { id }))?.content).toBe(content);
    expect(await t.run(ctx => ctx.db.query("memoryRecords").take(10))).toEqual([]);
  });

  it("returns every collection member across pages with status filtering", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 13; i++) await t.mutation(api.savedItems.save, { ...note, title: `Movie ${i}` });
    await t.mutation(api.savedItems.save, { ...note, title: "Watched", status: "watched" });
    await t.mutation(api.savedItems.save, { ...note, collection: "Books", title: "Another collection" });
    let cursor: string | null = null;
    const titles: string[] = [];
    for (;;) {
      const page: PaginationResult<Doc<"savedItems">> = await t.query(api.savedItems.list, { collection: "movies", status: "want-to-watch", paginationOpts: { cursor, numItems: 4 } });
      titles.push(...page.page.map(item => item.title));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(new Set(titles).size).toBe(13);
    expect(titles).not.toContain("Watched");
  });

  it("supports full-text retrieval, updates, moves, and deletion without losing source text", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(api.savedItems.save, note);
    await t.mutation(api.savedItems.update, { id, status: "watched", collection: "Favorites" });
    const results = await t.query(api.savedItems.list, { search: "Sam", collection: "Favorites", status: "watched", paginationOpts: { cursor: null, numItems: 10 } });
    expect(results.page.map(item => item._id)).toEqual([id]);
    expect(results.page[0].content).toBe(note.content);
    expect(results.page[0].sourceConversationId).toBe(note.sourceConversationId);
    await t.mutation(api.savedItems.remove, { id });
    expect(await t.query(api.savedItems.get, { id })).toBeNull();
  });

  it("deduplicates transport replays and retains saved image references", async () => {
    const t = convexTest(schema, modules);
    const storageId = await t.run(ctx => ctx.storage.store(new Blob(["image"], { type: "image/png" })));
    const args = { ...note, kind: "image" as const, imageStorageIds: [storageId], sourceKey: "telegram:fixture:123" };
    const ids = await Promise.all([t.mutation(api.savedItems.save, args), t.mutation(api.savedItems.save, args)]);
    expect(ids[0]).toBe(ids[1]);
    const refs = await t.query(api.savedItems.findImageRefsPage, { storageIds: [storageId] });
    expect(refs.foundStorageIds).toEqual([storageId]);
    await t.mutation(api.savedItems.remove, { id: ids[0] });
    expect((await t.query(api.savedItems.findImageRefsPage, { storageIds: [storageId] })).foundStorageIds).toEqual([]);
  });

  it("rejects blank collections, unsafe links and empty statuses", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.savedItems.save, { ...note, collection: " " })).rejects.toThrow("Collection name");
    await expect(t.mutation(api.savedItems.save, { ...note, urls: ["javascript:alert(1)"] })).rejects.toThrow("HTTP(S)");
    await expect(t.mutation(api.savedItems.save, { ...note, status: " " })).rejects.toThrow("Status");
    const empty = await t.query(api.savedItems.list, { collection: "Missing", paginationOpts: { cursor: null, numItems: 10 } });
    expect(empty.isDone).toBe(true);
    expect(empty.page).toEqual([]);
  });
});
