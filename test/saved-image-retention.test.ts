import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
vi.mock("../server/convex-client.js", () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }));
import { convex } from "../server/convex-client.js";
import { runImageCleanup } from "../server/images/clean.js";
beforeEach(() => vi.clearAllMocks());
describe("saved screenshot retention", () => {
  it("keeps a screenshot anchored only by a saved item after chat retention expires", async () => {
    vi.mocked(convex.query).mockImplementation(async reference => {
      switch (getFunctionName(reference)) {
        case "messages:expiredWithImages": return { rows: [{ _id: "message", imageStorageIds: ["screenshot"] }], isDone: true, continueCursor: "" };
        case "memoryRecords:findImageRefsPage": return { foundStorageIds: [], isDone: true, continueCursor: "" };
        case "savedItems:findImageRefsPage": return { foundStorageIds: ["screenshot"], isDone: true, continueCursor: "" };
        default: throw new Error("Unexpected query");
      }
    });
    expect(await runImageCleanup()).toEqual({ kept: 1, deleted: 0 });
    expect(convex.mutation).not.toHaveBeenCalled();
  });
  it("keeps unresolved screenshots if a saved-item reference scan fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(convex.query).mockImplementation(async reference => {
      if (getFunctionName(reference) === "messages:expiredWithImages") return { rows: [{ _id: "message", imageStorageIds: ["screenshot"] }], isDone: true, continueCursor: "" };
      if (getFunctionName(reference) === "savedItems:findImageRefsPage") throw new Error("Unavailable");
      return { foundStorageIds: [], isDone: true, continueCursor: "" };
    });
    expect(await runImageCleanup()).toEqual({ kept: 1, deleted: 0 });
    expect(convex.mutation).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
