import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { convex } from "./convex-client.js";
import type { CapturedTelegramMessage, TelegramClient, TelegramEntity, TelegramUpdate } from "./telegram.js";
import { parseRememberCommand } from "./memory/note-intake.js";
import { ALLOWED_IMAGE_MIME, MAX_IMAGE_BYTES } from "./images/mime.js";

export function sharedUrls(text: string, entities: TelegramEntity[] = []): string[] {
  const candidates = [
    ...entities.flatMap(entity => entity.type === "text_link" && entity.url ? [entity.url]
      : entity.type === "url" ? [text.slice(entity.offset, entity.offset + entity.length)] : []),
    ...(text.match(/https?:\/\/[^\s<>]+/gi) ?? []).map(url => url.replace(/[.,;!]+$/, "")),
  ];
  return [...new Set(candidates.flatMap(raw => {
    try {
      const url = new URL(raw);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? [url.href] : [];
    } catch { return []; }
  }))];
}

export function imageType(bytes: Buffer): string {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("Invalid image size.");
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  throw new Error("Unsupported image format.");
}

export async function captureTelegramMessage(update: TelegramUpdate, client: TelegramClient): Promise<CapturedTelegramMessage> {
  const message = update.message!;
  if (message.chat.type !== "private" || message.chat.id !== client.config.ownerId || message.from?.id !== client.config.ownerId || message.from.is_bot) {
    throw new Error("Capture is restricted to the configured owner.");
  }
  const conversationId = `telegram:${client.config.ownerId}`;
  const text = message.text ?? message.caption ?? "";
  const urls = sharedUrls(text, message.text ? message.entities : message.caption_entities);
  const explicitNote = parseRememberCommand(text);
  const savedText = explicitNote ?? text;
  const destination = explicitNote !== null ? "Notes" : "Inbox";
  const bareShare = !text.trim() || (urls.length > 0 && text.trim().split(/\s+/).every(part => /^https?:\/\//i.test(part)));
  const captureOnly = bareShare || explicitNote !== null;
  const sourceKey = `telegram:${client.config.ownerId}:${update.update_id}`;
  const shouldSave = !/\b(?:do not|don['’]?t)\s+(?:save|store|remember|keep|archive)\b|\bwithout\s+(?:saving|storing|archiving)\b/i.test(text);
  if (!shouldSave && !message.photo?.length && !message.document) return { content: text };
  // Check before downloading/uploading so polling replays don't leak blobs.
  const existing = shouldSave ? await convex.query(api.savedItems.getBySourceKey, { sourceKey }) : null;
  let images: Array<{ storageId: string; mediaType: string }> = [];
  let savedId = existing?._id;
  if (existing) {
    images = existing.imageStorageIds.map((storageId, index) => ({ storageId, mediaType: existing.imageMediaTypes[index] ?? "image/jpeg" }));
  } else {
    const photo = message.photo?.length ? message.photo.reduce((best, image) => image.width * image.height > best.width * best.height ? image : best) : undefined;
    const attachment = photo ?? message.document;
    if (attachment) {
      if (!photo && !ALLOWED_IMAGE_MIME.has(message.document?.mime_type ?? "")) throw new Error("Unsupported image format.");
      const bytes = await client.downloadImage(attachment.file_id, attachment.file_size);
      const mediaType = imageType(bytes);
      const uploadUrl = await convex.mutation(api.messages.generateUploadUrl, {});
      const response = await fetch(uploadUrl, {
        method: "POST", headers: { "Content-Type": mediaType },
        body: new Uint8Array(bytes), signal: AbortSignal.timeout(40_000),
      });
      if (!response.ok) throw new Error("Image storage failed.");
      const uploaded = await response.json() as { storageId?: string };
      if (!uploaded.storageId) throw new Error("Image storage failed.");
      images = [{ storageId: uploaded.storageId, mediaType }];
    }
    if (!shouldSave) return { content: text, images };
    savedId = await convex.mutation(api.savedItems.save, {
      collection: destination, title: savedText.trim().slice(0, 100) || "Shared screenshot/photo",
      content: savedText, kind: images.length ? "image" : "link", urls,
      imageStorageIds: images.map(image => image.storageId as Id<"_storage">),
      sourceConversationId: conversationId, sourceKey,
    });
    if (captureOnly) {
      try {
        await convex.mutation(api.messages.send, {
          conversationId, role: "user", content: text || "[Shared screenshot/photo]",
          imageStorageIds: images.map(image => image.storageId as Id<"_storage">),
          turnId: sourceKey,
        });
      } catch {
        console.warn("[telegram] shared item saved; conversation history write failed");
      }
    }
  }
  const captureNotice = captureOnly ? `Saved to ${destination}.` : "Saved your shared item.";
  return {
    captureOnly,
    content: `${text}\n\n[Already saved in ${destination} as item ${savedId}. Update/move this item to organize it; do not duplicate it. Shared links: ${urls.join(", ")}]`,
    images, captureNotice,
  };
}
