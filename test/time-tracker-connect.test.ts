import { describe, expect, it, vi } from "vitest";
import { parse } from "dotenv";
import { signIn, updateTrackerEnv } from "../scripts/time-tracker-connect.js";

describe("TimeTracker connection setup", () => {
  it("preserves unrelated values and replaces old tracker credentials", () => {
    const original = '# keep this\nOTHER="hello # world"\nMULTILINE="first\nsecond"\nFIREBASE_REFRESH_TOKEN=old\nexport FIREBASE_API_KEY=old-key\n';
    const result = updateTrackerEnv(original, { FIREBASE_REFRESH_TOKEN: "new-token", FIREBASE_API_KEY: "new-key" });
    expect(parse(result)).toEqual({ OTHER: "hello # world", MULTILINE: "first\nsecond", FIREBASE_REFRESH_TOKEN: "new-token", FIREBASE_API_KEY: "new-key" });
    expect(result).toContain("# keep this");
    expect(result).not.toContain("old-token");
  });
  it("rejects newline injection into configuration", () => {
    expect(() => updateTrackerEnv("", { FIREBASE_REFRESH_TOKEN: "token\nOTHER=bad" })).toThrow("Invalid configuration");
  });
  it("authenticates with Firebase and returns only the session tokens", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ idToken: "id", refreshToken: "refresh", email: "user@example.com" })));
    expect(await signIn("public-key", "user@example.com", "password", fetcher)).toEqual({ idToken: "id", refreshToken: "refresh" });
    expect(fetcher.mock.calls[0][0]).toBe("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=public-key");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ email: "user@example.com", password: "password", returnSecureToken: true });
  });
  it("never reflects upstream errors containing credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('secret-password-and-token', { status: 400 }));
    await expect(signIn("key", "email", "password", fetcher)).rejects.toThrow("Sign-in failed.");
  });
});
