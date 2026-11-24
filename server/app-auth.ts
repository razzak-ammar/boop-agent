import { timingSafeEqual } from "node:crypto";

// Bearer token for the iOS app API. Kept free of other imports so
// local-access.ts can use it without pulling in Convex.
export function appToken(): string | null {
  const token = process.env.BOOP_APP_TOKEN?.trim();
  return token && token.length >= 16 ? token : null;
}

export function isAuthorizedAppRequest(authorization: string | string[] | undefined): boolean {
  const token = appToken();
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!token || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length).trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// The conversation the iOS app reads and writes. Lives here (not in
// app-routes.ts) so notifications.ts can use it without an import cycle.
export function appConversationId(): string {
  return process.env.BOOP_APP_CONVERSATION_ID?.trim() || "app:owner";
}
