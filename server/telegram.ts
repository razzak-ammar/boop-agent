import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { formattedTelegramChunks } from "./telegram-format.js";
import { MAX_IMAGE_BYTES } from "./images/mime.js";
import { readCappedImageBytes } from "./images/read-bytes.js";
export { telegramChunks } from "./telegram-format.js";

export interface TelegramConfig {
  token: string;
  ownerId: number;
  offsetPath: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    from?: { id: number; is_bot?: boolean };
    chat: { id: number; type: string };
    text?: string;
    caption?: string;
    entities?: TelegramEntity[];
    caption_entities?: TelegramEntity[];
    photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
    document?: { file_id: string; mime_type?: string; file_size?: number; file_name?: string };
  };
}

export interface TelegramEntity { type: string; offset: number; length: number; url?: string }
export interface CapturedTelegramMessage {
  content: string;
  images?: Array<{ storageId: string; mediaType: string }>;
  captureNotice?: string;
  captureOnly?: boolean;
}
export type TelegramCapture = (update: TelegramUpdate, client: TelegramClient) => Promise<CapturedTelegramMessage>;

export function telegramConfig(env = process.env): TelegramConfig | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const owner = env.TELEGRAM_ALLOWED_USER_ID?.trim();
  if (!token && !owner) return null;
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token) || !owner || !/^[1-9]\d*$/.test(owner) || !Number.isSafeInteger(Number(owner))) {
    throw new Error("Telegram requires TELEGRAM_BOT_TOKEN and a positive numeric TELEGRAM_ALLOWED_USER_ID.");
  }
  return {
    token,
    ownerId: Number(owner),
    offsetPath: join(resolve(env.TELEGRAM_STATE_DIR || "data/telegram"), `${token.split(":")[0]}.json`),
  };
}

export class TelegramClient {
  constructor(readonly config: TelegramConfig, private readonly fetcher: typeof fetch = fetch) {}

  async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    // Never expose fetch errors or Telegram response bodies: the URL contains
    // the bot token and the response may contain private message contents.
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.config.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000),
      });
    } catch {
      throw new Error(`Telegram ${method} request failed (network or timeout).`);
    }
    const data = await response.json().catch(() => null) as { ok?: boolean; result: T; error_code?: number } | null;
    if (!response.ok || !data?.ok) {
      throw new Error(`Telegram ${method} failed (status ${data?.error_code ?? response.status}).`);
    }
    return data.result;
  }

  startTyping(chatId: number): () => void {
    if (chatId !== this.config.ownerId) throw new Error("Telegram recipient is not the configured owner.");
    const controller = new AbortController();
    let inFlight = false;
    const pulse = async () => {
      if (controller.signal.aborted || inFlight) return;
      inFlight = true;
      try {
        await this.call("sendChatAction", { chat_id: chatId, action: "typing" },
          AbortSignal.any([controller.signal, AbortSignal.timeout(3500)]));
      } catch {
        // Cosmetic and best-effort: never delay or fail a real reply, or log
        // network errors whose URLs might expose the bot token.
      } finally {
        inFlight = false;
      }
    };
    void pulse();
    // Telegram expires chat actions after at most five seconds.
    const timer = setInterval(() => { void pulse(); }, 4000);
    timer.unref();
    return () => { clearInterval(timer); controller.abort(); };
  }

  async send(chatId: number, text: string): Promise<void> {
    if (chatId !== this.config.ownerId) throw new Error("Telegram recipient is not the configured owner.");
    for (const chunk of formattedTelegramChunks(text)) {
      await this.call("sendMessage", { chat_id: chatId, text: chunk.text, ...(chunk.entities.length ? { entities: chunk.entities } : {}) });
    }
  }

  async downloadImage(fileId: string, declaredSize?: number): Promise<Buffer> {
    if (declaredSize !== undefined && declaredSize > MAX_IMAGE_BYTES) throw new Error("Image exceeds 10 MB.");
    const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!file.file_path || !/^[\w/.-]+$/.test(file.file_path) || file.file_path.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error("Telegram returned an invalid image path.");
    }
    if (file.file_size !== undefined && file.file_size > MAX_IMAGE_BYTES) throw new Error("Image exceeds 10 MB.");
    try {
      const response = await this.fetcher(`https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`, {
        signal: AbortSignal.timeout(40_000), redirect: "error",
      });
      if (!response.ok) throw new Error("Image download failed.");
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_IMAGE_BYTES) {
        await response.body?.cancel();
        throw new Error("Image exceeds 10 MB.");
      }
      return await readCappedImageBytes(response);
    } catch {
      // Both the URL and network errors may contain the bot token.
      throw new Error("Telegram image download failed or exceeded 10 MB.");
    }
  }
}

export async function sendTelegram(conversationId: string, text: string): Promise<void> {
  const config = telegramConfig();
  if (!config) throw new Error("Telegram is not configured.");
  if (conversationId !== `telegram:${config.ownerId}`) throw new Error("Telegram conversation is not the configured owner.");
  await new TelegramClient(config).send(config.ownerId, text);
}

