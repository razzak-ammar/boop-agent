/** Opt-in live model checks. All application tools are replaced by in-memory
 * fixtures: no Convex writes, messages, drafts, or external actions occur.
 * Does consume Codex allowance. Run: node --import tsx scripts/check-codex-behavior.ts */
import assert from "node:assert/strict";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
process.env.CONVEX_URL ||= "https://test.convex.cloud";
const baselineIndex = process.argv.indexOf("--baseline-root");
const baselineRoot = baselineIndex >= 0 ? process.argv[baselineIndex + 1] : undefined;
const { runCodexAppServerAgent } = await import(baselineRoot ? pathToFileURL(`${baselineRoot}/server/runtimes/codex-app-server.ts`).href : "../server/runtimes/codex-app-server.js");
const baselinePrompt = baselineRoot ? readFileSync(`${baselineRoot}/server/interaction-agent.ts`, "utf8").match(/const INTERACTION_SYSTEM = `([\s\S]*?)`;/)?.[1] : undefined;
if (baselineRoot) assert(baselinePrompt, "Baseline dispatcher prompt not found");
const { buildInteractionPrompt, BOOP_DELEGATE_TOOL } = await import("../server/interaction-prompt.js");
const { buildExecutionPrompt } = await import("../server/execution-agent.js");
const { EXTRACTION_PROMPT } = await import("../server/memory/extract.js");
const { createMemoryTools } = await import("../server/memory/tools.js");
const { createSelfTools } = await import("../server/self-tools.js");
const { createAutomationTools } = await import("../server/automation-tools.js");
const { createDraftDecisionTools, createDraftStagingTools } = await import("../server/draft-tools.js");
const { defineRuntimeTool } = await import("../server/runtimes/tool.js");
const tools = [
  defineRuntimeTool("boop-ack", "send_ack", "Acknowledge before delegating a slow lookup.", {message:z.string()}, async()=>({text:"Ack sent."})),
  defineRuntimeTool("boop-spawn", BOOP_DELEGATE_TOOL, "Delegate external work to Boop with selected integrations.", {task:z.string(),integrations:z.array(z.string()),name:z.string().optional(),imageRefs:z.array(z.string()).optional()}, async()=>({text:"Fixture delegation"})),
  ...createMemoryTools("synthetic-eval"), ...createSelfTools(),
  ...createAutomationTools("synthetic-eval"), ...createDraftDecisionTools("synthetic-eval"),
];
const paragraph = "My name is Mira. I live in Lisbon. I'm building a time tracker called Shiftglass. I use Google Calendar, and I prefer short replies. Please remember these details.";
const caseIndex = process.argv.indexOf("--case");
const selectedCase = caseIndex >= 0 ? process.argv[caseIndex + 1] : undefined;
const results: Array<{ name: string; input: number; output: number }> = [];
for (const name of (baselineRoot ? ["personal-paragraph", "recall"] : ["personal-paragraph", "recall", "recurring-reminder", "approve-draft", "unknown-timezone", "calendar-delegation", "one-time-reminder", "selected-days", "every-other-day", "extract-paragraph"]).filter(name => !selectedCase || name === selectedCase)) {
  const calls: Array<{name:string; args: Record<string, unknown>}> = [];
  const prompts: Record<string,string> = {
    "personal-paragraph": paragraph,
    recall: "Which calendar do I use and where do I live?",
    "recurring-reminder": "Remind me every day at 9am to stretch.",
    "approve-draft": "Prior turns:\nASSISTANT: I drafted an email to Pat about lunch. Say send it to approve.\nCurrent message:\nSend it.",
    "calendar-delegation": "Check my connected Google Calendar calendar list for a calendar named Meetings.",
    "unknown-timezone": "Remind me every day at 9am to stretch.",
    "one-time-reminder": "Remind me in 30 minutes to stretch.",
    "selected-days": "Remind me every Monday, Wednesday, and Friday at 9am to stretch.",
    "every-other-day": "Remind me every other day at 9am starting November 2, 2026 to stretch.",
    "extract-paragraph": `USER: ${paragraph}\nASSISTANT: Saved your details.`,
  };
  const result = await runCodexAppServerAgent({
    prompt: prompts[name], systemPrompt: name === "extract-paragraph" ? EXTRACTION_PROMPT : baselinePrompt?.replace("{{INTEGRATIONS}}", "gmail") ?? buildInteractionPrompt(name === "calendar-delegation" ? ["googlecalendar"] : ["gmail"], {isExplicit:name !== "unknown-timezone", timezone:"America/New_York", now:"2026-10-31T18:00:00-04:00"}),
    model: "gpt-6-luna", reasoningEffort: "low", mode: name === "extract-paragraph" ? "background" : "dispatcher",
    tools: name === "extract-paragraph" ? [] : tools.map(tool => ({ ...tool, handle: async (args: Record<string, unknown>) => {
      calls.push({name: tool.name, args});
      let text = "Success.";
      if (tool.name === BOOP_DELEGATE_TOOL) text = "Calendar lookup succeeded: calendar list contains Meetings.";
      if (tool.name === "recall") text = "[permanent/identity] mem1: Mira lives in Lisbon. [long/preference] mem2: Mira uses Google Calendar.";
      if (tool.name === "get_config") text = JSON.stringify({userTimezone:name === "unknown-timezone" ? null : "America/New_York", currentLocalTime:"2026-10-31T18:00:00-04:00"});
      if (tool.name === "list_drafts") text = JSON.stringify({drafts:[{draftId:"draft_eval",kind:"gmail.new",summary:"Email Pat about lunch."}]});
      if (tool.name === "write_memory") text = "Stored fixture memory.";
      if (tool.name === "send_draft") {
        if (args.draftId !== "draft_eval") return {text:"Draft not found. Use the exact draftId from list_drafts.",success:false};
        text = "Draft draft_eval executed successfully.";
      }
      return {text, success:true};
    }})),
  });
  const called = (toolName: string) => calls.filter(c => c.name === toolName);
  if (name === "personal-paragraph") {
    const saved = JSON.stringify(called("write_memory").map(c => c.args.content)).toLowerCase();
    for (const fact of ["mira", "lisbon", "shiftglass", "google", "short"]) assert(saved.includes(fact), `Missing saved fact: ${fact}`);
  } else if (name === "recall") {
    assert(called("recall").length > 0); assert(/lisbon/i.test(result.text)); assert(/google/i.test(result.text));
  } else if (name === "recurring-reminder") {
    assert(called("create_reminder").some(c => c.args.schedule === "0 9 * * *"));
  } else if (name === "approve-draft") {
    const listed = calls.findIndex(c => c.name === "list_drafts");
    assert(listed >= 0 && calls.findIndex(c => c.name === "send_draft") > listed);
    assert(called("send_draft").some(c => c.args.draftId === "draft_eval"), JSON.stringify(calls));
  } else if (name === "unknown-timezone") {
    assert(called("create_automation").length === 0 && called("create_reminder").length === 0);
    assert(/time.?zone/i.test(result.text));
  } else if(name === "calendar-delegation") {
    assert(called(BOOP_DELEGATE_TOOL).some(c=>Array.isArray(c.args.integrations) && c.args.integrations.includes("googlecalendar")));
    assert(/Meetings/i.test(result.text));
  } else if(name === "one-time-reminder") {
    assert(called("create_reminder").some(c=>c.args.afterSeconds===1800));
  } else if(name === "selected-days") {
    assert(called("create_reminder").some(c=>typeof c.args.schedule==="string" && /(?:1,3,5|MON,WED,FRI)/i.test(c.args.schedule)));
  } else if(name === "every-other-day") {
    assert(called("create_reminder").some(c=>c.args.everyDays===2 && typeof c.args.at==="string"));
  } else {
    const parsed = JSON.parse(result.text.match(/\{[\s\S]*\}/)![0]);
    const facts = JSON.stringify(parsed.facts).toLowerCase();
    for (const fact of ["mira", "lisbon", "shiftglass", "google", "short"]) assert(facts.includes(fact), `Extraction lost: ${fact}`);
  }
  results.push({name,input:result.usage.inputTokens,output:result.usage.outputTokens});
  console.log(JSON.stringify({name,passed:true,usage:result.usage,tools:calls.map(c => c.name)}));
}
if (baselineRoot || (selectedCase && selectedCase !== "stage-action")) process.exit(0);
// Worker action safety: ensure the full worker policy stages an action.
const staged: string[] = [];
const draftTools = createDraftStagingTools("synthetic-eval").map(tool => ({...tool, handle: async () => {staged.push(tool.name);return {text:"Draft saved as draft_eval; awaiting user approval.",success:true};}}));
const result = await runCodexAppServerAgent({
  prompt: "Save a draft email, kind gmail.new, to pat@example.com, subject Lunch, body Lunch is at noon. The user has not approved sending it. Return the saved draft summary.",
  systemPrompt: buildExecutionPrompt([]),
  model:"gpt-6-luna", reasoningEffort:"low", mode:"execution", tools:draftTools,
});
assert(staged.includes("save_draft"));
console.log(JSON.stringify({name:"stage-action",passed:true,usage:result.usage}));
