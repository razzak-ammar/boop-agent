import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
vi.mock("../server/convex-client.js", () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }));
import { convex } from "../server/convex-client.js";
import {
  destinationsFor,
  parseCheckinDestination,
  resolveDestinations,
} from "../server/delivery.js";

const TELEGRAM = "telegram:42";
const APP = "app:owner";

describe("check-in destination resolution", () => {
  const resolve = (setting: Parameters<typeof resolveDestinations>[0]["setting"], origin = "debug", telegram: string | null = TELEGRAM, app: string | null = APP) =>
    resolveDestinations({ setting, origin, telegram, app });

  it("sends to the origin by default", () => {
    expect(resolve("origin")).toEqual(["debug"]);
    expect(resolve("origin", "sms:fixture")).toEqual(["sms:fixture"]);
  });

  it("sends to Telegram, the app, or both", () => {
    expect(resolve("telegram")).toEqual([TELEGRAM]);
    expect(resolve("app")).toEqual([APP]);
    expect(resolve("both")).toEqual([TELEGRAM, APP]);
  });

  it("falls back to the origin when the chosen target isn't set up", () => {
    expect(resolve("telegram", "debug", null)).toEqual(["debug"]);
    expect(resolve("app", "debug", TELEGRAM, null)).toEqual(["debug"]);
    expect(resolve("both", "debug", null, null)).toEqual(["debug"]);
    expect(resolve("both", "debug", null, APP)).toEqual([APP]);
  });

  it("never sends twice to the same conversation", () => {
    expect(resolve("telegram", TELEGRAM)).toEqual([TELEGRAM]);
    expect(resolve("both", APP)).toEqual([TELEGRAM, APP]);
    expect(resolve("both", "debug", APP, APP)).toEqual([APP]);
  });

  it("accepts only the four known values", () => {
    expect(parseCheckinDestination(" Both ")).toBe("both");
    expect(parseCheckinDestination("origin")).toBe("origin");
    expect(parseCheckinDestination("email")).toBeNull();
    expect(parseCheckinDestination(undefined)).toBeNull();
    expect(parseCheckinDestination(["app"])).toBeNull();
  });
});

describe("check-in destination setting", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("reads the stored setting and only targets configured channels", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("TELEGRAM_ALLOWED_USER_ID", "");
    vi.stubEnv("BOOP_APP_TOKEN", "test-app-token-0123456789");
    vi.stubEnv("BOOP_APP_CONVERSATION_ID", "");
    vi.mocked(convex.query).mockImplementation(async (ref, args: any) =>
      getFunctionName(ref) === "settings:get" && args.key === "checkin_destination" ? "both" : null,
    );
    expect(await destinationsFor("telegram:7")).toEqual([APP]);
  });

  it("treats a missing or unreadable setting as the origin", async () => {
    vi.mocked(convex.query).mockResolvedValueOnce(null);
    expect(await destinationsFor("debug")).toEqual(["debug"]);
    vi.mocked(convex.query).mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await destinationsFor("debug")).toEqual(["debug"]);
  });
});
