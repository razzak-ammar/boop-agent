import { describe, expect, it, vi } from "vitest";
vi.mock("../server/sendblue.js", () => ({ sendImessage: vi.fn() }));
vi.mock("../server/telegram.js", () => ({ sendTelegram: vi.fn() }));
vi.mock("../server/broadcast.js", () => ({ broadcast: vi.fn() }));
import { broadcast } from "../server/broadcast.js";
import { sendImessage } from "../server/sendblue.js";
import { sendTelegram } from "../server/telegram.js";
import { sendConversationNotification } from "../server/notifications.js";

describe("conversation notification delivery", () => {
  it("routes reminders and acknowledgements to their original channel", async () => {
    await sendConversationNotification("telegram:42", "Reminder");
    expect(sendTelegram).toHaveBeenCalledWith("telegram:42", "Reminder");
    await sendConversationNotification("sms:+15555555555", "Legacy reminder");
    expect(sendImessage).toHaveBeenCalledWith("+15555555555", "Legacy reminder");
    vi.clearAllMocks();
    await sendConversationNotification("debug", "Dashboard reminder");
    expect(sendTelegram).not.toHaveBeenCalled();
    expect(sendImessage).not.toHaveBeenCalled();
  });

  it("tells an open iOS app to refetch, including a custom app conversation id", async () => {
    vi.useFakeTimers();
    vi.stubEnv("BOOP_APP_CONVERSATION_ID", "phone");
    try {
      await sendConversationNotification("phone", "Check-in");
      await sendConversationNotification("app:other", "Check-in");
      await sendConversationNotification("debug", "Check-in");
      vi.advanceTimersByTime(1000);
      expect(vi.mocked(broadcast).mock.calls).toEqual([
        ["app_message", { conversationId: "phone" }],
        ["app_message", { conversationId: "app:other" }],
      ]);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });
});
