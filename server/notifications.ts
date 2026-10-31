import { sendImessage } from "./sendblue.js";
import { sendTelegram } from "./telegram.js";

export async function sendConversationNotification(conversationId: string, text: string): Promise<void> {
  if (conversationId.startsWith("telegram:")) {
    await sendTelegram(conversationId, text);
  } else if (conversationId.startsWith("sms:")) {
    await sendImessage(conversationId.slice(4), text);
  }
  // Dashboard conversations receive persisted messages through Convex.
}
