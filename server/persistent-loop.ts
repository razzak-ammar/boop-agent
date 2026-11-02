import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";

const RETRY_MS = 60 * 60 * 1000;

/**
 * Interval job whose schedule survives restarts. A plain setInterval starts
 * over on every boot, so frequent deploys starved daily jobs indefinitely.
 * The last start time lives in Convex settings.
 */
export function startPersistentLoop(
  name: string,
  intervalMs: number,
  run: () => Promise<unknown>,
  opts: { startupDelayMs?: number } = {},
): () => void {
  const key = `loop:${name}:lastStartedAt`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = (delayMs: number) => {
    if (!stopped) timer = setTimeout(tick, Math.max(0, delayMs));
  };
  const tick = async () => {
    try {
      const last = Number(await convex.query(api.settings.get, { key })) || 0;
      const remaining = last + intervalMs - Date.now();
      if (remaining > 0) return schedule(remaining);
      // Record the start first so a run that crashes the process is not
      // retried on every restart.
      await convex.mutation(api.settings.set, { key, value: String(Date.now()) });
      await run();
      schedule(intervalMs);
    } catch (err) {
      console.error(`[${name}] loop error`, err);
      schedule(Math.min(intervalMs, RETRY_MS));
    }
  };
  // Let startup work (integrations, embedding model) settle first.
  schedule(opts.startupDelayMs ?? 2 * 60 * 1000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
