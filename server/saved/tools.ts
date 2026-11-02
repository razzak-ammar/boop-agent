import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import { convex } from "../convex-client.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText } from "../runtimes/types.js";

export function createSavedTools(conversationId: string, imageStorageIds: string[] = []) {
  const tool = <T extends z.ZodRawShape>(name: string, description: string, shape: T, run: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>) =>
    defineRuntimeTool("boop-saved", name, description, shape, async args => runtimeText(JSON.stringify(await run(args))));
  return [
    tool("save_item", "Save an exact note or item in a named collection permanently until deleted. Use this for explicit saves, recommendations, links and lists; memory alone is insufficient. Create a separate item for each list member. Current-turn images may be attached.", {
      collection: z.string().default("Notes"), title: z.string().min(1).max(300), content: z.string().max(100_000),
      kind: z.enum(["note", "link", "image"]).default("note"),
      status: z.string().optional(), recommendedBy: z.string().optional(),
      urls: z.array(z.string()).max(30).optional(), attachCurrentImages: z.boolean().default(false),
    }, async args => {
      const { attachCurrentImages, ...item } = args;
      if (attachCurrentImages && !imageStorageIds.length) throw new Error("No current images available.");
      return convex.mutation(api.savedItems.save, {
        ...item, sourceConversationId: conversationId,
        imageStorageIds: attachCurrentImages ? imageStorageIds as Id<"_storage">[] : [],
      });
    }),
    tool("list_saved_items", "List or search saved notes/collection items. Omit search for an exhaustive listing. Follow nextCursor until isDone before claiming all items were retrieved. Status and collection are exact filters; search is full-text.", {
      collection: z.string().optional(), status: z.string().optional(), search: z.string().optional(),
      cursor: z.string().nullable().default(null), limit: z.number().int().min(1).max(100).default(50),
    }, async ({ cursor, limit, ...filters }) => {
      const result = await convex.query(api.savedItems.list, { ...filters, paginationOpts: { cursor, numItems: limit } });
      return { ...result, nextCursor: result.isDone ? null : result.continueCursor };
    }),
    tool("get_saved_item", "Read the exact saved item by its returned ID, including source and attachments.", { id: z.string() },
      async ({ id }) => convex.query(api.savedItems.get, { id: id as Id<"savedItems"> })),
    tool("update_saved_item", "Edit a saved item's text, status (e.g. want-to-watch, watched), recommender, or move it to a collection. Preserve unprovided fields. Use IDs from listing, never invent them.", {
      id: z.string(), title: z.string().optional(), content: z.string().optional(), collection: z.string().optional(),
      status: z.string().optional(), recommendedBy: z.string().optional(),
    }, async args => convex.mutation(api.savedItems.update, { ...args, id: args.id as Id<"savedItems"> })),
    tool("delete_saved_item", "Delete a saved item only when the user requests removal. Use an ID from listing.", { id: z.string() },
      async ({ id }) => convex.mutation(api.savedItems.remove, { id: id as Id<"savedItems"> })),
    tool("create_collection", "Create a named collection, including an empty one. Names are case-insensitive.", { name: z.string() },
      async args => convex.mutation(api.savedItems.createCollection, args)),
    tool("list_collections", "List named collections. Follow nextCursor for remaining collections.", {
      cursor: z.string().nullable().default(null), limit: z.number().int().min(1).max(100).default(50),
    }, async ({ cursor, limit }) => {
      const result = await convex.query(api.savedItems.listCollections, { paginationOpts: { cursor, numItems: limit } });
      return { ...result, nextCursor: result.isDone ? null : result.continueCursor };
    }),
  ];
}
