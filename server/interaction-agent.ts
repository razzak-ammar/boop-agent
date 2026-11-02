import { createTimeTrackerTools } from "./time-tracker/tools.js";
import { createCalendarTools } from "./calendar/tools.js";
import { parseRememberCommand, storeRawNote } from "./memory/note-intake.js";
import { describeUserNow } from "./timezone-config.js";
import { BOOP_DELEGATE_TOOL, buildInteractionPrompt, PROACTIVE_SYSTEM } from "./interaction-prompt.js";
import { shouldExtractMemory } from "./memory/extraction-policy.js";
import { formatRecordCost } from "./token-pricing.js";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { createSavedTools } from "./saved/tools.js";
import { createMemoryTools } from "./memory/tools.js";
import { extractAndStore } from "./memory/extract.js";
import { spawnExecutionAgent } from "./execution-agent.js";
import { listEnabledIntegrations } from "./integrations/registry.js";
import { createAutomationTools } from "./automation-tools.js";
import { createDraftDecisionTools } from "./draft-tools.js";
import { createSelfTools } from "./self-tools.js";
import {
  getRuntimeConfig,
  resolveRuntimeInput,
  setRuntimeProvider,
} from "./runtime-config.js";
import { broadcast } from "./broadcast.js";
import { sendConversationNotification } from "./notifications.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { runtimeText } from "./runtimes/types.js";
import { EMPTY_USAGE, type UsageTotals } from "./usage.js";
import {
  buildPromptWithImagesOrTextFallback,
  fetchStoredBytes,
} from "./images/content-blocks.js";
import { redactPhoneNumbers } from "./privacy.js";



