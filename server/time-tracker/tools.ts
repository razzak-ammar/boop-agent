import { getStoredUserTimezone } from "../timezone-config.js";
import { eventPreview, localizeEvent, resolveLocalTime } from "./time.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { getTimeTrackerClient, type TimeTrackerClient, type RecordData, type Resource } from "./client.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine(value => Number.isFinite(Date.parse(value)), "Use a valid timestamp with seconds and an explicit offset.");
const projectFields = {
  name: z.string().min(1).max(100).refine(value => value.trim().length > 0),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/), isPinned: z.boolean().optional(),
};
const eventFields = {
  projectId: id, startTime: timestamp, endTime: timestamp.nullable().optional(),
  description: z.string().max(10_000).optional(), isActive: z.boolean().optional(),
};
const projectPatch = z.object(projectFields).partial().strict().refine(value => Object.keys(value).length > 0);
const eventPatch = z.object(eventFields).partial().strict().refine(value => Object.keys(value).length > 0);
const draftSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create_project"), body: z.object({ id, ...projectFields }).strict() }).strict(),
  z.object({ operation: z.literal("create_event"), body: z.object({ id, ...eventFields }).strict() }).strict(),
  z.object({ operation: z.literal("update_project"), id, body: projectPatch, expectedUpdatedAt: z.string() }).strict(),
  z.object({ operation: z.literal("update_event"), id, body: eventPatch, expectedUpdatedAt: z.string() }).strict(),
  z.object({ operation: z.literal("delete_event"), id, expectedUpdatedAt: z.string() }).strict(),
]);
type Draft = z.infer<typeof draftSchema>;
function validateEvent(event: Record<string, unknown>): void {
  if (event.isActive === true) {
    if (event.endTime != null) throw new Error("Running timers cannot have an endTime.");
  } else if (typeof event.endTime !== "string" || Date.parse(event.endTime) <= Date.parse(String(event.startTime))) {
    throw new Error("Completed entries require endTime later than startTime.");
  }
}
function version(record: RecordData): string {
  if (typeof record.updatedAt !== "string") throw new Error("TimeTracker did not return updatedAt; cannot safely stage this edit.");
  if (record.deletedAt) throw new Error("Restore this item in TimeTracker before editing it.");
  return record.updatedAt;
}

/** Called only by send_draft after user approval; writes never run in workers. */
async function executeTimeTrackerDraftRaw(payload: string, client: TimeTrackerClient): Promise<unknown> {
  const draft = draftSchema.parse(JSON.parse(payload));
  if (draft.operation === "create_event") validateEvent(draft.body);
  if (draft.operation === "create_event" || draft.operation === "create_project") {
    if (draft.operation === "create_event" && draft.body.isActive) {
      const active = await client.list("events", { isActive: true });
      if (active.some(entry => entry.id !== draft.body.id)) throw new Error("Another active timer exists. Resolve it before approving this timer.");
    }
    return client.create(draft.operation === "create_event" ? "events" : "projects", draft.body);
  }
  const resource: Resource = draft.operation === "update_project" ? "projects" : "events";
  const current = await client.get(resource, draft.id);
  if (draft.operation === "delete_event" && current.deletedAt) return { deleted: true };
  if (version(current) !== draft.expectedUpdatedAt) throw new Error("TimeTracker entry changed since this draft was prepared. Read it again and prepare a new draft.");
  if (draft.operation === "delete_event") return client.request("DELETE", `events/${draft.id}`);
  if (draft.operation === "update_event") {
    validateEvent({ ...current, ...draft.body });
    if (draft.body.isActive === true) {
      const active = await client.list("events", { isActive: true });
      if (active.some(entry => entry.id !== draft.id)) throw new Error("Another active timer exists. Resolve it before restarting this timer.");
    }
  }
  return client.request("PATCH", `${resource}/${draft.id}`, draft.body);
}

export async function executeTimeTrackerDraft(payload: string, client = getTimeTrackerClient(), timezoneProvider = getStoredUserTimezone): Promise<unknown> {
  const result = await executeTimeTrackerDraftRaw(payload, client);
  if (result && typeof result === "object" && "data" in result) {
    const data = (result as { data: RecordData }).data;
    if (data && typeof data === "object" && typeof data.startTime === "string" && typeof data.projectId === "string") {
      return { ...result, data: localizeEvent(data, await timezoneProvider()) };
    }
  }
  return result;
}

