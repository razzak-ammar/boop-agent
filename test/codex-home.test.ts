import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createIsolatedCodexHome } from "../server/runtimes/codex-home.js";

describe("isolated Codex state", () => {
  it("uses the private state root, retains read-only isolation, and shares only auth", () => {
    const root = mkdtempSync(join(tmpdir(), "boop-home-test-"));
    try {
      const auth = join(root, "auth.json");
      writeFileSync(auth, '{"test":true}', { mode: 0o600 });
      writeFileSync(join(root, "config.toml"), 'sandbox_mode="danger-full-access"');
      const state = join(root, "state");
      const home = createIsolatedCodexHome({ BOOP_CODEX_AUTH_HOME: root, BOOP_CODEX_STATE_DIR: state });
      expect(home.startsWith(join(state, "run-"))).toBe(true);
      expect(realpathSync(join(home, "auth.json"))).toBe(realpathSync(auth));
      expect(readFileSync(join(home, "config.toml"), "utf8")).toContain('sandbox_mode = "read-only"');
      expect(readFileSync(join(home, "config.toml"), "utf8")).not.toContain("danger-full-access");
      if (process.platform !== "win32") {
        expect(statSync(home).mode & 0o777).toBe(0o700);
        expect(statSync(join(home, "config.toml")).mode & 0o777).toBe(0o600);
      }
      rmSync(home, { recursive: true });
      expect(readFileSync(auth, "utf8")).toBe('{"test":true}');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails before creating state when the source login is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "boop-home-test-"));
    try {
      expect(() => createIsolatedCodexHome({ BOOP_CODEX_AUTH_HOME: root, BOOP_CODEX_STATE_DIR: join(root, "state") })).toThrow("Codex auth not found");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
