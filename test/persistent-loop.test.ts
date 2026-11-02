import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const settings = new Map<string, string>();
vi.mock("../server/convex-client.js", () => ({convex:{
  query:vi.fn(async (_fn, args: {key: string}) => settings.get(args.key) ?? null),
  mutation:vi.fn(async (_fn, args: {key: string; value: string}) => { settings.set(args.key, args.value); }),
}}));
import { startPersistentLoop } from "../server/persistent-loop.js";

const HOUR = 60 * 60 * 1000;
describe("persistent loops", () => {
  beforeEach(() => {
    settings.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("runs a never-run job shortly after startup, then on its interval", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const stop = startPersistentLoop("job", 24 * HOUR, run, {startupDelayMs:1000});
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });
  it("keeps the schedule across restarts instead of starting over", async () => {
    settings.set("loop:job:lastStartedAt", String(Date.now() - 23 * HOUR));
    const run = vi.fn().mockResolvedValue(undefined);
    const stop = startPersistentLoop("job", 24 * HOUR, run, {startupDelayMs:1000});
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });
  it("retries a failed run within an hour without re-running on every restart", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startPersistentLoop("job", 24 * HOUR, run, {startupDelayMs:0});
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.get("loop:job:lastStartedAt")).toBe(String(Date.now()));
    await vi.advanceTimersByTimeAsync(HOUR);
    // The failed start was recorded, so the retry waits for the full interval.
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(23 * HOUR);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });
});
