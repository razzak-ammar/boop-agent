import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { parseQuietHours, QUIET_HOURS_KEY, updateQuietHours, type QuietHours } from "./quiet-hours.js";

export async function getQuietHours(): Promise<QuietHours> {
  return parseQuietHours(await convex.query(api.settings.get, { key: QUIET_HOURS_KEY }));
}

/** Saves a partial change. Returns the saved value, or an error message. */
export async function setQuietHours(patch: { start?: unknown; end?: unknown; enabled?: unknown }): Promise<QuietHours | string> {
  const next = updateQuietHours(await getQuietHours(), patch);
  if (typeof next === "string") return next;
  await convex.mutation(api.settings.set, { key: QUIET_HOURS_KEY, value: JSON.stringify(next) });
  return next;
}
