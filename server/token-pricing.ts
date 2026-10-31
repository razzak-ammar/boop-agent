// Pure shared calculation: safe to import in the server, Convex, and dashboard.
export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

type TokenPrice = {
  model: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
};

// Keep in sync with https://developers.openai.com/api/docs/pricing.
const OPENAI_STANDARD_TOKEN_PRICES: TokenPrice[] = [
  { model: "gpt-6-astra", inputPerMillion: 10, cachedInputPerMillion: 1, outputPerMillion: 50 },
  { model: "gpt-6.1-sol", inputPerMillion: 2, cachedInputPerMillion: 0.1, outputPerMillion: 10 },
  { model: "gpt-6.1-terra", inputPerMillion: 1, cachedInputPerMillion: 0.05, outputPerMillion: 5 },
  { model: "gpt-6-luna", inputPerMillion: 0.1, cachedInputPerMillion: 0.01, outputPerMillion: 0.5 },
  { model: "gpt-5.5", inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 },
  { model: "gpt-5.4-mini", inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 4.5 },
  { model: "gpt-5.4", inputPerMillion: 2.5, cachedInputPerMillion: 0.25, outputPerMillion: 15 },
  { model: "gpt-5.3-codex", inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 },
  { model: "gpt-5.2-codex", inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 },
  { model: "gpt-5.2", inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 },
  { model: "gpt-5.1-codex-max", inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  { model: "gpt-5.1-codex", inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  { model: "gpt-5-codex", inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  { model: "gpt-5-mini", inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2 },
  { model: "gpt-5", inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
];

function priceForOpenAIModel(model: string): TokenPrice | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  const exact = OPENAI_STANDARD_TOKEN_PRICES.find((price) => price.model === normalized);
  if (exact) return exact;
  // Only dated snapshots inherit a price. A similarly named future model
  // (e.g. gpt-5-new) must never silently inherit gpt-5's price.
  return OPENAI_STANDARD_TOKEN_PRICES.find((price) =>
    normalized.startsWith(`${price.model}-`) &&
    /^\d{4}-\d{2}-\d{2}$/.test(normalized.slice(price.model.length + 1)),
  ) ?? null;
}

export function estimateOpenAiCostUsd(usage: TokenUsage): number | null {
  const price = priceForOpenAIModel(usage.model);
  if (!price) return null;

  // OpenAI reports cached input as a subset of total input tokens.
  const cachedInputTokens = Math.min(Math.max(0, usage.inputTokens), Math.max(0, usage.cacheReadTokens));
  const uncachedInputTokens = Math.max(
    0,
    usage.inputTokens - cachedInputTokens + usage.cacheCreationTokens,
  );

  return (
    (uncachedInputTokens * price.inputPerMillion +
      cachedInputTokens * price.cachedInputPerMillion +
      usage.outputTokens * price.outputPerMillion) /
    1_000_000
  );
}


export interface CostRecord extends Partial<TokenUsage> {
  costUsd: number;
  runtime?: string;
  billingMode?: string;
}

export function isCodexCost(record: { runtime?: string; billingMode?: string }): boolean {
  return record.runtime === "codex" || record.billingMode === "codex-subscription";
}

// Recalculate Codex rows on read, including historical rows saved as $0 before
// their model had a price. Claude retains the SDK's reported cost.
export function costForRecord(record: CostRecord): number | null {
  return isCodexCost(record) ? estimateOpenAiCostUsd({
    model: record.model ?? "unknown",
    inputTokens: record.inputTokens ?? 0,
    outputTokens: record.outputTokens ?? 0,
    cacheReadTokens: record.cacheReadTokens ?? 0,
    cacheCreationTokens: record.cacheCreationTokens ?? 0,
  }) : record.costUsd;
}

export function formatRecordCost(record: CostRecord): string {
  const amount = costForRecord(record);
  if (amount === null) return "Cost unavailable";
  const dollars = amount > 0 && amount < 0.0001 ? "<$0.0001" : `$${amount.toFixed(4)}`;
  return isCodexCost(record) ? `~${dollars} API equivalent` : dollars;
}

export const CODEX_COST_NOTE = "API-equivalent token estimate at Standard rates, checked October 31, 2026. Not your subscription charge or remaining Plus allowance. Excludes separately priced tools. See ChatGPT usage for actual limits.";
