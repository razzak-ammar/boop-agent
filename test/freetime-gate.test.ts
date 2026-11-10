import { describe, expect, it } from "vitest";
import { decideFreeTime, endKey, FREE_TIME, type BusyEvent, type FreeTimeInput } from "../server/freetime/gate.js";

// A fixed local day expressed in plain epoch math; the gate only compares instants.
const T0 = Date.UTC(2026, 10, 9, 0, 0);
const at = (h: number, m = 0) => T0 + (h * 60 + m) * 60000;
const clock = (h: number, m = 0) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

const lecture: BusyEvent = { key: "cal:lecture", title: "Lecture", start: at(17), end: at(18, 20) };
const dinner: BusyEvent = { key: "cal:dinner", title: "Dinner", start: at(20), end: at(21) };

function input(h: number, m: number, extra: Partial<FreeTimeInput> = {}): FreeTimeInput {
  return { now: at(h, m), clock: clock(h, m), events: [lecture, dinner], handled: new Set(), hasWork: true, ...extra };
}

describe("free-time gate", () => {
  it("stays asleep during an event and overnight", () => {
    expect(decideFreeTime(input(18, 0)).trigger).toBeUndefined();
    expect(decideFreeTime(input(23, 30)).reason).toBe("quiet hours");
  });

  it("wakes right after an event ends, with the free window", () => {
    const d = decideFreeTime(input(18, 22));
    expect(d.trigger).toBe("event_ended");
    expect(d.ended?.title).toBe("Lecture");
    expect(d.next?.title).toBe("Dinner");
    expect(d.freeMinutes).toBe(98);
    expect(d.markHandled).toEqual([endKey(lecture)]);
  });

  it("fires once per event end", () => {
    const d = decideFreeTime(input(18, 25, { handled: new Set([endKey(lecture)]), lastCheckAt: at(18, 22) }));
    expect(d.trigger).toBeUndefined();
    expect(d.markHandled).toEqual([]);
  });

  it("doesn't call the model when a message couldn't be sent anyway", () => {
    // The chat was active 20 minutes ago: an event end still gets marked
    // handled, but the model isn't woken.
    const d = decideFreeTime(input(18, 22, { lastMessageAt: at(18, 2) }));
    expect(d.trigger).toBeUndefined();
    expect(d.markHandled).toEqual([endKey(lecture)]);
  });

  it("gives an event end a shorter cooldown than the heartbeat", () => {
    const sinceChat = FREE_TIME.afterEventCooldownMinutes + 5;
    expect(decideFreeTime(input(18, 22, { lastMessageAt: at(18, 22) - sinceChat * 60000 })).trigger).toBe("event_ended");
    expect(sinceChat).toBeLessThan(FREE_TIME.cooldownMinutes);
  });

  it("skips short gaps and empty lists", () => {
    const tight: BusyEvent = { key: "cal:lab", title: "Lab", start: at(18, 30), end: at(19, 30) };
    expect(decideFreeTime(input(18, 22, { events: [lecture, tight] })).reason).toMatch(/only 8 min free/);
    expect(decideFreeTime(input(18, 22, { hasWork: false })).trigger).toBeUndefined();
  });

  it("runs a heartbeat while free, at most once an hour and not soon after chatting", () => {
    expect(decideFreeTime(input(15, 0)).trigger).toBe("heartbeat");
    expect(decideFreeTime(input(15, 0, { lastCheckAt: at(14, 30) })).trigger).toBeUndefined();
    expect(decideFreeTime(input(15, 0, { lastCheckAt: at(13, 0), lastMessageAt: at(14, 0) })).trigger).toBeUndefined();
    expect(decideFreeTime(input(15, 0, { lastCheckAt: at(13, 0), lastMessageAt: at(13, 0) })).trigger).toBe("heartbeat");
  });

  it("counts free time up to quiet hours when nothing else is scheduled", () => {
    expect(decideFreeTime(input(21, 5)).freeMinutes).toBe(55);
  });
});
