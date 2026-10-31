// Shared by setup, the dashboard, and runtime validation. Account availability
// is determined by Codex; this catalog is not an entitlement check.
export const DEFAULT_CODEX_MODEL = "gpt-6-luna";
export const DEFAULT_CODEX_REASONING_EFFORT = "low";
export const CODEX_MODELS = [
  { value: "gpt-6-luna", label: "GPT-6 Luna (lightweight default)" },
  { value: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { value: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
  { value: "gpt-6-astra", label: "GPT-6 Astra" },
];
