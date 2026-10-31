import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
  };
}

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

// Plain text avoids Telegram Markdown parsing failures. Count UTF-16 units
// conservatively, preserving surrogate pairs at chunk boundaries.
export function telegramChunks(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (chunk.length + char.length > 4000) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
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

  async send(chatId: number, text: string): Promise<void> {
    if (chatId !== this.config.ownerId) throw new Error("Telegram recipient is not the configured owner.");
    for (const chunk of telegramChunks(text)) {
      await this.call("sendMessage", { chat_id: chatId, text: chunk });
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
  (message: { conversationId: string; content: string }): Promise<string>;
}

export async function handleTelegramUpdate(
  update: TelegramUpdate,
  client: TelegramClient,
  handleMessage: TelegramHandler,
): Promise<void> {
  const message = update.message;
  const ownerId = client.config.ownerId;
  if (!message || message.chat.type !== "private" || message.chat.id !== ownerId || message.from?.id !== ownerId || message.from.is_bot) return;
  if (!message.text) {
    await client.send(ownerId, "This alpha supports text messages only. Please type what you want me to remember or do.");
    return;
  }
  if (/^\/start(?:@\w+)?(?:\s|$)/.test(message.text)) {
    await client.send(ownerId, "Boop is connected. Send me notes, questions, or recurring reminders. Tell me your timezone before scheduling.");
    return;
  }
  let reply: string;
  try {
    reply = await handleMessage({ conversationId: `telegram:${ownerId}`, content: message.text });
  } catch {
    // A failed turn may already have performed a tool action. Don't replay it
    // automatically, and don't reveal internal errors to the chat.
    await client.send(ownerId, "I couldn't finish that request. Some actions may have completed; check before retrying.");
    console.error("[telegram] agent turn failed");
    return;
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
  console.log("[telegram] private text chat polling enabled");
  return { stop: () => controller.abort(), done };
}
