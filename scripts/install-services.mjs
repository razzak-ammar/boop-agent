import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

function quote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error("Service paths must not contain control characters.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;
}

export function renderServiceUnits({ root, node, path }) {
  if (/[\r\n\0]/.test(root)) throw new Error("Service paths must not contain control characters.");
  const shared = `WorkingDirectory=${root.replaceAll("%", "%%")}
Environment=${quote(`PATH=${path}`)}
UMask=0077
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=30`;
  return {
    "boop.service": `[Unit]
Description=Boop personal agent and Telegram poller
After=network-online.target

[Service]
Type=simple
${shared}
Environment=NODE_ENV=production
ExecStartPre=${quote(node)} ${quote(join(root, "scripts/preflight.mjs"))}
ExecStart=${quote(node)} --import tsx ${quote(join(root, "server/index.ts"))}

[Install]
WantedBy=default.target
`,
    "boop-dashboard.service": `[Unit]
Description=Boop existing dashboard (SSH tunnel access)
Wants=boop.service
After=boop.service

[Service]
Type=simple
${shared}
Environment=NODE_ENV=development
ExecStart=${quote(node)} ${quote(join(root, "node_modules/vite/bin/vite.js"))} --config ${quote(join(root, "debug/vite.config.ts"))} --host 127.0.0.1 --strictPort

[Install]
WantedBy=default.target
`,
  };
}

export function installServices() {
  if (process.platform !== "linux") throw new Error("The service installer requires Linux with systemd.");
  if (process.getuid?.() === 0) throw new Error("Run this as ubuntu (or your service user), without sudo.");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const file of [".env.local", "convex/_generated/api.js", "node_modules/vite/bin/vite.js"]) {
    if (!existsSync(join(root, file))) throw new Error(`Missing ${file}; finish npm ci and Convex/env setup first.`);
  }
  const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (codex.status !== 0) throw new Error("codex is not available on PATH. Activate your Node/nvm environment first.");
  const units = renderServiceUnits({ root, node: process.execPath, path: process.env.PATH || dirname(process.execPath) });
  const directory = join(homedir(), ".config", "systemd", "user");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(units)) writeFileSync(join(directory, name), content, { mode: 0o600 });
  const validation = spawnSync("systemd-analyze", ["--user", "verify", ...Object.keys(units).map((name) => join(directory, name))], { stdio: "inherit" });
  if (validation.status !== 0) throw new Error("systemd rejected the generated unit files; services were not started.");
  for (const args of [["--user", "daemon-reload"], ["--user", "enable", "--now", "boop.service", "boop-dashboard.service"]]) {
    const result = spawnSync("systemctl", args, { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`systemctl ${args.join(" ")} failed. Unit files were saved in ${directory}.`);
  }
  for (const name of Object.keys(units)) {
    const active = spawnSync("systemctl", ["--user", "is-active", "--quiet", name]);
    if (active.status !== 0) throw new Error(`${name} did not start; inspect systemctl --user status boop boop-dashboard.`);
  }
  console.log("Boop and the existing dashboard are enabled as user services.");
  console.log("To keep them running after logout/reboot: sudo loginctl enable-linger $(whoami)");
  console.log("Logs: journalctl --user -u boop -u boop-dashboard -f");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { installServices(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
