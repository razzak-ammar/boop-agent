// Shared by setup, the dashboard, and runtime validation. Account availability
// is determined by Codex; this catalog is not an entitlement check.
export const DEFAULT_CODEX_MODEL = "gpt-6-luna";
export const DEFAULT_CODEX_REASONING_EFFORT = "low";
export const CODEX_MODELS = [
  { value: "gpt-6-luna", label: "GPT-6 Luna (lightweight default)" },
  { value: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
  { value: "gpt-6.2-sol", label: "GPT-6.2 Sol" },
  { value: "gpt-6.2-astra", label: "GPT-6.2 Astra" },
  { value: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { value: "gpt-6-astra", label: "GPT-6 Astra" },
];

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
// Current models first. Older IDs stay listed so stored settings keep working.
export const CLAUDE_MODELS = [
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { value: "claude-opus-5-5", label: "Opus 5.5" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5" },
  { value: "claude-fable-5-2", label: "Fable 5.2 (most capable, priciest)" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-opus-4-7", label: "Opus 4.7" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];
