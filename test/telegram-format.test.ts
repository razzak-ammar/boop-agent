import { describe, expect, it, vi } from "vitest";
import { formatTelegram, formattedTelegramChunks } from "../server/telegram-format.js";
import { TelegramClient } from "../server/telegram.js";

describe("Telegram reply formatting", () => {
  it("renders the calendar confirmation from the reported conversation", async () => {
    const text = "Done — **BIOL 336 Review** is on your Time Blocks calendar for tomorrow, **Nov 2, 11:30 AM–12:45 PM ET**.";
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {} })));
    await new TelegramClient({ token: "123:test-token", ownerId: 42, offsetPath: "/unused" }, fetcher).send(42, text);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.text).toBe("Done — BIOL 336 Review is on your Time Blocks calendar for tomorrow, Nov 2, 11:30 AM–12:45 PM ET.");
    expect(body.entities.map((e: { offset: number; length: number; type: string }) => ({
      text: body.text.slice(e.offset, e.offset + e.length), type: e.type,
    }))).toEqual([
      { text: "BIOL 336 Review", type: "bold" },
      { text: "Nov 2, 11:30 AM–12:45 PM ET", type: "bold" },
    ]);
    expect(body.parse_mode).toBeUndefined();
  });

  it("supports nested emphasis, strike, links, and headings", () => {
    const result = formatTelegram("# Plans\n\n**Bold and *italic***, ~~cancelled~~, [calendar](https://example.com?a=1&b=2).");
    expect(result.text).toBe("Plans\n\nBold and italic, cancelled, calendar.");
    expect(result.entities).toContainEqual({ type: "bold", offset: 0, length: 5 });
    expect(result.entities).toContainEqual({ type: "italic", offset: 16, length: 6 });
    expect(result.entities).toContainEqual({ type: "strikethrough", offset: 24, length: 9 });
    expect(result.entities).toContainEqual({ type: "text_link", offset: 35, length: 8, url: "https://example.com?a=1&b=2" });
  });

  it("preserves literal markup inside code and leaves raw HTML harmless", () => {
    const result = formatTelegram("**Use `**literal** <tag>`**\n\n```js\nconst x = '<b>&</b>';\n```\n\n<b>ordinary HTML</b>");
    expect(result.text).toBe("Use **literal** <tag>\n\nconst x = '<b>&</b>';\n\n<b>ordinary HTML</b>");
    const code = result.entities.find((e) => e.type === "code")!;
    expect(result.text.slice(code.offset, code.offset + code.length)).toBe("**literal** <tag>");
    expect(result.entities.filter((e) => e.type === "bold")).toEqual([{ type: "bold", offset: 0, length: 4 }]);
    expect(result.entities.some((e) => e.type === "pre")).toBe(true);
  });

  it("keeps unmatched delimiters, escaped stars, and literal punctuation readable", () => {
    expect(formatTelegram("unclosed **bold, 2 * 3, foo_bar, \\*literal\\*, <tag> & x < y")).toEqual({
      text: "unclosed **bold, 2 * 3, foo_bar, *literal*, <tag> & x < y", entities: [],
    });
    expect(formatTelegram("- **Meetings**\n- Academics").text).toBe("• Meetings\n• Academics");
  });

  it("keeps nested lists and quoted headings on separate lines", () => {
    expect(formatTelegram("- first\n  - child\n- second").text).toBe("• first\n  • child\n• second");
    expect(formatTelegram("> # Heading\n\nNext").text).toBe("Heading\n\nNext");
  });

  it("clips and rebases formatting across chunk boundaries without breaking emoji", () => {
    const content = "a".repeat(3999) + "🐶".repeat(2100);
    const chunks = formattedTelegramChunks(`**${content}**`);
    expect(chunks.map((c) => c.text).join("")).toBe(content);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(4000);
      expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      expect(chunk.entities).toEqual([{ type: "bold", offset: 0, length: chunk.text.length }]);
    }
    expect(formatTelegram("🐶 **bold**").entities).toEqual([{ type: "bold", offset: 3, length: 4 }]);
  });
});
