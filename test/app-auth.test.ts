import { afterEach, describe, expect, it } from "vitest";
import { isAuthorizedAppRequest } from "../server/app-auth.js";
import { isPublicServerRequest } from "../server/local-access.js";

const TOKEN = "test-app-token-0123456789";

function request(url: string, authorization?: string) {
  return {
    headers: { host: "boop.example.test", ...(authorization ? { authorization } : {}) },
    method: "POST",
    socket: { remoteAddress: "203.0.113.10" },
    url,
  } as Parameters<typeof isPublicServerRequest>[0];
}

describe("iOS app API access", () => {
  const previous = process.env.BOOP_APP_TOKEN;
  afterEach(() => {
    if (previous === undefined) delete process.env.BOOP_APP_TOKEN;
    else process.env.BOOP_APP_TOKEN = previous;
  });

  it("stays closed when no token is configured", () => {
    delete process.env.BOOP_APP_TOKEN;
    expect(isAuthorizedAppRequest(`Bearer ${TOKEN}`)).toBe(false);
    expect(isPublicServerRequest(request("/app/chat", `Bearer ${TOKEN}`))).toBe(false);
  });

  it("ignores tokens that are too short to be safe", () => {
    process.env.BOOP_APP_TOKEN = "short";
    expect(isAuthorizedAppRequest("Bearer short")).toBe(false);
  });

  it("admits /app requests only with the exact bearer token", () => {
    process.env.BOOP_APP_TOKEN = TOKEN;
    expect(isPublicServerRequest(request("/app/chat", `Bearer ${TOKEN}`))).toBe(true);
    expect(isPublicServerRequest(request("/app/chat", `Bearer ${TOKEN}x`))).toBe(false);
    expect(isPublicServerRequest(request("/app/chat"))).toBe(false);
  });

  it("does not open other routes with the app token", () => {
    process.env.BOOP_APP_TOKEN = TOKEN;
    expect(isPublicServerRequest(request("/chat", `Bearer ${TOKEN}`))).toBe(false);
    expect(isPublicServerRequest(request("/runtime-config", `Bearer ${TOKEN}`))).toBe(false);
    expect(isPublicServerRequest(request("/apple/enable", `Bearer ${TOKEN}`))).toBe(false);
  });
});
