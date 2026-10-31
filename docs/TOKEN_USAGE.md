# Understanding Boop's token counts and estimates

The Agents screen reports usage for that worker, not the entire user message.
Dispatcher, memory extraction, and consolidation are recorded separately and
contribute to the dashboard total. Input usage includes instructions, tools,
and context on each model pass. It is not the number of words the user sent.
Cached input is a subset of input, never an additional token total.

## Calendar investigation — October 31, 2026

Original worker: 26,048 input + 71 output = 26,119 tokens (displayed as 26.1K).
12,800 of those input tokens were cached. Apple Calendar was not enabled; the
dispatcher silently removed the requested integration and started a worker
with no calendar access. The user intends to connect Google Calendar.

Controlled no-action measurements on the Oracle server (Codex CLI 0.166.0,
GPT-6 Luna, low reasoning, isolated workspace):

| Request | Input tokens | Output tokens |
| --- | ---: | ---: |
| Minimal instructions, reply OK, no tools, background mode | 9,420 | 5 |
| Boop worker instructions, reply OK, no tools, execution mode | 12,695 | 5 |
| Calendar request, worker instructions, draft tool | 26,087 | 62 |
| Same calendar request without draft tool | 25,487 | 53 |

Another calendar run emitted cumulative input totals of 12,717 then 25,489,
with output totals of 31 then 59; the latter included 12,544 cached input.
This confirms two model passes with approximately 13K input each. The token
handler replaces its totals on each notification; it does not sum already
cumulative notifications. Removing the small draft tool alone does not remove
the runtime's substantial instruction overhead or repeated context.
These measurements are observations, not a guaranteed fixed per-call cost.

Unavailable requested integrations now fail before starting a worker, rather
than silently losing the capability and paying for a predictable failure.
General research workers with no requested integrations remain supported.

## Cost reporting

Standard API token rates were checked against the official pricing page on
October 31, 2026. Luna rates per million: $0.10 input, $0.01 cached input,
$0.50 output. The original worker's API equivalent is:

    ((26,048 - 12,800) * 0.10 + 12,800 * 0.01 + 71 * 0.50) / 1,000,000
    = $0.0014883

This is **not a subscription charge or a Plus allowance estimate**. Check
[ChatGPT usage](https://chatgpt.com/codex/settings/usage) for actual limits.
Separately priced tools are excluded from this token-only comparison.

Current model prices and calculations live in `server/token-pricing.ts`, shared
by the runtime, dashboard, and Convex queries. Historical Codex rows saved as
zero are recalculated on read, without rewriting logs. Unknown model prices
show “Cost unavailable”; aggregate totals flag excluded unknown-price rows.
New similarly named model variants never inherit another model's price unless
they are explicit dated snapshots. SDK-reported Claude costs remain unchanged.

Sources: [API pricing](https://developers.openai.com/api/docs/pricing),
[Codex subscription pricing](https://learn.chatgpt.com/docs/pricing).

## Context optimizations — October 31, 2026

Boop now supplies an application-specific Codex base prompt instead of the
coding-agent default, uses a shorter dispatcher policy, and only includes
Apple/browser worker guidance for the selected integrations. Memory, citations,
source privacy, images, recurring reminders, timezone confirmation, and draft
approval policies remain. The runtime's sandbox and tool allowlists are unchanged.
The underlying model and low reasoning setting are unchanged.

The dispatcher receives the saved, validated user timezone/current local time
as application context. It need not run a model/tool round trip just to obtain
the clock. An unset timezone remains null, rather than the server's timezone.
Proactive notices have a dedicated short prompt. Only an exact whitelist of
social filler skips the backup memory extractor; substantive text, corrections,
and images still use it. Tool schemas and conversation history are retained.

Live fixture checks on Oracle, with all application effects replaced by in-memory
handlers, compared the existing deployment with the optimized candidate:

| Fixture | Previous dispatcher input | Optimized dispatcher input |
| --- | ---: | ---: |
| Five personal facts in a paragraph | 44,770 | 18,302 |
| Recall location and calendar preference | 29,653 | 18,166 |

The paragraph test retained all five facts with write_memory; the backup
extractor independently retained all five. Recurring scheduling, unknown-zone
clarification, listing/approving the exact draft ID, and staging an unapproved
action also passed. Draft listings now return named JSON fields so the model
does not confuse a draft's kind with its ID. These are representative smoke
checks, not a guarantee that every future model response is identical.

The optimized standalone extractor used 5,923 input tokens for the test paragraph.
There is still a several-thousand-token Codex harness floor, and multi-step work
can still exceed 26K cumulative tokens. These changes do not impose context or
output truncation, reduce reasoning, disable extraction for personal paragraphs,
or bypass required approvals to force a token target.

The live check is opt-in and consumes Codex allowance:

    node --import tsx scripts/check-codex-behavior.ts

It uses synthetic information and fixture handlers, not real account actions.
Use `--case personal-paragraph` to focus a check. A previous checkout with the
original inline dispatcher prompt can be compared with `--baseline-root /path`.