interface HandleOpts {
  conversationId: string;
  content: string;
  turnTag?: string;
  onThinking?: (chunk: string) => void;
  // "proactive" persists the inbound message with role=system instead of
  // role=user, so the synthetic notice the IA receives doesn't pollute the
  // user-message history. Defaults to "user".
  kind?: "user" | "proactive";
  // The Sendblue/proactive callers persist the delivered final message after
  // transport succeeds. Local chat callers still need the assistant turn in
  // Convex so conversation views reflect the full exchange.
  persistAssistantReply?: boolean;
  images?: Array<{ storageId: string; mediaType: string }>;
  mediaError?: string;
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function runtimeLabel(runtime: "claude" | "codex"): string {
  return runtime === "codex" ? "Codex" : "Claude";
}

export function resolveDirectRuntimeSwitch(content: string): "claude" | "codex" | null {
  const normalized = content
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
  const match = normalized.match(
    /^(?:please |pls |can you )?(?:switch|change|set|use|move|flip)(?: me| boop)?(?: (?:runtime|provider))?(?: back| over)?(?: to)? (?<runtime>claude agent sdk|chatgpt codex|anthropic|claude|codex|chatgpt)(?: runtime| provider)?(?: for (?:the )?next turn)?(?: please)?$/,
  );
  if (!match?.groups?.runtime) return null;
  return resolveRuntimeInput(match.groups.runtime);
}

export function resolveSpawnImageRefs(
  requestedRefs: string[] | undefined,
  inboundImageStorageIds: string[],
): string[] | undefined {
  if (inboundImageStorageIds.length === 0) return undefined;
  const selected = requestedRefs?.filter((id) =>
    inboundImageStorageIds.includes(id),
  );
  return selected && selected.length > 0 ? selected : inboundImageStorageIds;
}

function explicitlyRequestsBrowser(content: string): boolean {
  const normalized = content.toLowerCase().replace(/\s+/g, " ");
  const directBrowserIntent =
    /\blocal browser\b/.test(normalized) ||
    /\blocal chrome\b/.test(normalized) ||
    /\bpatchright\b/.test(normalized) ||
    /\bbrowser integration\b/.test(normalized) ||
    /\bchrome instance\b/.test(normalized) ||
    /\bbrowser instance\b/.test(normalized) ||
    /\bchrome on (?:my|your|the user'?s) machine\b/.test(normalized) ||
    /\bbrowser on (?:my|your|the user'?s) machine\b/.test(normalized) ||
    /\bspawn (?:a |the )?(?:chrome|browser)\b/.test(normalized);
  const antiNative =
    /\b(?:not|without|don'?t use|do not use) composio\b/.test(normalized) ||
    /\b(?:not|without|don'?t use|do not use) (?:the )?(?:native |api )?integrations?\b/.test(
      normalized,
    );
  const browserMention = /\b(?:browser|chrome)\b/.test(normalized);
  return directBrowserIntent || (antiNative && browserMention);
}

export function resolveSpawnIntegrations(
  requested: string[],
  available: string[],
  content: string,
): string[] {
  if (available.includes("browser") && explicitlyRequestsBrowser(content)) {
    return ["browser"];
  }
  return requested;
}

export function unavailableSpawnIntegrations(requested: string[], available: string[]): string[] {
  return [...new Set(requested.filter((name) => !available.includes(name)))];
}

export async function handleUserMessage(opts: HandleOpts): Promise<string> {
  const turnId = randomId("turn");
  const integrations = (await listEnabledIntegrations()).map((i) => i.name);

  const inboundRole = opts.kind === "proactive" ? "system" : "user";
  const inboundImageStorageIds = (opts.images ?? []).map((i) => i.storageId);
  await convex.mutation(api.messages.send, {
    conversationId: opts.conversationId,
    role: inboundRole,
    content: opts.content,
    turnId,
    // TODO(codegen): drop cast once schema push regenerates Convex API.
    imageStorageIds: inboundImageStorageIds.length > 0
      ? (inboundImageStorageIds as never)
      : undefined,
    mediaError: opts.mediaError,
  });
  broadcast(opts.kind === "proactive" ? "proactive_notice" : "user_message", {
    conversationId: opts.conversationId,
    content: opts.content,
  });

  const history =
    opts.kind === "proactive"
      ? []
      : await convex.query(api.messages.recent, {
          conversationId: opts.conversationId,
          limit: 30,
        });
  const historyBlock = history
    .slice(0, -1)
    .map((m) => `${m.role.toUpperCase()}${m.createdAt ? " [" + new Date(m.createdAt).toISOString() + "]" : ""}: ${m.content}`)
    .join("\n");

  const systemPrompt = opts.kind === "proactive"
    ? PROACTIVE_SYSTEM
    : buildInteractionPrompt(integrations, await describeUserNow());

  const userText = opts.mediaError
    ? `[user sent images but they couldn't be downloaded: ${opts.mediaError}]\n${opts.content}`
    : opts.content;
  const promptText =
    opts.kind === "proactive"
      ? `Standalone proactive notice. Write a concise user-facing iMessage from this notice only. Do not research, spawn agents, or continue any prior conversation.\n\n${userText}`
      : historyBlock
        ? `Prior turns:\n${historyBlock}\n\nCurrent message:\n${userText}`
        : userText;

  const tag = opts.turnTag ?? turnId.slice(-6);
  const log = (msg: string) => console.log(`[turn ${tag}] ${msg}`);

  const turnStart = Date.now();
  // Snapshot runtime for this top-level turn so same-turn set_runtime/set_model
  // changes do not split the dispatcher and any spawned execution agent.
  const runtimeConfig = await getRuntimeConfig();
  const note = opts.kind !== "proactive" && !opts.mediaError
    ? parseRememberCommand(opts.content) : null;
  if (note !== null) {
    const reply = note ? "Saved your full note. I'll organize the details into memory." : "Send /remember followed by the information you'd like me to save.";
    if (note) await storeRawNote(opts.conversationId, turnId, note, inboundImageStorageIds);
    broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });
    if (opts.persistAssistantReply) {
      await convex.mutation(api.messages.send, {
        conversationId: opts.conversationId, role: "assistant", content: reply, turnId,
      });
    }
    if (note) {
      extractAndStore({ conversationId: opts.conversationId, userMessage: note,
        assistantReply: reply, turnId, runtimeConfig, imageStorageIds: inboundImageStorageIds,
      }).catch((err) => console.error("[interaction] note extraction error", err));
    }
    return reply;
  }

  const directRuntimeSwitch =
    opts.kind === "proactive" ? null : resolveDirectRuntimeSwitch(opts.content);
  if (directRuntimeSwitch) {
    await setRuntimeProvider(directRuntimeSwitch);
    const nextConfig = await getRuntimeConfig();
    const label = runtimeLabel(directRuntimeSwitch);
    const reply =
      runtimeConfig.runtime === directRuntimeSwitch
        ? `Already on ${label}. Next turn will use ${nextConfig.model}.`
        : `Switched to ${label}. Next turn will use ${nextConfig.model}.`;
    log(`runtime switch: ${runtimeConfig.runtime} -> ${directRuntimeSwitch}`);
    broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });
    if (opts.persistAssistantReply) {
      await convex.mutation(api.messages.send, {
        conversationId: opts.conversationId,
        role: "assistant",
        content: reply,
        turnId,
      });
    }
    return reply;
  }