export async function reviseTimeTrackerDraft(payload: string, changes: Record<string, unknown>, clientProvider = getTimeTrackerClient, timezoneProvider = getStoredUserTimezone): Promise<{ payload: string; summary: string }> {
  const draft = draftSchema.parse(JSON.parse(payload));
  if (draft.operation === "delete_event") throw new Error("A deletion draft cannot be edited; cancel it instead.");
  const project = draft.operation === "create_project" || draft.operation === "update_project";
  const patch = project ? projectPatch.parse(changes) : eventPatch.parse(changes);
  const updated = draftSchema.parse({ ...draft, body: { ...draft.body, ...patch } });
  if (updated.operation === "delete_event") throw new Error("Cannot revise a deletion.");
  if (updated.operation === "create_project" || updated.operation === "update_project") return { payload: JSON.stringify(updated), summary: `TimeTracker project: ${JSON.stringify(updated.body)}` };
  const timezone = await timezoneProvider();
  if (!timezone) throw new Error("Set the user's timezone before revising an entry.");
  const event = updated.operation === "create_event" ? updated.body : { ...await clientProvider().get("events", updated.id), ...updated.body };
  validateEvent(event);
  return { payload: JSON.stringify(updated), summary: `TimeTracker entry: ${eventPreview(event, timezone)}` };
}

