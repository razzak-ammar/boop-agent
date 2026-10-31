import { z } from "zod";

export function zodShapeToJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  // Describe input so defaulted arguments remain optional for the model.
  // Use Zod's public converter rather than version-specific _def internals.
  const { $schema: _dialect, ...schema } = z.toJSONSchema(z.object(shape), {
    target: "draft-7",
    io: "input",
    override: ({ jsonSchema }) => {
      if (jsonSchema.type === "object" && jsonSchema.additionalProperties === undefined) {
        jsonSchema.additionalProperties = false;
      }
    },
  });
  return schema;
}