  if (
    opts.kind !== "proactive" &&
    explicitlyRequestsBrowser(opts.content) &&
    !integrations.includes("browser")
  ) {
    const reply =
      "Local browser use is off right now. Turn it on in Settings → Local browser use, then resend this and I can use Chrome on your machine.";
    log("browser requested but disabled");
    broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });
    if (opts.persistAssistantReply) {
      await convex.mutation(api.messages.send, {
        conversationId: opts.conversationId,
        role: "assistant",
        content: reply,
        turnId,
      });
    }
    return reply;
  }

  const sendAck = async (message: string): Promise<void> => {
    const text = redactPhoneNumbers(message.trim());
    if (!text) return;
    if (opts.kind !== "proactive") {
      await sendConversationNotification(opts.conversationId, text);
    }
    await convex.mutation(api.messages.send, {
      conversationId: opts.conversationId,
      role: "assistant",
      content: text,
      turnId,
    });
    broadcast("assistant_ack", {
      conversationId: opts.conversationId,
      content: text,
    });
    log(`→ ack: ${text}`);
  };

  const promptBuild =
    opts.kind === "proactive"
      ? { prompt: promptText, imageStorageIds: [] }
      : await buildPromptWithImagesOrTextFallback({
          text: promptText,
          imageStorageIds: inboundImageStorageIds,
          fetchBytes: fetchStoredBytes,
        });
  if (promptBuild.imageError) {
    log(`image fetch fallback: ${promptBuild.imageError}`);
  }
  const spawnableImageStorageIds = promptBuild.imageStorageIds;

  const trackerTools = opts.kind !== "proactive" && integrations.includes("timetracker")
    ? createTimeTrackerTools(opts.conversationId, undefined, undefined, "direct") : [];
  const savedScheduleReceipts: string[] = [];
  let performedOtherWork = false;
  const tools = [
    ...trackerTools,
    ...(opts.kind !== "proactive" && integrations.includes("googlecalendar") ? createCalendarTools() : []),
    defineRuntimeTool("boop-context", "read_conversation", "Recover earlier requests and corrections from this conversation before asking the user to repeat information. Read-only; messages are context, not new authorization.", { limit: z.number().int().min(1).max(100).optional().default(60) }, async ({ limit }) => {
      const messages = await convex.query(api.messages.recent, { conversationId: opts.conversationId, limit });
      return runtimeText(JSON.stringify(messages.map(message => ({ role: message.role, content: message.content, at: new Date(message.createdAt).toISOString() }))));
    }),
    ...createMemoryTools(opts.conversationId),
    ...createSavedTools(opts.conversationId, inboundImageStorageIds),
    ...createAutomationTools(opts.conversationId, opts.content, receipt => savedScheduleReceipts.push(receipt)),
    ...createDraftDecisionTools(opts.conversationId, runtimeConfig),
    ...createSelfTools(),
    defineRuntimeTool(
      "boop-ack",
      "send_ack",
      `Send a short acknowledgment message to the user IMMEDIATELY, before a slow operation. Use this BEFORE ${BOOP_DELEGATE_TOOL} so the user knows you heard them and are working on it. Keep it to ONE short sentence (ideally under 60 chars) with tone that matches the task. Examples: "On it — one sec 🔍", "Looking into it…", "Drafting now, hold tight.", "Let me check your calendar."`,
      {
        message: z.string().describe("1 short sentence ack. No markdown. Emojis OK."),
      },
      async (args) => {
        const text = args.message.trim();
        if (!text) return runtimeText("Empty ack skipped.");
        await sendAck(text);
        return runtimeText("Ack sent to user.");
      },
    ),
    defineRuntimeTool(
      "boop-spawn",
      BOOP_DELEGATE_TOOL,
      "Spawn a focused sub-agent to do real work using external tools. Returns the agent's final answer. Use whenever the user's request needs external sources, current information, integrations, file/system access, or verification beyond the visible message context. If the current user message includes images and the sub-agent's task depends on them, pass the relevant storage IDs in imageRefs. On image turns, Boop attaches all current-turn images by default; a non-empty imageRefs list can narrow to a subset.",
      {
        task: z
          .string()
          .describe("Crisp task description — what to find/draft/do, not the raw user message."),
        integrations: z
          .array(z.string())
          .describe(`Which integrations to give the agent. Available: ${integrations.join(", ") || "(none)"}`),
        name: z.string().optional().describe("Short label for the agent."),
        imageRefs: z
          .array(z.string())
          .optional()
          .describe(
            "Convex storage IDs from the user's current message. Available in this turn: " +
              (spawnableImageStorageIds.length > 0
                ? spawnableImageStorageIds.join(", ")
                : "(none)"),
          ),
      },
      async (args) => {
        const imageStorageIds = resolveSpawnImageRefs(
          args.imageRefs,
          spawnableImageStorageIds,
        );
        const requestedIntegrations = resolveSpawnIntegrations(
          args.integrations,
          integrations,
          opts.content,
        );
        const unavailable = unavailableSpawnIntegrations(requestedIntegrations, integrations);
        if (unavailable.length) {
          return runtimeText(`Cannot run this task: integrations unavailable: ${unavailable.join(", ")}. Connected integrations: ${integrations.join(", ") || "none"}. Ask the user to connect the required service in Connections. Do not claim to have checked their data or substitute another calendar provider.`, false);
        }
        const selectedIntegrations = requestedIntegrations;
        const browserForced =
          selectedIntegrations.length === 1 &&
          selectedIntegrations[0] === "browser" &&
          !args.integrations.includes("browser");
        if (browserForced) {
          log(
            `forcing browser integration for explicit browser request (model requested: ${args.integrations.join(",") || "none"})`,
          );
        }
        const res = await spawnExecutionAgent({
          task: args.task,
          integrations: selectedIntegrations,
          conversationId: opts.conversationId,
          name: args.name,
          runtimeConfig,
          imageStorageIds,
        });
        return runtimeText(`[agent ${res.agentId} ${res.status}]\n\n${redactPhoneNumbers(res.result)}`);
      },
    ),
  ];
  let reply = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  try {
    const result = await runAgentRuntime(runtimeConfig, {
      prompt: promptBuild.prompt,
      systemPrompt,
      tools,
      mode: "dispatcher",
      allowedTools:
        opts.kind === "proactive"
          ? []
          : [
              "mcp__boop-memory__write_memory",
              "mcp__boop-memory__recall",
              "mcp__boop-calendar__*",
              "mcp__boop-saved__*",
              `mcp__boop-spawn__${BOOP_DELEGATE_TOOL}`,
              "mcp__boop-automations__create_automation",
              "mcp__boop-automations__create_reminder",
              "mcp__boop-automations__reschedule_automation",
              "mcp__boop-automations__list_automations",
              "mcp__boop-automations__toggle_automation",
              "mcp__boop-automations__delete_automation",
              "mcp__boop-context__read_conversation",
              ...(trackerTools.length ? ["mcp__timetracker__*"] : []),
              "mcp__boop-draft-decisions__get_draft",
              "mcp__boop-draft-decisions__update_draft",
              "mcp__boop-draft-decisions__list_drafts",
              "mcp__boop-draft-decisions__send_draft",
              "mcp__boop-draft-decisions__reject_draft",
              "mcp__boop-ack__send_ack",
              "mcp__boop-self__get_config",
              "mcp__boop-self__set_runtime",
              "mcp__boop-self__set_model",
              "mcp__boop-self__set_codex_reasoning_effort",
              "mcp__boop-self__set_timezone",
              "mcp__boop-self__list_integrations",
              "mcp__boop-self__search_composio_catalog",
              "mcp__boop-self__inspect_toolkit",
            ],
      // Belt-and-suspenders: even with bypassPermissions the SDK can leak
      // its built-ins if we only whitelist. Explicitly block them on the
      // dispatcher so it MUST spawn a sub-agent for external work.
      disallowedTools: [
        "WebSearch",
        "WebFetch",
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Agent",
        "Skill",
      ],
      onText: (chunk) => opts.onThinking?.(chunk),
      onToolUse: (toolName, input) => {
        const schedulingSupport = /^mcp__boop-(?:memory|context|ack)__/.test(toolName)
          || /^mcp__boop-automations__(?:create_reminder|create_automation|reschedule_automation|list_automations)$/.test(toolName)
          || toolName === "mcp__boop-self__get_config";
        if (!schedulingSupport) performedOtherWork = true;
        const name = toolName.replace(/^mcp__boop-[a-z-]+__/, "");
        const inputPreview = JSON.stringify(input);
        log(
          `tool: ${name}(${inputPreview.length > 90 ? inputPreview.slice(0, 90) + "…" : inputPreview})`,
        );
      },
    });
    reply = result.text;
    usage = result.usage;
  } catch (err) {
    console.error(`[turn ${tag}] query failed`, err);
    reply = "Sorry — I hit an error processing that. Try again in a moment.";
  }

  // Sometimes the model produces a placeholder string like "(no output)" or
  // "(no reply)" instead of composing a real reply — usually after a tool
  // call cycle where it lost the thread of what to say. Treat those as
  // empty so the user gets a real fallback they can act on.
  reply = redactPhoneNumbers(reply.trim());
  // Match "(no output)" / "no reply." / "(No Response)" etc. Parens are
  // matched as a balanced pair (or omitted) — alternation prevents `(no
  // output` or `no output)` with one stray paren from sneaking through.
  const placeholder =
    /^(?:\(\s*no (?:output|reply|response|content)\s*\)|no (?:output|reply|response|content))\.?$/i;
  if (!reply || placeholder.test(reply)) {
    console.warn(`[turn ${tag}] empty/placeholder reply (${JSON.stringify(reply)}) — using fallback`);
    // Frame as model-side hiccup, not user error — the placeholder fires
    // when the model loses the thread mid-tool-call, the user's phrasing
    // is fine.
    reply = "Hmm — got tangled up there. Want to try that again?";
  }

  // A scheduling-only reply comes from persisted receipts. Model prose can
  // contradict a successful save (e.g. claim a future time already passed).
  if (savedScheduleReceipts.length) {
    reply = redactPhoneNumbers([
      ...savedScheduleReceipts,
      ...(performedOtherWork ? [reply] : []),
    ].join("\n\n"));
  }

  if (usage.costUsd > 0 || usage.inputTokens > 0) {
    log(
      `cost: in/out ${usage.inputTokens}/${usage.outputTokens}, cache r/w ${usage.cacheReadTokens}/${usage.cacheCreationTokens}, ${formatRecordCost({ ...usage, ...runtimeConfig })}`,
    );
    await convex.mutation(api.usageRecords.record, {
      source: "dispatcher",
      conversationId: opts.conversationId,
      turnId,
      runtime: runtimeConfig.runtime,
      billingMode: runtimeConfig.billingMode,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - turnStart,
    });
  }

  broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });

  if (opts.persistAssistantReply) {
    await convex.mutation(api.messages.send, {
      conversationId: opts.conversationId,
      role: "assistant",
      content: reply,
      turnId,
    });
  }

  // Background extraction — fire-and-forget; don't block the reply.
  // Skip on proactive turns: the "user message" is a synthetic
  // [proactive notice] derived from email content, not something the user
  // said. Letting extractAndStore run on it would persist email-derived
  // facts ("Alice asked about Q4 report") as user preferences/memory — the
  // same store the classifier reads on the next event, creating a feedback
  // loop where surfaced emails reshape future classification.
  if (opts.kind !== "proactive" && shouldExtractMemory(opts.content, inboundImageStorageIds)) {
    extractAndStore({
      conversationId: opts.conversationId,
      userMessage: opts.content,
      assistantReply: reply,
      turnId,
      runtimeConfig,
      imageStorageIds: inboundImageStorageIds,
    }).catch((err) => console.error("[interaction] extraction error", err));
  }

  return reply;
}
