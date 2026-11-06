// Recognize flights in calendar events. Users often title a flight with only
// its code ("DL 1234", "UA2010 → ATL"), so a search for "flight" misses it and
// the agent concludes there is no flight. Detection here is deliberately
// limited to real airline codes so course numbers like "CS 1301" don't match.

const AIRLINES: Record<string, string> = {
  AA: "American Airlines", AS: "Alaska Airlines", B6: "JetBlue", DL: "Delta", F9: "Frontier",
  G4: "Allegiant", HA: "Hawaiian Airlines", NK: "Spirit", SY: "Sun Country", UA: "United",
  WN: "Southwest", MX: "Breeze", QX: "Horizon Air", OO: "SkyWest", YX: "Republic Airways",
  "9E": "Endeavor Air", MQ: "Envoy", OH: "PSA Airlines", YV: "Mesa Airlines", ZW: "Air Wisconsin",
  AC: "Air Canada", WS: "WestJet", AM: "Aeromexico", Y4: "Volaris", VB: "VivaAerobus",
  BA: "British Airways", VS: "Virgin Atlantic", AF: "Air France", KL: "KLM", LH: "Lufthansa",
  LX: "Swiss", OS: "Austrian", SN: "Brussels Airlines", IB: "Iberia", AY: "Finnair",
  SK: "SAS", EI: "Aer Lingus", TP: "TAP Air Portugal", AZ: "ITA Airways", TK: "Turkish Airlines",
  FR: "Ryanair", U2: "easyJet", W6: "Wizz Air", EK: "Emirates", QR: "Qatar Airways",
  EY: "Etihad", SV: "Saudia", MS: "EgyptAir", ET: "Ethiopian Airlines", KQ: "Kenya Airways",
  RJ: "Royal Jordanian", AI: "Air India", "6E": "IndiGo", PK: "PIA", SQ: "Singapore Airlines",
  CX: "Cathay Pacific", JL: "Japan Airlines", NH: "ANA", KE: "Korean Air", OZ: "Asiana",
  CI: "China Airlines", BR: "EVA Air", CA: "Air China", MU: "China Eastern", CZ: "China Southern",
  QF: "Qantas", NZ: "Air New Zealand", VA: "Virgin Australia", LA: "LATAM", AV: "Avianca",
  CM: "Copa Airlines", AR: "Aerolineas Argentinas", G3: "GOL", AD: "Azul",
};

// ICAO operator codes used by flight trackers (FlightAware wants DAL1234).
const ICAO: Record<string, string> = {
  AA: "AAL", AS: "ASA", B6: "JBU", DL: "DAL", F9: "FFT", G4: "AAY", HA: "HAL", NK: "NKS",
  SY: "SCX", UA: "UAL", WN: "SWA", MX: "MXY", AC: "ACA", WS: "WJA", BA: "BAW", VS: "VIR",
  AF: "AFR", KL: "KLM", LH: "DLH", EK: "UAE", QR: "QTR", TK: "THY", AM: "AMX",
};

export interface DetectedFlight {
  /** Normalized IATA flight code, e.g. "DL1234". Absent when only the word "flight" matched. */
  code?: string;
  airline?: string;
  /** Tracker code, e.g. "DAL1234", when the airline's ICAO prefix is known. */
  icao?: string;
  /** IATA airport codes seen in the title or location, in order (e.g. ["DTW", "ATL"]). */
  airports: string[];
}

const CODE = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]|[0-9][A-Z])\s?-?\s?(\d{1,4})(?![A-Za-z0-9])/g;
const FLIGHT_WORD = /\bflight\b|✈|\bairport\b|\bboarding\b/i;
const AIRPORT = /(?<![A-Za-z])([A-Z]{3})(?![A-Za-z])/g;
// Uppercase three-letter words that are not airports in practice.
const NOT_AIRPORTS = new Set(["THE", "AND", "FOR", "YOU", "ETA", "ETD", "PST", "EST", "CST", "MST", "EDT", "PDT", "CDT", "MDT", "UTC", "GMT", "TBD", "ASAP", "RSVP", "LAB", "EXAM"]);

export function flightCodeOf(text: string): { code: string; airline: string; icao?: string } | undefined {
  for (const match of text.matchAll(CODE)) {
    const prefix = match[1];
    const airline = AIRLINES[prefix];
    if (!airline) continue;
    const number = String(Number(match[2]));
    return { code: `${prefix}${number}`, airline, icao: ICAO[prefix] && `${ICAO[prefix]}${number}` };
  }
  return undefined;
}

export function detectFlight(title: string, location = "", description = ""): DetectedFlight | undefined {
  const code = flightCodeOf(title) ?? flightCodeOf(location) ?? flightCodeOf(description.slice(0, 500));
  if (!code && !FLIGHT_WORD.test(`${title}\n${location}`)) return undefined;
  const airports = [...`${title} ${location}`.matchAll(AIRPORT)]
    .map((m) => m[1])
    .filter((a) => !NOT_AIRPORTS.has(a));
  return { ...code, airports: [...new Set(airports)] };
}

/** Case- and spacing-insensitive term match, so "dl1234" finds "DL 1234". */
export function termMatches(haystack: string, term: string): boolean {
  if (haystack.includes(term)) return true;
  const compactTerm = term.replace(/[\s-]+/g, "");
  return compactTerm.length >= 3 && /\d/.test(compactTerm) && haystack.replace(/[\s-]+/g, "").includes(compactTerm);
}
