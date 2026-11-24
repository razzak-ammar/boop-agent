import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
vi.mock("../server/convex-client.js", () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }));
vi.mock("../server/interaction-agent.js", () => ({ handleUserMessage: vi.fn() }));
import { convex } from "../server/convex-client.js";
import { createAppRouter } from "../server/app-routes.js";

const TOKEN = "test-app-token-0123456789";
let server: Server;
let base: string;
const stored = new Map<string, string>();

beforeAll(async () => {
  vi.stubEnv("BOOP_APP_TOKEN", TOKEN);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  vi.stubEnv("TELEGRAM_ALLOWED_USER_ID", "");
  const app = express();
  app.use(express.json());
  app.use("/app", createAppRouter());
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/app`;
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  stored.clear();
  vi.mocked(convex.query).mockImplementation(async (_ref, args: any) => stored.get(args.key) ?? null);
  vi.mocked(convex.mutation).mockImplementation(async (ref, args: any) => {
    if (getFunctionName(ref) === "settings:set") stored.set(args.key, args.value);
    return null;
  });
});

const call = (method: string, body?: unknown) =>
  fetch(`${base}/config`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("/app/config check-in destination", () => {
  it("reports the default destination and whether Telegram is set up", async () => {
    const res = await call("GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checkinDestination: "origin", telegramAvailable: false });
  });

  it("saves a known destination", async () => {
    const res = await call("POST", { checkinDestination: "app" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checkinDestination: "app" });
    expect(stored.get("checkin_destination")).toBe("app");
  });

  it("rejects an unknown destination without saving anything", async () => {
    const res = await call("POST", { checkinDestination: "email", runtime: "claude" });
    expect(res.status).toBe(400);
    expect(stored.size).toBe(0);
  });
});
