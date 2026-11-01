import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelegramUpdate, sendTelegram, startTelegram, TelegramClient, telegramChunks, telegramConfig, type TelegramUpdate } from "../server/telegram.js";

const config = { token: "123:test-token", ownerId: 42, offsetPath: "/unused" };
const update: TelegramUpdate = { update_id: 10, message: { from: { id: 42 }, chat: { id: 42, type: "private" }, text: "Remember my project" } };
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));

beforeEach(() => { vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => ok(true))); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("private Telegram chat", () => {
  it("stays disabled without config and rejects partial or invalid config", () => {
    expect(telegramConfig({})).toBeNull();
    expect(() => telegramConfig({ TELEGRAM_BOT_TOKEN: config.token })).toThrow();
    expect(() => telegramConfig({ TELEGRAM_BOT_TOKEN: config.token, TELEGRAM_ALLOWED_USER_ID: "-42" })).toThrow();
    expect(telegramConfig({ TELEGRAM_BOT_TOKEN: config.token, TELEGRAM_ALLOWED_USER_ID: "42" })?.ownerId).toBe(42);
  });

  it("ignores strangers, groups, bots, and edited updates before invoking the agent", async () => {
    const client = new TelegramClient(config);
    const send = vi.spyOn(client, "send").mockResolvedValue();
    const typing = vi.spyOn(client, "startTyping");
    const handler = vi.fn();
    for (const message of [
      { ...update.message!, from: { id: 7 } },
      { ...update.message!, chat: { id: -1, type: "group" } },
      { ...update.message!, chat: { id: 7, type: "private" } },
      { ...update.message!, from: { id: 42, is_bot: true } },
      undefined,
    ]) await handleTelegramUpdate({ update_id: 1, message }, client, handler);
    expect(handler).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(typing).not.toHaveBeenCalled();
  });

  it("routes owner text to the stable conversation and delivers the final reply", async () => {
    const client = new TelegramClient(config);
    const send = vi.spyOn(client, "send").mockResolvedValue();
    const handler = vi.fn().mockResolvedValue("Remembered!");
    await handleTelegramUpdate(update, client, handler);
    expect(handler).toHaveBeenCalledWith({ conversationId: "telegram:42", content: "Remember my project" });
    expect(send).toHaveBeenCalledWith(42, "Remembered!");
  });

  it("handles /start and unsupported attachments without spending model usage", async () => {
    const client = new TelegramClient(config);
    const send = vi.spyOn(client, "send").mockResolvedValue();
    const handler = vi.fn();
    await handleTelegramUpdate({ ...update, message: { ...update.message!, text: "/start" } }, client, handler);
    await handleTelegramUpdate({ ...update, message: { ...update.message!, text: undefined } }, client, handler);
    expect(handler).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("returns a safe failure message rather than internal errors", async () => {
    const client = new TelegramClient(config);
    const send = vi.spyOn(client, "send").mockResolvedValue();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await handleTelegramUpdate(update, client, vi.fn().mockRejectedValue(new Error("private-secret")));
    expect(send.mock.calls[0][1]).toContain("check before retrying");
    expect(send.mock.calls[0][1]).not.toContain("private-secret");
  });

  it("splits long unformatted emoji replies losslessly", async () => {
    const text = "a".repeat(3999) + "🐶".repeat(3000) + "<tag>literal_punctuation";
    const chunks = telegramChunks(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((c) => c.length <= 4000)).toBe(true);
    const fetcher = vi.fn().mockImplementation(async () => ok({}));
    await new TelegramClient(config, fetcher).send(42, text);
    expect(fetcher).toHaveBeenCalledTimes(chunks.length);
    const bodies = fetcher.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(bodies.map((b) => b.text)).toEqual(chunks);
    expect(bodies.every((b) => b.parse_mode === undefined && b.chat_id === 42)).toBe(true);
  });

  it("refuses outbound messages to anyone except the configured owner", async () => {
    const fetcher = vi.fn();
    await expect(new TelegramClient(config, fetcher).send(7, "secret")).rejects.toThrow("owner");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", config.token);
    vi.stubEnv("TELEGRAM_ALLOWED_USER_ID", "42");
    await expect(sendTelegram("telegram:7", "secret")).rejects.toThrow("owner");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not leak the token on HTTP, parsing, or network failures", async () => {
    for (const fetcher of [
      vi.fn().mockRejectedValue(new Error(`URL /bot${config.token}/sendMessage`)),
      vi.fn().mockResolvedValue(new Response("bad gateway", { status: 502 })),
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 429, description: config.token }))),
    ]) {
      await expect(new TelegramClient(config, fetcher).send(42, "secret")).rejects.not.toThrow(config.token);
    }
  });

  it("refuses to take over a bot with an existing webhook", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ url: "https://existing.example/webhook" }));
    vi.stubGlobal("fetch", fetcher);
    await expect(startTelegram(vi.fn(), config)).rejects.toThrow("existing webhook");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("checkpoints processed updates and resumes without replaying them (delivery failure: %s)", async (deliveryFails) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), "boop-telegram-test-"));
    const localConfig = { ...config, offsetPath: join(dir, "offset.json") };
    const handler = vi.fn().mockResolvedValue("Got it");
    const offsets: number[] = [];
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith("getWebhookInfo")) return ok({ url: "" });
      if (url.endsWith("sendChatAction")) return ok(true);
      if (url.endsWith("sendMessage")) {
        if (deliveryFails) throw new Error("network failure");
        return ok({});
      }
      const body = JSON.parse(options.body as string);
      offsets.push(body.offset);
      if (body.offset === 0) return ok([update, update]);
      return new Promise<Response>((_, reject) => options.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    vi.stubGlobal("fetch", fetcher);
    let runner: Awaited<ReturnType<typeof startTelegram>>;
    try {
      runner = await startTelegram(handler, localConfig);
      await vi.waitFor(() => expect(offsets).toEqual([0, 11]));
      runner!.stop(); await runner!.done;
      expect(handler).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(localConfig.offsetPath, "utf8"))).toEqual({ offset: 11 });
      runner = await startTelegram(handler, localConfig);
      await vi.waitFor(() => expect(offsets).toEqual([0, 11, 11]));
      runner!.stop(); await runner!.done;
      expect(handler).toHaveBeenCalledTimes(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});


