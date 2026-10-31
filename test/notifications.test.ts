import { describe, expect, it, vi } from "vitest";
vi.mock("../server/sendblue.js", () => ({ sendImessage: vi.fn() }));
vi.mock("../server/telegram.js", () => ({ sendTelegram: vi.fn() }));
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
});
