import express from "express";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { runCalendarSearch } from "../calendar/tools.js";
import { FREETIME_TASK } from "../tasks/tools.js";
import { freeTimeStatus } from "./checkin.js";

/** Dashboard API for the Heartbeat tab. The settings themselves live in
 * Convex (busy calendars) and /quiet-hours. */
export function createFreeTimeRouter() {
  const router = express.Router();

  /** Calendar names for the busy-calendar picker. */
  router.get("/calendars", async (_req, res) => {
    const found = await runCalendarSearch({ daysAhead: 1, limit: 1 });
    if (typeof found === "string") {
      res.status(503).json({ error: found });
      return;
    }
    const names = [...new Set(found.calendarsChecked.map((c) => c.name))]
      .sort((a, b) => a.localeCompare(b));
    res.json({ calendars: names });
  });

  /** What the heartbeat would do right now. Read-only: no model call, nothing
   * marked as handled, no message sent. */
  router.get("/status", async (_req, res) => {
    try {
      const all = await convex.query(api.automations.list, {});
      const automation = all
        .filter((a) => a.task === FREETIME_TASK && a.notifyConversationId)
        .sort((a, b) => Number(b.enabled) - Number(a.enabled))[0];
      if (!automation) {
        res.json({ automation: null, status: { ready: false, reason: "Free-time check-ins haven't been set up yet. Text Boop \"check in on me when I'm free\"." } });
        return;
      }
      const status = await freeTimeStatus(automation.notifyConversationId!);
      res.json({
        automation: {
          automationId: automation.automationId,
          enabled: automation.enabled,
          lastRunAt: automation.lastRunAt ?? null,
          nextRunAt: automation.nextRunAt ?? null,
          lastError: automation.lastError ?? null,
        },
        status,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
