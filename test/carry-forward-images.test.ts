import { describe, expect, it } from "vitest";
import { carriedImageStorageIds, CARRY_WINDOW_MS } from "../server/images/carry-forward.js";

const now = 1_800_000_000_000;
const user = (minutesAgo: number, images?: string[]) => ({ role: "user", createdAt: now - minutesAgo * 60_000, imageStorageIds: images });
const assistant = (minutesAgo: number) => ({ role: "assistant", createdAt: now - minutesAgo * 60_000 });

describe("carriedImageStorageIds", () => {
  it("carries a bare photo into the next text message", () => {
    expect(carriedImageStorageIds([assistant(60), user(2, ["img1"]), user(0)], now)).toEqual(["img1"]);
  });

  it("carries several photos sent in a row, oldest first", () => {
    expect(carriedImageStorageIds([user(3, ["a"]), user(2, ["b"]), user(0)], now)).toEqual(["a", "b"]);
  });

  it("does not carry a photo the assistant already answered", () => {
    expect(carriedImageStorageIds([user(3, ["a"]), assistant(2), user(0)], now)).toEqual([]);
  });

  it("does not carry old photos", () => {
    const old = { role: "user", createdAt: now - CARRY_WINDOW_MS - 1, imageStorageIds: ["a"] };
    expect(carriedImageStorageIds([old, user(0)], now)).toEqual([]);
  });

  it("does nothing when the current message has its own image", () => {
    expect(carriedImageStorageIds([user(2, ["a"]), user(0, ["b"])], now)).toEqual([]);
  });
});
