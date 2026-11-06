import { describe, expect, it, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }));
import { parseLookaheadReply } from "../server/tasks/lookahead.js";

describe("lookahead reply parsing", () => {
  const tasks = new Set(["task_a", "task_b"]);
  const events = new Set(["primary:flight1"]);

  it("strips the trailer and keeps only supplied ids", () => {
    const out = parseLookaheadReply(
      "Your reflection form window opens today. Done yet?\n\nFlight DL 1234 is Thursday. Want a status check Wednesday night?\nNUDGED: task_a, task_zzz\nASKED: primary:flight1",
      tasks, events,
    );
    expect(out.message).toBe("Your reflection form window opens today. Done yet?\n\nFlight DL 1234 is Thursday. Want a status check Wednesday night?");
    expect(out.nudged).toEqual(["task_a"]);
    expect(out.asked).toEqual(["primary:flight1"]);
  });

  it("treats SKIP and 'none' as nothing to send", () => {
    expect(parseLookaheadReply("SKIP\nNUDGED: none\nASKED: none", tasks, events)).toEqual({ message: undefined, nudged: [], asked: [] });
  });

  it("tolerates bold labels from Markdown-happy models", () => {
    expect(parseLookaheadReply("Hi\n**NUDGED:** task_b", tasks, events).nudged).toEqual(["task_b"]);
  });
});
