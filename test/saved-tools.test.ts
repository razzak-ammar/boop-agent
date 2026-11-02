import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }));
import { convex } from "../server/convex-client.js";
import { createSavedTools } from "../server/saved/tools.js";
const tool = (name: string, images: string[] = []) => createSavedTools("conversation", images).find(tool => tool.name === name)!;
beforeEach(() => vi.clearAllMocks());
describe("saved library runtime tools", () => {
  it("passes pagination through and marks partial results explicitly", async () => {
    vi.mocked(convex.query).mockResolvedValue({ page: [{ title: "Arrival" }], isDone: false, continueCursor: "next-page" });
    const result = await tool("list_saved_items").handle({ collection: "Movies", cursor: "page-one", limit: 25 });
    expect(vi.mocked(convex.query).mock.calls[0][1]).toEqual({ collection: "Movies", paginationOpts: { cursor: "page-one", numItems: 25 } });
    expect(JSON.parse(result.text)).toMatchObject({ isDone: false, nextCursor: "next-page" });
  });
  it("attaches only actual current images and preserves the full note", async () => {
    vi.mocked(convex.mutation).mockResolvedValue("saved-id");
    const content = "First paragraph.\n\nSecond paragraph.";
    await tool("save_item", ["current-image"]).handle({ title: "Receipt", content, attachCurrentImages: true, kind: "image" });
    expect(vi.mocked(convex.mutation).mock.calls[0][1]).toMatchObject({ collection: "Notes", content, imageStorageIds: ["current-image"], sourceConversationId: "conversation" });
    await expect(tool("save_item").handle({ title: "Missing image", content: "", attachCurrentImages: true })).rejects.toThrow("No current images");
  });
  it("rejects unbounded page sizes before querying", async () => {
    await expect(tool("list_saved_items").handle({ limit: 1000 })).rejects.toThrow();
    expect(convex.query).not.toHaveBeenCalled();
  });
});
