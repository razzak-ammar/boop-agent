// Where scheduled messages (reminders, goal check-ins, lookaheads, other
// automations) are delivered. By default they go back to the conversation
// they were set up in; the `checkin_destination` setting can send them to
// Telegram, the iOS app, or both instead. The origin conversation stays the
// automation's home: goals, tasks and history are still read from it.
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { appConversationId, appToken } from "./app-auth.js";
import { telegramConfig } from "./telegram.js";

export const CHECKIN_DESTINATION_KEY = "checkin_destination";
export const CHECKIN_DESTINATIONS = ["origin", "telegram", "app", "both"] as const;
export type CheckinDestination = (typeof CHECKIN_DESTINATIONS)[number];
export const DEFAULT_CHECKIN_DESTINATION: CheckinDestination = "origin";

export function parseCheckinDestination(value: unknown): CheckinDestination | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return (CHECKIN_DESTINATIONS as readonly string[]).includes(lower)
    ? (lower as CheckinDestination)
    : null;
}

/** The conversations one scheduled message goes to, in order, without
 * duplicates. A target that isn't set up (null) is skipped; if nothing is
 * left, the message goes back to where it was created. */
export function resolveDestinations(input: {
  setting: CheckinDestination;
  origin: string;
  telegram: string | null;
  app: string | null;
}): string[] {
  const { setting, origin, telegram, app } = input;
  const wanted =
    setting === "telegram" ? [telegram]
      : setting === "app" ? [app]
        : setting === "both" ? [telegram, app]
          : [origin];
  const targets = wanted.filter((id): id is string => Boolean(id));
  return [...new Set(targets.length ? targets : [origin])];
}

/** Telegram's owner conversation, or null when Telegram isn't configured. */
export function telegramConversationId(): string | null {
  try {
    const config = telegramConfig();
    return config ? `telegram:${config.ownerId}` : null;
  } catch {
    return null;
  }
}

/** The iOS app's conversation, or null when the app API is turned off. */
export function appDestinationId(): string | null {
  return appToken() ? appConversationId() : null;
}

export async function getCheckinDestination(): Promise<CheckinDestination> {
  try {
    const stored = await convex.query(api.settings.get, { key: CHECKIN_DESTINATION_KEY });
    return parseCheckinDestination(stored) ?? DEFAULT_CHECKIN_DESTINATION;
  } catch (err) {
    console.warn("[delivery] settings:get failed", err);
    return DEFAULT_CHECKIN_DESTINATION;
  }
}

export async function setCheckinDestination(destination: CheckinDestination): Promise<void> {
  await convex.mutation(api.settings.set, { key: CHECKIN_DESTINATION_KEY, value: destination });
}

export async function destinationsFor(origin: string): Promise<string[]> {
  return resolveDestinations({
    setting: await getCheckinDestination(),
    origin,
    telegram: telegramConversationId(),
    app: appDestinationId(),
  });
}

export async function deliverySettings() {
  return {
    checkinDestination: await getCheckinDestination(),
    telegramAvailable: telegramConversationId() !== null,
    appAvailable: appDestinationId() !== null,
  };
}
