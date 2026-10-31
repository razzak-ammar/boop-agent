import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CODEX_MODEL } from "../model-catalog.js";

export function createIsolatedCodexHome(env = process.env): string {
  const sourceHome = env.BOOP_CODEX_AUTH_HOME ?? env.CODEX_HOME ?? join(homedir(), ".codex");
  const sourceAuth = join(sourceHome, "auth.json");
  if (!existsSync(sourceAuth)) {
    throw new Error(`Codex auth not found at ${sourceAuth}. Run codex login or set BOOP_CODEX_AUTH_HOME to a Codex home containing auth.json.`);
  }
  // Codex intentionally refuses PATH helpers under OS temporary directories.
  // Keep isolated, disposable per-run homes in Boop's private state directory.
  const stateDir = resolve(env.BOOP_CODEX_STATE_DIR || join(homedir(), ".local", "state", "boop", "codex-homes"));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const codexHome = mkdtempSync(join(stateDir, "run-"));
  try {
    mkdirSync(join(codexHome, "workspace"), { mode: 0o700 });
    const targetAuth = join(codexHome, "auth.json");
    try {
      symlinkSync(resolve(sourceAuth), targetAuth);
    } catch {
      copyFileSync(sourceAuth, targetAuth);
      chmodSync(targetAuth, 0o600);
    }
    writeFileSync(join(codexHome, "config.toml"), [
      `model = "${DEFAULT_CODEX_MODEL}"`,
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      'web_search = "disabled"',
      "",
    ].join("\n"), { mode: 0o600 });
    return codexHome;
  } catch (error) {
    rmSync(codexHome, { recursive: true, force: true });
    throw error;
  }
}
