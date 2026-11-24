// A photo sent on its own is saved without a model turn, so the user's next
// message ("add this to my calendar") arrives with no image. Carry those
// unanswered images into that next turn so the model can see them.

export const CARRY_WINDOW_MS = 30 * 60 * 1000;
export const MAX_CARRIED_IMAGES = 4;

interface HistoryMessage {
  role: string;
  createdAt: number;
  imageStorageIds?: string[] | null;
}

/** Images from the user messages right before the current one, newest last.
 * Stops at the first assistant/system message (the image was already
 * answered) or at a message older than the window. `history` is oldest first
 * and ends with the current message. */
export function carriedImageStorageIds(history: HistoryMessage[], now = Date.now()): string[] {
  const current = history.at(-1);
  if (!current || current.role !== "user" || (current.imageStorageIds?.length ?? 0) > 0) return [];
  const carried: string[] = [];
  for (let i = history.length - 2; i >= 0; i--) {
    const message = history[i];
    if (message.role !== "user" || now - message.createdAt > CARRY_WINDOW_MS) break;
    carried.unshift(...(message.imageStorageIds ?? []));
  }
  return [...new Set(carried)].slice(-MAX_CARRIED_IMAGES);
}
