import { z } from "zod";
import { randomUUID } from "node:crypto";
import { executeTimeTrackerDraft, reviseTimeTrackerDraft } from "./time-tracker/tools.js";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { spawnExecutionAgent } from "./execution-agent.js";
import { createClaudeMcpServer } from "./runtimes/claude.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";
import type { RuntimeConfig } from "./runtime-config.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createDraftStagingTools(conversationId: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      "boop-drafts",
      "save_draft",
      `Save a draft of an external action (email, calendar event, message, etc.) for the user to review.
Use only when the user asks for a draft or preview, or explicitly asks to wait before sending. For a clear request to perform an action, use the real integration tool instead.

- summary: one-line description the user will see.
- payload: JSON string with everything needed to execute the draft (provider-specific fields).
- kind: short type tag like "gmail.reply", "gmail.new", "gcal.event", "slack.message".`,
      {
        kind: z.string(),
        summary: z.string(),
        payload: z.string().describe("JSON string with the data needed to execute."),
      },
      async (args) => {
        const draftId = randomId("draft");
        await convex.mutation(api.drafts.create, {
          draftId,
          conversationId,
          kind: args.kind,
          summary: args.summary,
          payload: args.payload,
        });
        return runtimeText(
          `Draft saved as ${draftId}. Surface the summary to the user and ask them to confirm "send" or "cancel".`,
        );
      },
    ),
  ];
}

/**
 * Drafts MCP for EXECUTION agents. They use this to stage an action instead of
 * performing it directly.
 */
export function createDraftStagingMcp(conversationId: string) {
  return createClaudeMcpServer("boop-drafts", createDraftStagingTools(conversationId));
}

export function createDraftDecisionTools(
  conversationId: string,
  runtimeConfig?: RuntimeConfig,
): RuntimeTool[] {
  return [
    defineRuntimeTool(
      "boop-draft-decisions",
      "list_drafts",
      "List pending drafts in this conversation. Call this when the user says 'send it', 'yes', 'go ahead', etc. without a specific id.",
      {},
      async () => {
        const drafts = await convex.query(api.drafts.pendingByConversation, {
          conversationId,
        });
        if (drafts.length === 0) {
          return runtimeText("No pending drafts.");
        }
        return runtimeText(JSON.stringify({ drafts: drafts.map(({ draftId, kind, summary }) => ({ draftId, kind, summary })) }));
      },
    ),

    defineRuntimeTool("boop-draft-decisions", "get_draft", "Read a pending draft's full payload in this conversation. Use to continue or revise a prior request without asking the user to repeat it.", { draftId: z.string() }, async ({ draftId }) => {
      const draft = await convex.query(api.drafts.get, { draftId });
      if (!draft || draft.conversationId !== conversationId || draft.status !== "pending") return runtimeText("Pending draft not found in this conversation.", false);
      return runtimeText(JSON.stringify({ draftId, kind: draft.kind, summary: draft.summary, payload: draft.payload }));
    }),
    defineRuntimeTool("boop-draft-decisions", "update_draft", "Revise a pending TimeTracker draft in place from the user's correction. Preserves its project, dates, other fields and stable entry ID. Returns its replacement draft ID; this does not publish it.", { draftId: z.string(), changes: z.record(z.string(), z.unknown()) }, async ({ draftId, changes }) => {
      const draft = await convex.query(api.drafts.get, { draftId });
      if (!draft || draft.conversationId !== conversationId || draft.status !== "pending" || draft.kind !== "timetracker.action") return runtimeText("Pending TimeTracker draft not found in this conversation.", false);
      try {
        const revised = await reviseTimeTrackerDraft(draft.payload, changes);
        const replacementId = `draft_${randomUUID()}`;
        await convex.mutation(api.drafts.create, { draftId: replacementId, conversationId, kind: draft.kind, ...revised });
        await convex.mutation(api.drafts.setStatus, { draftId, status: "rejected" });
        return runtimeText(JSON.stringify({ draftId: replacementId, summary: revised.summary, status: "pending", replaces: draftId }));
      } catch (error) { return runtimeText(error instanceof Error ? error.message : "Draft update failed.", false); }
    }),

    defineRuntimeTool(
      "boop-draft-decisions",
      "send_draft",
      "Approve and execute a draft. Spawns an execution agent to actually perform the action based on the stored payload.",
      { draftId: z.string().describe("Exact draftId returned by list_drafts; never the kind field."), integrations: z.array(z.string()) },
      async (args) => {
        const draft = await convex.query(api.drafts.get, { draftId: args.draftId });
        if (!draft || draft.status !== "pending") {
          return runtimeText(`Draft ${args.draftId} not found or already decided.`, false);
        }
        if (draft.conversationId !== conversationId) return runtimeText("Draft belongs to another conversation.", false);
        if (draft.kind === "timetracker.action") {
          try {
            const result = await executeTimeTrackerDraft(draft.payload);
            await convex.mutation(api.drafts.setStatus, { draftId: args.draftId, status: "sent" });
            return runtimeText(`TimeTracker draft ${args.draftId} executed.\n${JSON.stringify(result)}`);
          } catch (error) {
            return runtimeText(error instanceof Error ? error.message : "TimeTracker action failed. Draft remains pending.", false);
          }
        }
        const task = `Execute this approved draft. Use the matching integration tool to actually send/create it.
kind: ${draft.kind}
summary: ${draft.summary}
payload JSON: ${draft.payload}`;
        const res = await spawnExecutionAgent({
          task,
          integrations: args.integrations,
          conversationId,
          name: `send:${draft.kind}`,
          runtimeConfig,
        });
        if (res.status !== "completed") return runtimeText(`Draft ${args.draftId} could not be completed and remains pending. ${res.result}`, false);
        await convex.mutation(api.drafts.setStatus, { draftId: args.draftId, status: "sent" });
        return runtimeText(`Draft ${args.draftId} executed.\n\n${res.result}`);
      },
    ),

    defineRuntimeTool(
      "boop-draft-decisions",
      "reject_draft",
      "Cancel a pending draft when the user says 'no', 'cancel', or revises the request.",
      { draftId: z.string() },
      async (args) => {
        await convex.mutation(api.drafts.setStatus, {
          draftId: args.draftId,
          status: "rejected",
        });
        return runtimeText(`Draft ${args.draftId} rejected.`);
      },
    ),
  ];
}

/**
 * Drafts MCP for the INTERACTION agent. Lets it review and approve drafts the user confirmed.
 */
export function createDraftDecisionMcp(
  conversationId: string,
  runtimeConfig?: RuntimeConfig,
) {
  return createClaudeMcpServer(
    "boop-draft-decisions",
    createDraftDecisionTools(conversationId, runtimeConfig),
  );
}
