// Token-authenticated API for the native iOS app (ios/Boop).
//
// Unlike the dashboard routes, these are reachable off-box: the app talks to
// the server over Tailscale or a reverse proxy, so every request must carry
// `Authorization: Bearer $BOOP_APP_TOKEN`. With no token configured, the whole
// router answers 404 and nothing changes from the local-only default.
import express, { type Request, type Response, type NextFunction } from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { subscribe } from "./broadcast.js";
import { appConversationId, appToken, isAuthorizedAppRequest } from "./app-auth.js";
import { deliverySettings, parseCheckinDestination, setCheckinDestination } from "./delivery.js";
import { handleUserMessage } from "./interaction-agent.js";
import { CLAUDE_MODELS, CODEX_MODELS } from "./model-catalog.js";
import {
  getRuntimeConfig,
  resolveModelInput,
  resolveReasoningEffortInput,
  resolveRuntimeInput,
  setCodexReasoningEffort,
  setRuntimeModel,
  setRuntimeProvider,
} from "./runtime-config.js";

export { appConversationId };

function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!appToken()) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!isAuthorizedAppRequest(req.headers.authorization)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

// Friendly labels for the status line under the typing indicator.
export function describeTool(toolName: string): string {
  const name = toolName.replace(/^mcp__(?:boop-[a-z-]+|[a-z0-9_-]+)__/, "");
  if (/spawn|delegate/.test(name)) return "Working";
  if (/calendar|event/.test(name)) return "Checking calendar";
  if (/memory|recall|remember/.test(name)) return "Remembering";
  if (/reminder|automation/.test(name)) return "Scheduling";
  if (/goal/.test(name)) return "Checking goals";
  if (/task/.test(name)) return "Checking tasks";
  if (/draft/.test(name)) return "Drafting";
  if (/saved|note|collection/.test(name)) return "Checking notes";
  if (/conversation/.test(name)) return "Reading back";
  if (/ack/.test(name)) return "Thinking";
  return "Working";
}

interface AppMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

async function recentMessages(limit: number): Promise<{ messages: AppMessage[]; hasMore: boolean }> {
  const rows = await convex.query(api.messages.recent, {
    conversationId: appConversationId(),
    limit,
  });
  const messages = rows
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      id: String(m._id),
      role: m.role as "user" | "assistant",
      content: m.content,
      createdAt: m.createdAt,
    }));
  return { messages, hasMore: rows.length === limit };
}

function openEventStream(res: Response): (event: string, data: unknown) => void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  return (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

async function configPayload() {
  const [config, delivery] = await Promise.all([getRuntimeConfig(), deliverySettings()]);
  return {
    ...config,
    checkinDestination: delivery.checkinDestination,
    telegramAvailable: delivery.telegramAvailable,
    models: { claude: CLAUDE_MODELS, codex: CODEX_MODELS },
    reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
  };
}

export function createAppRouter(): express.Router {
  const router = express.Router();
  router.use(requireToken);

  // The newest `limit` messages. The app starts at 30 and asks for 30 more
  // each time you scroll to the top; hasMore says whether older ones exist.
  router.get("/messages", async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 1000);
      res.json(await recentMessages(limit));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // One turn, streamed as server-sent events:
  //   status {state: "thinking" | "working" | "responding", label?}
  //   delta  {text}      reply text as the model writes it
  //   ack    {content}   a short "on it" message sent before slow work
  //   reply  {content}   the final reply (authoritative over deltas)
  //   error  {message}
  // If the phone drops the connection, the turn still finishes and is saved;
  // the app picks it up from /messages.
  router.post("/chat", async (req, res) => {
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) {
      res.status(400).json({ error: "content required" });
      return;
    }
    const conversationId = appConversationId();
    const send = openEventStream(res);
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15_000);
    const unsubscribe = subscribe((event, data) => {
      const payload = data as { conversationId?: string; content?: string };
      if (event === "assistant_ack" && payload.conversationId === conversationId) {
        send("ack", { content: payload.content });
        send("status", { state: "thinking" });
      }
    });

    send("status", { state: "thinking" });
    let lastState = "thinking";
    try {
      const reply = await handleUserMessage({
        conversationId,
        content,
        persistAssistantReply: true,
        onThinking: (chunk) => {
          if (!chunk) return;
          if (lastState !== "responding") {
            lastState = "responding";
            send("status", { state: "responding" });
          }
          send("delta", { text: chunk });
        },
        onToolUse: (toolName) => {
          lastState = "working";
          send("status", { state: "working", label: describeTool(toolName) });
          // Text before a tool call is preamble, not the reply.
          send("delta", { reset: true });
        },
      });
      send("reply", { content: reply });
    } catch (err) {
      console.error("[app] chat failed", err);
      send("error", { message: "Something went wrong. Try again." });
    } finally {
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    }
  });

  // Long-lived stream so reminders and automation results show up while the
  // app is open. Carries only "changed"; the app refetches /messages.
  router.get("/events", (req, res) => {
    const conversationId = appConversationId();
    const send = openEventStream(res);
    send("hello", { ok: true });
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15_000);
    const unsubscribe = subscribe((event, data) => {
      const payload = data as { conversationId?: string };
      if (payload?.conversationId !== conversationId) return;
      if (event === "app_message" || event === "assistant_message" || event === "assistant_ack") {
        send("changed", { event });
      }
    });
    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  router.get("/config", async (_req, res) => {
    try {
      res.json(await configPayload());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/config", async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        runtime?: unknown;
        model?: unknown;
        reasoningEffort?: unknown;
        checkinDestination?: unknown;
      };
      const destination =
        body.checkinDestination === undefined ? undefined : parseCheckinDestination(body.checkinDestination);
      if (body.checkinDestination !== undefined && !destination) {
        res.status(400).json({ error: `Unknown check-in destination "${String(body.checkinDestination)}"` });
        return;
      }
      let runtime = body.runtime === undefined ? undefined : resolveRuntimeInput(String(body.runtime));
      if (body.runtime !== undefined && !runtime) {
        res.status(400).json({ error: `Unknown runtime "${String(body.runtime)}"` });
        return;
      }
      if (runtime) await setRuntimeProvider(runtime);
      runtime ??= (await getRuntimeConfig()).runtime;
      if (body.model !== undefined) {
        const model = resolveModelInput(String(body.model), runtime);
        if (!model) {
          res.status(400).json({ error: `Unknown ${runtime} model "${String(body.model)}"` });
          return;
        }
        await setRuntimeModel(model, runtime);
      }
      if (body.reasoningEffort !== undefined) {
        const effort = resolveReasoningEffortInput(String(body.reasoningEffort));
        if (!effort) {
          res.status(400).json({ error: `Unknown reasoning effort "${String(body.reasoningEffort)}"` });
          return;
        }
        await setCodexReasoningEffort(effort);
      }
      if (destination) await setCheckinDestination(destination);
      res.json(await configPayload());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
