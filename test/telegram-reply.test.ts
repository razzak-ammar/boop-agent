import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelegramUpdate, TelegramClient, withReplyContext, type TelegramUpdate } from "../server/telegram.js";

const config = { token: "123:test-token", ownerId: 42, offsetPath: "/unused" };
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
beforeEach(() => { vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => ok(true))); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const message = (extra: Partial<NonNullable<TelegramUpdate["message"]>>): NonNullable<TelegramUpdate["message"]> =>
  ({ from: { id: 42 }, chat: { id: 42, type: "private" }, text: "done", ...extra });

describe("Telegram swipe-replies", () => {
  it("leaves ordinary messages untouched", () => {
    expect(withReplyContext("done", message({}))).toBe("done");
  });

  it("includes the bot message being replied to and any highlighted quote", () => {
    const content = withReplyContext("done", message({
      reply_to_message: { from: { id: 7, is_bot: true }, date: 1762430400, text: "Did you fill out the reflection form yet?" },
      quote: { text: "reflection form" },
    }));
    expect(content).toContain("replying to your (Boop's) earlier message");
    expect(content).toContain("Did you fill out the reflection form yet?");
    expect(content).toContain("[Highlighted part]\nreflection form");
    expect(content.endsWith("[User's reply]\ndone")).toBe(true);
  });

  it("clips very long replied-to messages", () => {
    const content = withReplyContext("ok", message({ reply_to_message: { from: { id: 42 }, text: "x".repeat(5000) } }));
    expect(content).toContain("their own earlier message");
    expect(content.length).toBeLessThan(2000);
  });

  it("passes the reply context to the agent turn", async () => {
    const handle = vi.fn().mockResolvedValue("Marked it done.");
    await handleTelegramUpdate({ update_id: 1, message: message({ reply_to_message: { from: { id: 7, is_bot: true }, text: "Exam date known yet?" }, text: "Dec 3" }) },
      new TelegramClient(config), handle);
    expect(handle.mock.calls[0][0].content).toContain("Exam date known yet?");
    expect(handle.mock.calls[0][0].content).toContain("Dec 3");
  });
});
