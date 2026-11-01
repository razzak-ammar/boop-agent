/** Translate a provider permission failure into an actionable explanation.
 * An ACTIVE OAuth connection does not prove every requested scope was granted. */
export function composioPermissionHint(slug: string, result: { successful?: boolean; error?: unknown }): string | null {
  if (slug !== "googlecalendar" || result.successful !== false) return null;
  const error = typeof result.error === "string" ? result.error : JSON.stringify(result.error ?? {});
  if (!/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|insufficientPermissions/i.test(error)) return null;
  return "Google Calendar is connected, but Google denied this operation because the granted OAuth permissions are insufficient. Reconnect Google Calendar from Connections and approve the permission needed for the requested operation. Listing calendars requires Calendar-list read access (https://www.googleapis.com/auth/calendar.calendarlist.readonly) or a broader Calendar read permission. Do not say the calendar is absent or keep retrying this permission failure.";
}
