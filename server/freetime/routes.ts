import express from "express";
import { runCalendarSearch } from "../calendar/tools.js";

/** Calendar names for the dashboard's free-time busy-calendar picker. The
 * choice itself is stored in Convex settings (BUSY_CALENDARS_KEY). */
export function createFreeTimeRouter() {
  const router = express.Router();
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
  return router;
}
