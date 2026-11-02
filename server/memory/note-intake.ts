import type { Id } from "../../convex/_generated/dataModel.js";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";

/** Explicit command only: normal paragraphs keep the full conversational path. */
export function parseRememberCommand(content: string): string | null {
  const match = /^\/remember(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(content.trim());
  return match ? (match[1]?.trim() ?? "") : null;
}

/** Preserve the whole note before acknowledgment or background extraction. */
export async function storeRawNote(conversationId: string, turnId: string, text: string, imageStorageIds: string[] = []): Promise<void> {
  const savedItemId = await convex.mutation(api.savedItems.save, {
    collection: "Notes", title: text.slice(0, 100), content: text,
    kind: imageStorageIds.length ? "image" : "note",
    imageStorageIds: imageStorageIds as Id<"_storage">[],
    sourceConversationId: conversationId, sourceKey: `remember:${conversationId}:${turnId}`,
  });
  // A failed diagnostic event must not turn a saved note into a reported failure.
  try {
    await convex.mutation(api.memoryEvents.emit, {
      eventType: "saved.written", conversationId,
      data: JSON.stringify({ savedItemId, sourceTurn: turnId }),
    });
  } catch {
    console.warn("[saved] note saved; diagnostic event failed");
  }
}