export function createTimeTrackerTools(conversationId?: string, clientProvider = getTimeTrackerClient, timezoneProvider = getStoredUserTimezone, writeMode: "draft" | "direct" = "draft"): RuntimeTool[] {
  const tools: RuntimeTool[] = [];
  const requestedDraft = new AsyncLocalStorage<boolean>();
  const writeNames = new Set(["create_project", "update_project", "create_event", "update_event", "delete_event", "start_timer", "stop_timer"]);
  const add = <T extends z.ZodRawShape>(name: string, description: string, shape: T, handle: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>) => {
    const write = writeNames.has(name);
    const schema = write ? { ...shape, draftOnly: z.boolean().optional().describe("True only if the user explicitly requests a draft or preview without saving.") } : shape;
    const help = write && writeMode === "direct"
      ? `Perform the user's requested TimeTracker change immediately and return its saved result. No additional approval is needed. Set draftOnly=true only for an explicit draft/preview request. ${description.replace(/Stage /g, "Prepare ").replace(/for approval/g, "for saving").replace(/does not write to TimeTracker yet/g, "saves immediately")}`
      : description;
    tools.push(defineRuntimeTool("timetracker", name, help, schema, async args => {
      const { draftOnly, ...input } = args as Record<string, unknown>;
      try { return await requestedDraft.run(draftOnly === true, async () => runtimeText(JSON.stringify(await handle(input as z.infer<z.ZodObject<T>>)))); }
      catch (error) { return runtimeText(error instanceof Error ? error.message : "TimeTracker operation failed.", false); }
    }));
  };

  const requireTimezone = async () => {
    const timezone = await timezoneProvider();
    if (!timezone) throw new Error("Ask the user to set their timezone before preparing a time-entry draft.");
    return timezone;
  };
  const stage = async (summary: string, draft: Draft) => {
    if (!conversationId) throw new Error("TimeTracker writes require a conversation to stage a draft for approval.");
    draftSchema.parse(draft);
    let preview: RecordData | undefined;
    if (draft.operation === "create_event" || draft.operation === "update_event" || draft.operation === "delete_event") {
      const timezone = await requireTimezone();
      const event = draft.operation === "create_event" ? draft.body : {
        ...await clientProvider().get("events", draft.id),
        ...(draft.operation === "update_event" ? draft.body : {}),
      };
      preview = localizeEvent(event, timezone);
      const action = draft.operation === "delete_event" ? "Delete" : draft.operation === "update_event" ? "Update" : "Log";
      summary = `${action} TimeTracker entry: ${eventPreview(event, timezone)}`;
    }
    const draftId = `draft_${randomUUID()}`;
    await convex.mutation(api.drafts.create, { draftId, conversationId, kind: "timetracker.action", summary, payload: JSON.stringify(draft) });
    if (writeMode === "direct" && !requestedDraft.getStore()) {
      try {
        const result = await executeTimeTrackerDraft(JSON.stringify(draft), clientProvider(), timezoneProvider);
        await convex.mutation(api.drafts.setStatus, { draftId, status: "sent" });
        return { status: "saved", draftId, summary, result };
      } catch (error) {
        throw new Error(`TimeTracker save could not be confirmed. Operation ${draftId} remains pending; inspect/retry this exact operation with get_draft/send_draft rather than creating another. ${error instanceof Error ? error.message : "Request failed."}`);
      }
    }
    return { draftId, summary, ...(preview ? { preview } : {}), status: "pending", instruction: "Show this draft to the user. Only send_draft commits after approval. Do not save another copy with save_draft." };
  };
  add("resolve_local_time", "Convert an explicit local calendar date and 24-hour time to API timestamps using the user's saved timezone. Call this before writing times or building date filters; do not calculate UTC offsets yourself. Resolve relative dates from Application Time context. Ambiguous/nonexistent DST times require clarification.", {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/), occurrence: z.enum(["earlier", "later"]).optional(),
  }, async args => resolveLocalTime(args.date, args.time, await requireTimezone(), args.occurrence));
  add("check_connection", "Read-only TimeTracker connection check. Never returns credentials.", {}, async () => {
    await clientProvider().request("GET", "projects", undefined, { limit: 1 });
    return { connected: true };
  });
  add("list_projects", "List all TimeTracker projects, following every page. Excludes trash by default.", { includeDeleted: z.boolean().optional() }, args => clientProvider().list("projects", args));
  add("get_project", "Read a TimeTracker project by ID, including trash metadata.", { id }, args => clientProvider().get("projects", args.id));
  add("list_events", "List time entries (not calendar events), following all pages and sorting chronologically. from/to filter startTime, NOT overlap. Use explicit timezone offsets calculated for each instant.", {
    projectId: id.optional(), from: timestamp.optional(), to: timestamp.optional(), isActive: z.boolean().optional(), includeDeleted: z.boolean().optional(),
  }, async args => {
    if (args.from && args.to && Date.parse(args.from) >= Date.parse(args.to)) throw new Error("to must be after from.");
    const timezone = await timezoneProvider();
    return (await clientProvider().list("events", args)).sort((a, b) => Date.parse(String(a.startTime)) - Date.parse(String(b.startTime)) || a.id.localeCompare(b.id)).map(event => localizeEvent(event, timezone));
  });
  add("get_event", "Read one TimeTracker time entry, including trash metadata.", { id }, async args => localizeEvent(await clientProvider().get("events", args.id), await timezoneProvider()));
  add("create_project", "Stage a new TimeTracker project for approval; does not write to TimeTracker yet.", projectFields, async args => stage(`Create TimeTracker project: ${args.name}`, { operation: "create_project", body: { ...args, id: randomUUID(), isPinned: args.isPinned ?? false } }));
  add("update_project", "Stage project name, color or pin changes for approval.", { id, changes: projectPatch }, async args => {
    const current = await clientProvider().get("projects", args.id);
    return stage(`Update TimeTracker project ${String(current.name)}`, { operation: "update_project", id: args.id, body: args.changes, expectedUpdatedAt: version(current) });
  });
  add("create_event", "Stage a completed time entry or running timer for approval. Discover project IDs first. Base descriptions on supplied facts; ask if activity or times are ambiguous. Use timestamps with the correct per-instant timezone offset.", eventFields, async args => {
    const body = { ...args, id: randomUUID(), isActive: args.isActive ?? false };
    validateEvent(body);
    version(await clientProvider().get("projects", args.projectId));
    if (body.isActive && (await clientProvider().list("events", { isActive: true })).length) throw new Error("An active timer exists; ask the user how to handle it before starting another.");
    return stage(`Log TimeTracker entry: ${args.startTime} – ${args.endTime ?? "running"}; ${args.description ?? "no description"}`, { operation: "create_event", body });
  });
  add("update_event", "Stage changes to an entry's times, description, project or timer state. Only supplied fields change. Use description='' to clear. Stop with isActive=false and endTime together.", { id, changes: eventPatch }, async args => {
    const current = await clientProvider().get("events", args.id);
    validateEvent({ ...current, ...args.changes });
    return stage(`Update TimeTracker entry ${args.id}: ${JSON.stringify(args.changes)}`, { operation: "update_event", id: args.id, body: args.changes, expectedUpdatedAt: version(current) });
  });
  add("delete_event", "Stage recoverable deletion of a time entry for approval. Restore is available only in the TimeTracker app.", { id }, async args => {
    const current = await clientProvider().get("events", args.id);
    return stage(`Move TimeTracker entry ${args.id} to Recently Deleted`, { operation: "delete_event", id: args.id, expectedUpdatedAt: version(current) });
  });
  add("start_timer", "Stage a running time entry for approval. Check existing active timers first. startTime must reflect the requested start instant, not approval time.", { projectId: id, startTime: timestamp, description: eventFields.description }, async args => {
    version(await clientProvider().get("projects", args.projectId));
    if ((await clientProvider().list("events", { isActive: true })).length) throw new Error("An active timer exists; stop it before starting another.");
    return stage(`Start TimeTracker timer at ${args.startTime}: ${args.description ?? "no description"}`, { operation: "create_event", body: { ...args, id: randomUUID(), isActive: true, endTime: null } });
  });
  add("stop_timer", "Stage stopping a specific active timer for approval. endTime is the requested stop instant.", { id, endTime: timestamp }, async args => {
    const current = await clientProvider().get("events", args.id);
    if (!current.isActive) throw new Error("This entry is not an active timer.");
    const body = { isActive: false, endTime: args.endTime };
    validateEvent({ ...current, ...body });
    return stage(`Stop TimeTracker timer ${args.id} at ${args.endTime}`, { operation: "update_event", id: args.id, body, expectedUpdatedAt: version(current) });
  });
  return tools;
}
export function createTimeTrackerMcp(conversationId?: string, writeMode: "draft" | "direct" = "draft") {
  return createClaudeMcpServer("timetracker", createTimeTrackerTools(conversationId, undefined, undefined, writeMode));
}
