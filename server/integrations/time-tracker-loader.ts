import { timeTrackerConfigured } from "../time-tracker/client.js";
import { createTimeTrackerMcp, createTimeTrackerTools } from "../time-tracker/tools.js";
import { registerIntegration } from "./registry.js";

export function registerTimeTrackerIntegration(): void {
  registerIntegration({
    name: "timetracker",
    description: "Personal research and undergraduate TA time tracking. List projects and time entries, write descriptions, edit entries and start/stop timers. Saves requested changes directly; supports explicit draft previews.",
    requiredEnv: ["TIME_TRACKER_API_URL", "FIREBASE_API_KEY", "FIREBASE_REFRESH_TOKEN"],
    isEnabled: async () => timeTrackerConfigured(),
    createServer: async ctx => createTimeTrackerMcp(ctx.conversationId, "direct"),
    createTools: async ctx => createTimeTrackerTools(ctx.conversationId, undefined, undefined, "direct"),
  });
}
