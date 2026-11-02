import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }));
import { convex } from "../server/convex-client.js";
import { captureTelegramMessage, imageType, sharedUrls } from "../server/telegram-capture.js";
import { handleTelegramUpdate, TelegramClient, type TelegramUpdate } from "../server/telegram.js";
const config = { token: "123:test-token", ownerId: 42, offsetPath: "/unused" };
const update: TelegramUpdate = { update_id: 17, message: { from: { id: 42 }, chat: { id: 42, type: "private" }, text: "https://example.com/movie" } };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(convex.query).mockResolvedValue(null);
  vi.mocked(convex.mutation).mockResolvedValue("saved_test");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Telegram shared capture", () => {
  it("preserves ordinary URLs and hidden link targets, filtering unsafe schemes", () => {
    expect(sharedUrls("🐶 Movie", [{ type: "text_link", offset: 3, length: 5, url: "https://example.com/movie" }])).toEqual(["https://example.com/movie"]);
    expect(sharedUrls("Read https://example.com/movie.")).toEqual(["https://example.com/movie"]);
    expect(sharedUrls("click", [{ type: "text_link", offset: 0, length: 5, url: "javascript:alert(1)" }])).toEqual([]);
  });
  it("captures a bare link exactly once without calling a model", async () => {
    const client = new TelegramClient(config);
    const send = vi.spyOn(client, "send").mockResolvedValue();
    vi.spyOn(client, "startTyping").mockReturnValue(() => {});
    const handler = vi.fn();
    await handleTelegramUpdate(update, client, handler, captureTelegramMessage);
    expect(handler).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(42, "Saved to Inbox.");
    expect(vi.mocked(convex.mutation).mock.calls[0][1]).toMatchObject({ collection: "Inbox", content: update.message!.text, urls: [update.message!.text], sourceKey: "telegram:42:17" });
  });
  it("uploads a screenshot, retains caption and passes image into the conversation", async () => {
    const client = new TelegramClient(config);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    vi.spyOn(client, "downloadImage").mockResolvedValue(png);
    vi.spyOn(client, "send").mockResolvedValue();
    vi.spyOn(client, "startTyping").mockReturnValue(() => {});
    vi.mocked(convex.mutation).mockResolvedValueOnce("https://storage.example/upload").mockResolvedValueOnce("saved_image").mockResolvedValueOnce("message");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ storageId: "storage_image" }))));
    const handler = vi.fn().mockResolvedValue("Moved to Movies.");
    await handleTelegramUpdate({ ...update, message: { ...update.message!, text: undefined, caption: "Add this to Movies", photo: [{ file_id: "small", width: 10, height: 10 }, { file_id: "large", width: 100, height: 100 }] } }, client, handler, captureTelegramMessage);
    expect(client.downloadImage).toHaveBeenCalledWith("large", undefined);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("saved_image"), images: [{ storageId: "storage_image", mediaType: "image/png" }] }));
    expect(vi.mocked(convex.mutation).mock.calls[1][1]).toMatchObject({ kind: "image", imageStorageIds: ["storage_image"], content: "Add this to Movies" });
  });
  it("doesn't download or resave a previously captured update", async () => {
    vi.mocked(convex.query).mockResolvedValue({ _id: "existing", imageStorageIds: [] });
    const client = new TelegramClient(config);
    const download = vi.spyOn(client, "downloadImage");
    await captureTelegramMessage(update, client);
    expect(download).not.toHaveBeenCalled();
    expect(convex.mutation).not.toHaveBeenCalled();
  });
  it("honors a request not to save a one-off shared link", async () => {
    const client = new TelegramClient(config);
    const prepared = await captureTelegramMessage({ ...update, message: { ...update.message!, text: "Summarize https://example.com/movie but don't save this" } }, client);
    expect(prepared.captureNotice).toBeUndefined();
    expect(prepared.content).toContain("Summarize");
    expect(convex.query).not.toHaveBeenCalled();
    expect(convex.mutation).not.toHaveBeenCalled();
  });
  it("doesn't run caption actions when saving fails", async () => {
    const client = new TelegramClient(config);
    const stopTyping = vi.fn();
    const send = vi.spyOn(client, "send").mockImplementation(async () => { expect(stopTyping).toHaveBeenCalledOnce(); });
    vi.spyOn(client, "startTyping").mockReturnValue(stopTyping);
    const handler = vi.fn();
    await handleTelegramUpdate(update, client, handler, async () => { throw new Error(config.token); });
    expect(handler).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1]).toContain("couldn't save");
    expect(send.mock.calls[0][1]).not.toContain(config.token);
  });
  it("rejects forged image types and caps streamed downloads without leaking tokens", async () => {
    expect(() => imageType(Buffer.from("<svg>not an image</svg>"))).toThrow("format");
    const client = new TelegramClient(config, vi.fn().mockResolvedValue(new Response("large", { headers: { "content-length": String(11 * 1024 * 1024) } })));
    vi.spyOn(client, "call").mockResolvedValue({ file_path: "photos/file.jpg" });
    await expect(client.downloadImage("id")).rejects.toThrow("10 MB");
    await expect(client.downloadImage("id", 11 * 1024 * 1024)).rejects.toThrow("10 MB");
  });
});
