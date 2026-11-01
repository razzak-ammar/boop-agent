#!/usr/bin/env tsx
import prompts from "prompts";
import { parse } from "dotenv";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_URL = "https://us-central1-time-tracker-3b6df.cloudfunctions.net/agentApi";
async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw new Error("Cannot read configuration file; check file permissions."); }
}
export function updateTrackerEnv(original: string, values: Record<string, string>): string {
  for (const value of Object.values(values)) {
    if (/[\r\n\u0000'"\\]/.test(value)) throw new Error("Invalid configuration value.");
  }
  // Preserve unrelated configuration, comments, and multiline values. Append our
  // keys last after removing previous definitions. Existing values for these
  // integration keys are single-line strings, as emitted by this command.
  const lines = original.split(/\r?\n/).filter(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/);
    return !match || !(match[1] in values);
  });
  return `${lines.join("\n").trimEnd()}\n\n# TimeTracker connection\n${Object.entries(values).map(([key, value]) => `${key}='${value}'`).join("\n")}\n`;
}
export async function signIn(apiKey: string, email: string, password: string, fetcher = fetch): Promise<{ refreshToken: string; idToken: string }> {
  let response: Response;
  try {
    response = await fetcher(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
  } catch { throw new Error("Could not reach Firebase. Check your connection and try again."); }
  if (!response.ok) throw new Error("Sign-in failed. Check your TimeTracker email, password and Firebase API key. If your account requires MFA, use the existing trusted Firebase sign-in flow.");
  let body: { refreshToken?: unknown; idToken?: unknown };
  try { body = await response.json(); } catch { throw new Error("Firebase returned an invalid sign-in response."); }
  if (typeof body.refreshToken !== "string" || typeof body.idToken !== "string") throw new Error("Firebase did not return a usable session.");
  return { refreshToken: body.refreshToken, idToken: body.idToken };
}
export async function main(): Promise<void> {
  const envPath = resolve(ROOT, ".env.local");
  const original = await readOptional(envPath);
  const local = parse(original);
  const fallback = parse(await readOptional(resolve(ROOT, ".env")));
  // Only use the public project key from a neighboring TimeTracker checkout.
  const neighbor = parse(await readOptional(resolve(ROOT, "../time-tracker/web-app/.env.local")));
  const initialKey = process.env.FIREBASE_API_KEY || local.FIREBASE_API_KEY || fallback.FIREBASE_API_KEY || neighbor.NEXT_PUBLIC_FIREBASE_API_KEY;
  console.log("Connect Boop to your existing TimeTracker account. Your password is used only to sign in and is never saved.");
  const answer = await prompts([
    { type: "text", name: "url", message: "TimeTracker API URL", initial: process.env.TIME_TRACKER_API_URL || local.TIME_TRACKER_API_URL || fallback.TIME_TRACKER_API_URL || DEFAULT_URL, validate: value => {
      try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash || "Use an HTTPS API base URL."; } catch { return "Enter a valid HTTPS API base URL."; }
    } },
    { type: initialKey ? null : "text", name: "apiKey", message: "TimeTracker public Firebase API key", validate: value => Boolean(value.trim()) || "Required (NEXT_PUBLIC_FIREBASE_API_KEY in TimeTracker)." },
    { type: "text", name: "email", message: "TimeTracker email", validate: value => Boolean(value.trim()) || "Required." },
    { type: "password", name: "password", message: "TimeTracker password", validate: value => Boolean(value) || "Required." },
  ], { onCancel: () => { throw new Error("Connection cancelled. No configuration changed."); } });
  const apiKey = initialKey || String(answer.apiKey).trim();
  const url = String(answer.url).trim().replace(/\/+$/, "");
  const session = await signIn(apiKey, String(answer.email).trim(), String(answer.password));
  // Drop the password reference before doing any filesystem work.
  delete answer.password;
  console.log("Signed in. Checking the deployed TimeTracker API…");
  let response: Response;
  try {
    response = await fetch(`${url}/projects?limit=1`, { redirect: "error", signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${session.idToken}` } });
  } catch { throw new Error("Cannot reach the TimeTracker API. Check its deployment and URL. No configuration changed."); }
  if (!response.ok) throw new Error(`TimeTracker connection check failed (HTTP ${response.status}). Check deployment and account access. No configuration changed.`);
  let body: { data?: unknown };
  try { body = await response.json(); } catch { throw new Error("The configured endpoint did not return a TimeTracker response. No configuration changed."); }
  if (!Array.isArray(body.data)) throw new Error("The configured endpoint did not return a project list. No configuration changed.");
  const updated = updateTrackerEnv(original, { TIME_TRACKER_API_URL: url, FIREBASE_API_KEY: apiKey, FIREBASE_REFRESH_TOKEN: session.refreshToken });
  if (await readOptional(envPath) !== original) throw new Error(".env.local changed during setup. Run this command again to preserve those changes.");
  const temporary = `${envPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, updated, { mode: 0o600, flag: "wx" });
    await rename(temporary, envPath);
  } finally { await unlink(temporary).catch(() => {}); }
  console.log("TimeTracker connected. Credentials saved privately in .env.local. Restart Boop, then ask it to list your TimeTracker projects.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Connection failed."); process.exitCode = 1; });
}
