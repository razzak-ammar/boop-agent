import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../server/convex-client.js", () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }));
import { convex } from "../server/convex-client.js";
import { getRuntimeConfig, resolveModelInput, setRuntimeProvider } from "../server/runtime-config.js";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("Codex subscription model selection", () => {
  it("resolves current models and aliases, and rejects retired models", () => {
    expect(resolveModelInput("mini", "codex")).toBe("gpt-6-luna");
    expect(resolveModelInput(" Luna ", "codex")).toBe("gpt-6-luna");
    expect(resolveModelInput("gpt-6.1-sol", "codex")).toBe("gpt-6.1-sol");
    expect(resolveModelInput("terra", "codex")).toBe("gpt-6.1-terra");
    expect(resolveModelInput("gpt-5.5", "codex")).toBeNull();
    expect(resolveModelInput("gpt-5.4-mini", "codex")).toBeNull();
    expect(resolveModelInput("sonnet", "claude")).toBe("claude-sonnet-4-6");
  });

  it("uses Luna with low reasoning by default and falls back from retired settings", async () => {
    vi.stubEnv("BOOP_RUNTIME", "codex");
    vi.stubEnv("BOOP_CODEX_MODEL", "gpt-5.5");
    vi.stubEnv("BOOP_CODEX_REASONING_EFFORT", "");
    vi.mocked(convex.query).mockImplementation(async (_ref, args: any) => args.key === "codex_model" ? "gpt-5.4-mini" : null);
    await setRuntimeProvider("codex"); // invalidate config cache
    expect(await getRuntimeConfig()).toMatchObject({ runtime: "codex", model: "gpt-6-luna", reasoningEffort: "low", billingMode: "codex-subscription" });
  });

  it("lets a saved current model override the env fallback", async () => {
    vi.stubEnv("BOOP_RUNTIME", "codex");
    vi.stubEnv("BOOP_CODEX_MODEL", "gpt-6-luna");
    vi.mocked(convex.query).mockImplementation(async (_ref, args: any) => args.key === "codex_model" ? "gpt-6.1-sol" : null);
    await setRuntimeProvider("codex");
    expect((await getRuntimeConfig()).model).toBe("gpt-6.1-sol");
  });
});
