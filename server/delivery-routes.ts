import express from "express";
import { deliverySettings, parseCheckinDestination, setCheckinDestination } from "./delivery.js";

/** GET /delivery -> { checkinDestination, telegramAvailable, appAvailable }
 *  PUT /delivery { checkinDestination } -> same, after saving.
 *  checkinDestination is "origin" | "telegram" | "app" | "both". */
export function createDeliveryRouter() {
  const router = express.Router();

  router.get("/", async (_req, res) => {
    try {
      res.json(await deliverySettings());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.put("/", async (req, res) => {
    const value = (req.body as { checkinDestination?: unknown } | undefined)?.checkinDestination;
    const destination = parseCheckinDestination(value);
    if (!destination) {
      res.status(400).json({ error: `Unknown check-in destination "${String(value)}"` });
      return;
    }
    try {
      await setCheckinDestination(destination);
      res.json(await deliverySettings());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
