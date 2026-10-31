import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { embed } from "../embeddings.js";
import { DEFAULT_DECAY } from "./types.js";

/** Explicit command only: normal paragraphs keep the full conversational path. */
export function parseRememberCommand(content: string): string | null {
  const match = /^\/remember(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(content.trim());
  return match ? (match[1]?.trim() ?? "") : null;
}

/** Preserve the whole note before acknowledgment or background extraction. */
export async function storeRawNote(conversationId: string, turnId: string, text: string): Promise<void> {
  const memoryId = `note_${turnId}`;
  const content = `User note: ${text}`;
  const embedding = (await embed(content)) ?? undefined;
  await convex.mutation(api.memoryRecords.upsert, {
    memoryId, content, tier: "long", segment: "knowledge", importance: 0.65,
    decayRate: DEFAULT_DECAY.long, sourceTurn: turnId, embedding,
    metadata: JSON.stringify({ kind: "raw_note", conversationId }),
  });
  await convex.mutation(api.memoryEvents.emit, {
    eventType: "memory.written", conversationId, memoryId,
    data: JSON.stringify({ kind: "raw_note", sourceTurn: turnId }),
  });
}
