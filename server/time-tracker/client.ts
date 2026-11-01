import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type Resource = "projects" | "events";
export type RecordData = Record<string, unknown> & { id: string };
export type Filters = Record<string, string | number | boolean | undefined>;
export class TimeTrackerError extends Error {
  constructor(public status: number, public code: string) {
    // Do not expose upstream bodies, URLs, headers, or credentials to agents/logs.
    super(`TimeTracker request failed (${status}, ${code}).`);
  }
}
interface Options {
  url: string;
  apiKey: string;
  refreshToken: string;
  sessionFile: string;
  fetch?: typeof fetch;
}
export class TimeTrackerClient {
  private token?: { value: string; expires: number };
  private refreshing?: Promise<string>;
  private refreshToken: string;
  private loaded = false;
  private readonly fetcher: typeof fetch;
  private readonly url: string;
  private readonly sessionKey: string;
  constructor(private options: Options) {
    const url = new URL(options.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("TIME_TRACKER_API_URL must be an HTTPS base URL without credentials or query parameters.");
    }
    this.url = options.url.replace(/\/+$/, "");
    this.sessionKey = createHash("sha256").update(`${this.url}\n${options.apiKey}\n${options.refreshToken}`).digest("hex");
    this.refreshToken = options.refreshToken;
    this.fetcher = options.fetch ?? fetch;
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refresh(): Promise<string> {
    if (!this.loaded) {
      try {
        const stored = JSON.parse(await readFile(this.options.sessionFile, "utf8"));
        if (stored.key === this.sessionKey && typeof stored.refreshToken === "string") this.refreshToken = stored.refreshToken;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read TimeTracker session file; check permissions and JSON format.");
      }
      this.loaded = true;
    }
    let response: Response;
    try {
      response = await this.fetcher(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(this.options.apiKey)}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.refreshToken }),
      });
    } catch { throw new Error("TimeTracker authentication unavailable; retry later."); }
    if (!response.ok) throw new TimeTrackerError(response.status, "authentication_failed");
    let body: Record<string, unknown>;
    try { body = await response.json() as Record<string, unknown>; }
    catch { throw new Error("Invalid TimeTracker authentication response."); }
    const expires = Number(body.expires_in);
    if (typeof body.id_token !== "string" || typeof body.refresh_token !== "string" || !Number.isFinite(expires) || expires <= 0) {
      throw new Error("Invalid TimeTracker authentication response.");
    }
    this.refreshToken = body.refresh_token;
    const file = this.options.sessionFile;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ key: this.sessionKey, refreshToken: this.refreshToken }), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } catch { throw new Error("Cannot persist TimeTracker session; check session file permissions."); }
    this.token = { value: body.id_token, expires: Date.now() + expires * 1000 };
    return this.token.value;
  }
  async request(method: string, path: string, body?: unknown, filters: Filters = {}): Promise<unknown> {
    const url = new URL(`${this.url}/${path}`);
    for (const [key, value] of Object.entries(filters)) if (value !== undefined) url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method, redirect: "error", signal: AbortSignal.timeout(20_000),
          headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch { throw new TimeTrackerError(0, "network_error"); }
      if (response.status === 401 && attempt === 0) {
        if (this.token?.value === token) this.token = undefined;
        continue;
      }
      if (!response.ok) {
        const allowed = new Set(["invalid_argument", "unauthenticated", "not_found", "method_not_allowed", "already_exists", "resource_deleted", "payload_too_large", "unsupported_media_type", "internal"]);
        let code = "request_failed";
        try {
          const error = await response.json() as { error?: { code?: string } };
          if (error.error?.code && allowed.has(error.error.code)) code = error.error.code;
        } catch { /* Infrastructure errors need not be JSON. */ }
        throw new TimeTrackerError(response.status, code);
      }
      if (response.status === 204) return { deleted: true };
      try { return await response.json(); }
      catch { throw new TimeTrackerError(response.status, "invalid_response"); }
    }
    throw new TimeTrackerError(401, "unauthenticated");
  }
  async get(resource: Resource, id: string): Promise<RecordData> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid TimeTracker resource ID.");
    return (await this.request("GET", `${resource}/${id}`) as { data: RecordData }).data;
  }
  async list(resource: Resource, filters: Filters = {}): Promise<RecordData[]> {
    const data: RecordData[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 1000; page++) {
      const result = await this.request("GET", resource, undefined, { ...filters, limit: 200, cursor }) as { data: RecordData[]; nextCursor: string | null };
      data.push(...result.data);
      if (result.nextCursor === null) return data;
      if (!result.nextCursor || seen.has(result.nextCursor)) throw new Error("Invalid TimeTracker pagination cursor.");
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("TimeTracker traversal limit exceeded; results are incomplete. Narrow the query or use the API directly.");
  }
  async create(resource: Resource, body: RecordData): Promise<unknown> {
    // The ID must be persisted in the draft before any network write.
    try { return await this.request("POST", resource, body); }
    catch (error) {
      if (!(error instanceof TimeTrackerError) || ![0, 409, 500, 502, 503, 504].includes(error.status)) throw error;
      const existing = await this.get(resource, body.id);
      const matches = Object.entries(body).every(([key, value]) => {
        const actual = existing[key];
        if (key === "startTime" || key === "endTime") {
          if (value == null) return actual == null;
          return typeof actual === "string" && Date.parse(actual) === Date.parse(String(value));
        }
        return actual === value;
      });
      if (!matches || existing.deletedAt) throw new Error("TimeTracker creation could not be verified; keep the original draft ID and inspect the entry before retrying.");
      return { data: existing, recovered: true };
    }
  }
}
let shared: TimeTrackerClient | undefined;
export function timeTrackerConfigured(): boolean {
  return ["TIME_TRACKER_API_URL", "FIREBASE_API_KEY", "FIREBASE_REFRESH_TOKEN"].every(key => Boolean(process.env[key]?.trim()));
}
export function getTimeTrackerClient(): TimeTrackerClient {
  if (!timeTrackerConfigured()) throw new Error("Configure TIME_TRACKER_API_URL, FIREBASE_API_KEY and FIREBASE_REFRESH_TOKEN, then restart Boop.");
  return shared ??= new TimeTrackerClient({
    url: process.env.TIME_TRACKER_API_URL!, apiKey: process.env.FIREBASE_API_KEY!, refreshToken: process.env.FIREBASE_REFRESH_TOKEN!,
    sessionFile: resolve(process.env.TIME_TRACKER_SESSION_FILE || "data/time-tracker-session.json"),
  });
}
