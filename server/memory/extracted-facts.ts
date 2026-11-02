import { z } from "zod";

const factSchema = z.object({
  content: z.string().trim().min(1).max(2000),
  segment: z.enum(["identity", "preference", "correction", "relationship", "project", "knowledge", "context"]),
  importance: z.number().finite().min(0).max(1).optional(),
  evidence: z.string().trim().min(1).optional(),
  corrects: z.string().nullable().optional(),
  supersedes: z.array(z.string()).max(10).optional(),
  describesImage: z.boolean().optional(),
});

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

export function parseExtractedFacts(raw: string, userMessage: string, candidateIds: Set<string>, hasImages: boolean) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  if (!parsed || typeof parsed !== "object" || !("facts" in parsed) || !Array.isArray(parsed.facts)) return [];
  const seen = new Set<string>();
  return parsed.facts.slice(0, 20).flatMap((value: unknown) => {
    const result = factSchema.safeParse(value);
    if (!result.success) return [];
    const fact = result.data;
    const imageFact = fact.describesImage === true && hasImages;
    // Text facts must cite the user's actual words, never only the assistant.
    if (!imageFact && (!fact.evidence || !normalize(userMessage).includes(normalize(fact.evidence)))) return [];
    const key = normalize(fact.content);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...fact, supersedes: [...new Set(fact.supersedes ?? [])].filter(id => candidateIds.has(id)) }];
  });
}
