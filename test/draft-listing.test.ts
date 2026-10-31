import { describe, it, expect, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({convex:{query:vi.fn(),mutation:vi.fn()}}));
import { convex } from "../server/convex-client.js";
import { createDraftDecisionTools } from "../server/draft-tools.js";
describe("pending draft IDs", () => {
  it("returns separate named fields for the executable ID and action kind", async () => {
    vi.mocked(convex.query).mockResolvedValueOnce([{draftId:"draft_fixture",kind:"gmail.new",summary:"Lunch"}]);
    const tool = createDraftDecisionTools("fixture").find(t => t.name === "list_drafts")!;
    const result = await tool.handle({});
    expect(JSON.parse(result.text)).toEqual({drafts:[{draftId:"draft_fixture",kind:"gmail.new",summary:"Lunch"}]});
  });
  it("does not execute an unknown or kind-shaped ID", async () => {
    vi.mocked(convex.query).mockResolvedValueOnce(null);
    const tool = createDraftDecisionTools("fixture").find(t => t.name === "send_draft")!;
    const result = await tool.handle({draftId:"gmail.new",integrations:["gmail"]});
    expect(result.success).toBe(false);
    expect(convex.mutation).not.toHaveBeenCalled();
  });
});
