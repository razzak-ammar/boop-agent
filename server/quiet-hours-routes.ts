import express from "express";
import { describeQuietHours } from "./quiet-hours.js";
import { getQuietHours, setQuietHours } from "./quiet-hours-store.js";

/** GET  /quiet-hours           -> { start, end, enabled, description }
 *  PUT  /quiet-hours { start?, end?, enabled? } -> same, after saving.
 *  Times are local 24-hour "HH:mm"; an end earlier than start means overnight. */
export function createQuietHoursRouter() {
  const router = express.Router();
  const reply = (q: Awaited<ReturnType<typeof getQuietHours>>) => ({ ...q, description: describeQuietHours(q) });

  router.get("/", async (_req, res) => {
    res.json(reply(await getQuietHours()));
  });

  router.put("/", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const saved = await setQuietHours({ start: body.start, end: body.end, enabled: body.enabled });
    if (typeof saved === "string") {
      res.status(400).json({ error: saved });
      return;
    }
    res.json(reply(saved));
  });

  return router;
}
