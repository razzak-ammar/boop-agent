import { timeTrackerConfigured } from "../time-tracker/client.js";
import { createTimeTrackerMcp, createTimeTrackerTools } from "../time-tracker/tools.js";
import { registerIntegration } from "./registry.js";

export function registerTimeTrackerIntegration(): void {
  registerIntegration({
    name: "timetracker",
    description: "Personal research and undergraduate TA time tracking. List projects and time entries, write descriptions, edit entries and start/stop timers. Writes stage drafts for approval.",
    requiredEnv: ["TIME_TRACKER_API_URL", "FIREBASE_API_KEY", "FIREBASE_REFRESH_TOKEN"],
    isEnabled: async () => timeTrackerConfigured(),
    createServer: async ctx => createTimeTrackerMcp(ctx.conversationId),
    createTools: async ctx => createTimeTrackerTools(ctx.conversationId),
  });
}
