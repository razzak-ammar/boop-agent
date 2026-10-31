// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
const modules = import.meta.glob("./**/*.ts");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-31T16:00:00Z"));
});
afterEach(() => vi.useRealTimers());
async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.automations.create, {
    automationId: "auto_test",
    name: "Reminder",
    task: "Stretch",
    integrations: [],
    schedule: "once",
    scheduleKind: "once",
    delivery: "reminder",
    reminderText: "Stretch",
    conversationId: "telegram:fixture",
    notifyConversationId: "telegram:fixture",
    nextRunAt: Date.now() + 1000,
  });
  vi.advanceTimersByTime(1000);
  return t;
}
describe("durable reminder lifecycle", () => {
  it("atomically excludes overlapping ticks and completes a one-time reminder", async () => {
    const t = await setup();
    const claims = await Promise.all([
      t.mutation(api.automations.claimRun, {
        automationId: "auto_test",
        runId: "run_a",
      }),
      t.mutation(api.automations.claimRun, {
        automationId: "auto_test",
        runId: "run_b",
      }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const runId = claims[0] ? "run_a" : "run_b";
    await t.mutation(api.automations.finishRun, {
      automationId: "auto_test",
      runId,
      success: true,
      result: "Stretch",
    });
    const row = await t.query(api.automations.get, {
      automationId: "auto_test",
    });
    expect(row?.enabled).toBe(false);
    expect(row?.nextRunAt).toBeUndefined();
    expect(row?.completedAt).toBeGreaterThanOrEqual(Date.now() - 1000);
    expect(
      await t.mutation(api.automations.claimRun, {
        automationId: "auto_test",
        runId: "run_c",
      }),
    ).toBeNull();
    await expect(
      t.mutation(api.automations.setEnabled, {
        automationId: "auto_test",
        enabled: true,
      }),
    ).rejects.toThrow(/complete/);
  });
  it("recovers an expired claim after a restart and fences out the old runner", async () => {
    const t = await setup();
    await t.mutation(api.automations.claimRun, {
      automationId: "auto_test",
      runId: "old",
    });
    vi.advanceTimersByTime(120001);
    expect(
      await t.mutation(api.automations.claimRun, {
        automationId: "auto_test",
        runId: "new",
      }),
    ).not.toBeNull();
    expect(
      await t.mutation(api.automations.finishRun, {
        automationId: "auto_test",
        runId: "old",
        success: true,
      }),
    ).toBe(false);
    const row = await t.query(api.automations.get, {
      automationId: "auto_test",
    });
    expect(row?.leaseRunId).toBe("new");
  });
  it("retries a failed one-time delivery with a bound and never marks it completed", async () => {
    const t = await setup();
    for (let n = 0; n < 3; n++) {
      await t.mutation(api.automations.claimRun, {
        automationId: "auto_test",
        runId: `run_${n}`,
      });
      await t.mutation(api.automations.finishRun, {
        automationId: "auto_test",
        runId: `run_${n}`,
        success: false,
        error: "Telegram unavailable",
      });
      if (n < 2) vi.advanceTimersByTime(60000);
    }
    const row = await t.query(api.automations.get, {
      automationId: "auto_test",
    });
    expect(row?.enabled).toBe(false);
    expect(row?.completedAt).toBeUndefined();
    expect(row?.failureCount).toBe(3);
    expect(row?.lastError).toContain("Telegram");
  });
  it("supports rescheduling a completed reminder and preserves pause state during a run", async () => {
    const t = await setup();
    await t.mutation(api.automations.claimRun, {
      automationId: "auto_test",
      runId: "run",
    });
    await t.mutation(api.automations.setEnabled, {
      automationId: "auto_test",
      enabled: false,
    });
    expect(
      await t.mutation(api.automations.renewClaim, {
        automationId: "auto_test",
        runId: "run",
      }),
    ).toBe(false);
    await t.mutation(api.automations.finishRun, {
      automationId: "auto_test",
      runId: "run",
      success: true,
    });
    await t.mutation(api.automations.reschedule, {
      automationId: "auto_test",
      conversationId: "telegram:fixture",
      scheduleKind: "once",
      schedule: "once",
      nextRunAt: Date.now() + 3600000,
    });
    const row = await t.query(api.automations.get, {
      automationId: "auto_test",
    });
    expect(row?.enabled).toBe(true);
    expect(row?.completedAt).toBeUndefined();
  });
});
