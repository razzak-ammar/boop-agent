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