export interface TelegramHandler {
  (message: { conversationId: string; content: string; images?: Array<{ storageId: string; mediaType: string }> }): Promise<string>;
}

export async function handleTelegramUpdate(
  update: TelegramUpdate,
  client: TelegramClient,
  handleMessage: TelegramHandler,
  capture?: TelegramCapture,
): Promise<void> {
  const message = update.message;
  const ownerId = client.config.ownerId;
  if (!message || message.chat.type !== "private" || message.chat.id !== ownerId || message.from?.id !== ownerId || message.from.is_bot) return;
  const hasImage = Boolean(message.photo?.length || message.document?.mime_type?.startsWith("image/"));
  if (!message.text && !hasImage) {
    await client.send(ownerId, "Send text, a shared link, or a screenshot/photo (up to 10 MB). Voice notes are not supported.");
    return;
  }
  if (message.text && /^\/start(?:@\w+)?(?:\s|$)/.test(message.text)) {
    await client.send(ownerId, "Boop is connected. Use /remember for saved notes. Shared links and screenshots go to Inbox; ask me to organize them into collections. Tell me your timezone before scheduling.");
    return;
  }
  const stopTyping = client.startTyping(ownerId);
  let reply = "";
  let captureNotice = "";
  try {
    let prepared: CapturedTelegramMessage = { content: message.text ?? message.caption ?? "" };
    let captureFailed = false;
    const hasLink = /https?:\/\//i.test(prepared.content) || [...(message.entities ?? []), ...(message.caption_entities ?? [])].some(entity => entity.type === "text_link");
    if (hasImage || hasLink) {
      try {
        const captureMessage = capture ?? (await import("./telegram-capture.js")).captureTelegramMessage;
        prepared = await captureMessage(update, client);
        captureNotice = prepared.captureNotice ?? "";
      } catch {
        reply = "I couldn't save that attachment or link. Please resend it; images must be JPEG, PNG, WebP, or GIF and at most 10 MB.";
        captureFailed = true;
      }
    }
    // Bare shares only need durable capture. A caption can still ask a task.
    if (!captureFailed) {
      if (prepared.captureOnly) {
        reply = captureNotice;
      } else {
        reply = await handleMessage({ conversationId: `telegram:${ownerId}`, content: prepared.content,
          ...(prepared.images?.length ? { images: prepared.images } : {}) });
        if (captureNotice) reply = `${captureNotice}\n\n${reply}`;
      }
    }
  } catch {
    // A failed turn may already have performed a tool action. Don't replay it
    // automatically, and don't reveal internal errors to the chat.
    reply = `${captureNotice ? captureNotice + "\n\n" : ""}I couldn't finish that request. Some actions may have completed; check before retrying.`;
    console.error("[telegram] agent turn failed");
  } finally {
    // Abort any outstanding pulse before delivering the final/error message.
    stopTyping();
  }
  if (reply.trim()) await client.send(ownerId, reply);
}

export async function startTelegram(
  handleMessage: TelegramHandler,
  config = telegramConfig(),
): Promise<{ stop: () => void; done: Promise<void> } | null> {
  if (!config) return null;
  const client = new TelegramClient(config);
  const webhook = await client.call<{ url: string }>("getWebhookInfo", {});
  if (webhook.url) throw new Error("Telegram bot has an existing webhook. Use a separate bot or remove the webhook before enabling polling.");

  let offset = 0;
  try {
    const stored = JSON.parse(await readFile(config.offsetPath, "utf8"));
    if (!Number.isSafeInteger(stored.offset) || stored.offset < 0) throw new Error("invalid offset");
    offset = stored.offset;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read Telegram polling checkpoint. Check TELEGRAM_STATE_DIR.");
  }
  const controller = new AbortController();
  const done = (async () => {
    while (!controller.signal.aborted) {
      try {
        const updates = await client.call<TelegramUpdate[]>("getUpdates", {
          offset, timeout: 25, limit: 20, allowed_updates: ["message"],
        }, controller.signal);
        for (const update of updates) {
          if (controller.signal.aborted) break;
          if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
          try {
            await handleTelegramUpdate(update, client, handleMessage);
          } catch {
            // Delivery failures must not rerun a possibly completed agent task.
            console.error("[telegram] reply delivery failed; turn will not be replayed");
          }
          const nextOffset = update.update_id + 1;
          offset = nextOffset;
          await mkdir(resolve(config.offsetPath, ".."), { recursive: true });
          await writeFile(`${config.offsetPath}.tmp`, JSON.stringify({ offset: nextOffset }), { mode: 0o600 });
          await rename(`${config.offsetPath}.tmp`, config.offsetPath);
        }
      } catch {
        if (controller.signal.aborted) break;
        console.error("[telegram] polling or checkpoint failed; retrying in 5 seconds");
        await delay(5000, undefined, { signal: controller.signal }).catch(() => undefined);
      }
    }
  })();
  console.log("[telegram] private chat and image capture polling enabled");
  return { stop: () => controller.abort(), done };
}
