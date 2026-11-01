import { lexer, type Token } from "marked";

interface TelegramEntity {
  type: "bold" | "italic" | "strikethrough" | "code" | "pre" | "text_link";
  offset: number;
  length: number;
  url?: string;
}

interface TelegramText {
  text: string;
  entities: TelegramEntity[];
}

type Style = Omit<TelegramEntity, "offset" | "length">;

// Send explicit entities instead of asking Telegram to parse the model's
// Markdown dialect. Literal HTML and punctuation remain ordinary text.
export function formatTelegram(text: string): TelegramText {
  const result: TelegramText = { text: "", entities: [] };
  const append = (value: string, styles: Style[] = []) => {
    if (!value) return;
    const offset = result.text.length;
    result.text += value;
    for (const style of styles) {
      result.entities.push({ ...style, offset, length: value.length });
    }
  };
  const styled = (styles: Style[], style: Style) =>
    [...styles.filter((s) => s.type !== style.type), style];
  const render = (tokens: Token[], styles: Style[] = [], listDepth = 0) => {
    for (const [index, token] of tokens.entries()) {
      const nestedTokens = "tokens" in token ? token.tokens ?? [] : [];
      const children = () => render(nestedTokens, styles, listDepth);
      const trailingNewlines = () => {
        const suffix = token.raw.match(/\n+$/)?.[0] ?? "";
        const existing = result.text.match(/\n+$/)?.[0].length ?? 0;
        append(suffix.slice(existing));
      };
      switch (token.type) {
        case "strong":
        case "em":
        case "del": {
          const type = token.type === "strong" ? "bold" : token.type === "em" ? "italic" : "strikethrough";
          render(nestedTokens, styled(styles, { type }), listDepth);
          break;
        }
        case "heading":
          render(nestedTokens, styled(styles, { type: "bold" }), listDepth);
          trailingNewlines();
          break;
        case "paragraph":
          children();
          trailingNewlines();
          break;
        case "text":
          if (token.tokens) children();
          else append(token.text, styles);
          break;
        case "escape":
          append(token.text, styles);
          break;
        case "codespan":
          // Telegram forbids other entities nested inside code/pre.
          append(token.text, [{ type: "code" }]);
          break;
        case "code":
          append(token.text, [{ type: "pre" }]);
          trailingNewlines();
          break;
        case "link":
        case "image": {
          // Unsupported destinations stay readable without invalid entities.
          const url = token.href;
          const linkStyles = /^(https?:\/\/|mailto:|tg:\/\/)/i.test(url)
            ? styled(styles, { type: "text_link", url }) : styles;
          render(nestedTokens, linkStyles, listDepth);
          if (!linkStyles.some((s) => s.type === "text_link")) append(` (${url})`, styles);
          break;
        }
        case "list":
          if (index > 0 && !result.text.endsWith("\n")) append("\n");
          token.items.forEach((item: { task: boolean; checked?: boolean; tokens: Token[] }, index: number) => {
            append("  ".repeat(listDepth));
            append(item.task ? (item.checked ? "☑ " : "☐ ") : token.ordered ? `${Number(token.start) + index}. ` : "• ");
            render(item.tokens, styles, listDepth + 1);
            if (index < token.items.length - 1 && !result.text.endsWith("\n")) append("\n");
          });
          trailingNewlines();
          break;
        case "blockquote":
          children();
          trailingNewlines();
          break;
        case "br":
          append("\n");
          break;
        case "def":
          break;
        default:
          // Preserve unsupported constructs (including raw HTML and tables).
          append(token.raw, styles);
      }
    }
  };
  render(lexer(text));
  return result;
}

// Entity offsets and lengths use UTF-16 units, as do JavaScript strings.
// Clip/rebase entities per chunk and never split an emoji's surrogate pair.
export function formattedTelegramChunks(text: string): TelegramText[] {
  const formatted = formatTelegram(text);
  const chunks: TelegramText[] = [];
  let start = 0;
  for (const text of telegramChunks(formatted.text)) {
    const end = start + text.length;
    const entities = formatted.entities.flatMap((entity) => {
      const from = Math.max(start, entity.offset);
      const to = Math.min(end, entity.offset + entity.length);
      return to > from ? [{ ...entity, offset: from - start, length: to - from }] : [];
    });
    chunks.push({ text, entities });
    start = end;
  }
  return chunks;
}

// Count UTF-16 units conservatively, preserving surrogate pairs at boundaries.
export function telegramChunks(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (chunk.length + char.length > 4000) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