describe("Telegram typing indicator", () => {
  it("starts immediately, refreshes during a slow turn, and stops before the reply", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(async () => ok(true));
    const client = new TelegramClient(config, fetcher);
    const send = vi.spyOn(client, "send").mockImplementation(async () => {
      const count = fetcher.mock.calls.length;
      await vi.advanceTimersByTimeAsync(8000);
      expect(fetcher).toHaveBeenCalledTimes(count);
    });
    let complete!: (reply: string) => void;
    const pending = handleTelegramUpdate(update, client, () => new Promise(resolve => { complete = resolve; }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({chat_id:42, action:"typing"});
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    complete("Done");
    await pending;
    expect(send).toHaveBeenCalledWith(42,"Done");
  });
  it("ignores typing failures and still delivers the reply", async () => {
    const client = new TelegramClient(config, vi.fn().mockRejectedValue(new Error("token in URL")));
    const send = vi.spyOn(client,"send").mockResolvedValue();
    await handleTelegramUpdate(update,client,async()=>"Done");
    expect(send).toHaveBeenCalledWith(42,"Done");
  });
  it("cleans up on handler and reply-delivery failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(console,"error").mockImplementation(()=>{});
    const fetcher=vi.fn().mockImplementation(async () => ok(true));
    const client=new TelegramClient(config,fetcher);
    vi.spyOn(client,"send").mockRejectedValue(new Error("delivery failed"));
    await expect(handleTelegramUpdate(update,client,async()=>{throw new Error("agent failed");})).rejects.toThrow("delivery failed");
    const count=fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12000);
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it("aborts pending pulses and refuses other recipients", () => {
    const fetcher=vi.fn().mockImplementation((_url,options)=>new Promise((_resolve,reject)=>{
      options.signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});
    }));
    const client=new TelegramClient(config,fetcher);
    expect(()=>client.startTyping(7)).toThrow("owner");
    expect(fetcher).not.toHaveBeenCalled();
    const stop=client.startTyping(42);
    const signal=fetcher.mock.calls[0][1].signal;
    stop();stop();
    expect(signal.aborted).toBe(true);
  });
});
