import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

vi.mock("../server/convex-client.js", () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }));

import { convex } from "../server/convex-client.js";
import { ensurePulse, PULSE_TASK } from "../server/tasks/tools.js";

const pulse = (automationId: string, createdAt: number, enabled = true) => ({
  automationId, createdAt, enabled, delivery: "lookahead", task: PULSE_TASK, notifyConversationId: "telegram:fixture",
});
const calls = (name: string) =>
  vi.mocked(convex.mutation).mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, a]) => a);

describe("task pulse", () => {
  let rows: any[];
  beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
    vi.mocked(convex.query).mockImplementation(async () => [...rows]);
    vi.mocked(convex.mutation).mockImplementation(async (ref, args: any) => {
      if (getFunctionName(ref) === "automations:create") rows.push(pulse(args.automationId, Date.now()));
      return null;
    });
  });

  it("creates one pulse when two tasks are created in parallel", async () => {
    const [a, b] = await Promise.all([ensurePulse("telegram:fixture"), ensurePulse("telegram:fixture")]);
    expect(a).toBe(b);
    expect(calls("automations:create")).toHaveLength(1);
  });

  it("turns off duplicate pulses left over from earlier", async () => {
    rows = [pulse("auto_new", 2), pulse("auto_old", 1)];
    expect(await ensurePulse("telegram:fixture")).toBe("auto_old");
    expect(calls("automations:setEnabled")).toEqual([{ automationId: "auto_new", enabled: false }]);
  });
});
