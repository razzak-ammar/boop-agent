import { describe, expect, it } from "vitest";
import { detectFlight, flightCodeOf, termMatches } from "../server/calendar/flights.js";
import { searchCalendarEvents, type CalendarRead } from "../server/calendar/search.js";

const ok = (data: unknown) => ({ successful: true, data });
const timed = (id: string, summary: string, start: string, extra: Record<string, unknown> = {}) =>
  ({ id, summary, start: { dateTime: start }, end: { dateTime: start }, ...extra });

describe("flight detection", () => {
  it("recognizes airline codes with or without spaces, but not course numbers", () => {
    expect(flightCodeOf("DL 1234")).toMatchObject({ code: "DL1234", airline: "Delta", icao: "DAL1234" });
    expect(flightCodeOf("UA2010 → ATL")).toMatchObject({ code: "UA2010", icao: "UAL2010" });
    expect(flightCodeOf("WN 0042")).toMatchObject({ code: "WN42" });
    expect(flightCodeOf("CS 1301 lecture")).toBeUndefined();
    expect(flightCodeOf("MATH 347")).toBeUndefined();
  });

  it("reads airports from imported flight locations", () => {
    expect(detectFlight("Flight to Atlanta (DL 1234)", "Detroit DTW")).toMatchObject({ code: "DL1234", airports: ["DTW"] });
    expect(detectFlight("Study group", "Library")).toBeUndefined();
  });

  it("matches compact flight codes", () => {
    expect(termMatches("dl 1234 to atl", "dl1234")).toBe(true);
    expect(termMatches("dl1234", "dl 1234")).toBe(true);
    expect(termMatches("dinner", "din ner")).toBe(false);
  });
});

describe("calendar search finds code-only flights", () => {
  const read: CalendarRead = async (tool) => tool === "GOOGLECALENDAR_LIST_CALENDARS"
    ? ok({ calendars: [{ id: "primary", summary: "Personal" }] })
    : ok({ items: [
      timed("lec", "CS 1301", "2026-11-10T09:00:00-05:00"),
      timed("ret", "DL 1234", "2026-11-20T18:05:00-05:00", { location: "LGA → ATL" }),
    ] });
  const now = Date.parse("2026-11-06T12:00:00Z");

  it("returns only flights with flightsOnly, including location", async () => {
    const result = await searchCalendarEvents({ flightsOnly: true }, read, "America/New_York", now);
    expect(result.events.map((e) => e.id)).toEqual(["ret"]);
    expect(result.events[0].location).toBe("LGA → ATL");
    expect(result.events[0].flight).toMatchObject({ code: "DL1234", airports: ["LGA", "ATL"] });
  });

  it("finds the flight by destination in the location or by compact code", async () => {
    expect((await searchCalendarEvents({ terms: ["atl"] }, read, "America/New_York", now)).events.map((e) => e.id)).toEqual(["ret"]);
    expect((await searchCalendarEvents({ terms: ["DL1234"] }, read, "America/New_York", now)).events.map((e) => e.id)).toEqual(["ret"]);
  });
});
