import { appConversationId } from "./app-auth.js";
import { broadcast } from "./broadcast.js";
import { sendImessage } from "./sendblue.js";
import { sendTelegram } from "./telegram.js";

export async function sendConversationNotification(conversationId: string, text: string): Promise<void> {
  if (conversationId.startsWith("telegram:")) {
    await sendTelegram(conversationId, text);
  } else if (conversationId.startsWith("sms:")) {
    await sendImessage(conversationId.slice(4), text);
  } else if (conversationId.startsWith("app:") || conversationId === appConversationId()) {
    // Callers persist the message right after this; give Convex a moment
    // before the open iOS app refetches.
    setTimeout(() => broadcast("app_message", { conversationId }), 750);
  }
  // Dashboard conversations receive persisted messages through Convex.
}
