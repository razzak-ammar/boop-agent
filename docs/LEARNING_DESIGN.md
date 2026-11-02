# Learning from corrections in Boop

Status: implementation proposal, 2026-11-02. No runtime changes or model switches are made by this document.

## Decision

Give Boop a persistent, versioned library of task procedures, informed by verified corrections. Keep it separate from personal memory and saved items. Before activating a learned procedure, replay relevant regression cases against simulated tools. Load the active procedure on subsequent turns and pass its revision to workers.

Also strengthen execution contracts. A procedure can improve tool use; it cannot guarantee correctness when an API accepts contradictory timestamps or a reply claims success without checking the saved record.

The target loop is:

```text
turn + tool evidence → incident → candidate procedure → isolated replay
                                           ↓ pass
next relevant turn ← active version ← atomic promotion
        ↓
typed action → read-back verification → factual receipt → outcome evidence
```

## What Hermes actually does

Research baseline: NousResearch/hermes-agent revision `fbf6c6c91d8a9ce3008e05c4b51ca60ad05bb85f`. These are observations of that revision, not guarantees about every installation.

| Mechanism | Observed behavior | Boop adaptation |
| --- | --- | --- |
| Procedural learning | Skills capture reusable task methods and corrections; personal facts have separate memory stores. | Separate procedure records from decaying memory and user-saved notes. |
| Editing | The agent can create or patch skills; guidance favors an existing relevant skill over a new incident-specific one. | Version a small set of workflow procedures, with provenance and deduplication. |
| Background review | A post-turn fork reviews a conversation snapshot when triggered; dispatch enforces a restricted tool whitelist. | Durable bounded review jobs with no access to external write tools. |
| Freshness | Background edits require a fresh view of the target skill. | Read revision, then compare-and-swap promotion; reject stale edits. |
| Discovery | Skills load on demand. Catalog change notifications have runtime-specific exceptions. | Fetch active matching revisions each turn for both Boop runtimes. |
| Maintenance | Curator handles recoverable archiving; model-based consolidation is opt-in. | Auditable retirement/rollback; pin essential correctness procedures. |

Sources: [skills documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills), [background review implementation](https://github.com/NousResearch/hermes-agent/blob/fbf6c6c91d8a9ce3008e05c4b51ca60ad05bb85f/agent/background_review.py), [fresh-read guards](https://github.com/NousResearch/hermes-agent/blob/fbf6c6c91d8a9ce3008e05c4b51ca60ad05bb85f/tools/skill_manager_guards.py), [skill mutation implementation](https://github.com/NousResearch/hermes-agent/blob/fbf6c6c91d8a9ce3008e05c4b51ca60ad05bb85f/tools/skill_manager_tool.py), [catalog delta implementation](https://github.com/NousResearch/hermes-agent/blob/fbf6c6c91d8a9ce3008e05c4b51ca60ad05bb85f/agent/skills_index_delta.py), [curator documentation at this revision](https://github.com/NousResearch/hermes-agent/blob/fbf6c6c91d8a9ce3008e05c4b51ca60ad05bb85f/website/docs/user-guide/features/curator.md).

Two limits matter. Persisting a skill does not prove the agent will follow it. In the inspected background learning path, editing a procedure does not automatically replay the failed task against ground truth. Boop should add that gate. Also, avoid the review prompt's pressure to produce frequent updates: an evidence-based no-change outcome is useful.

## What Boop has today

- `server/memory/extract.ts` extracts facts from the user message and assistant reply. It does not receive a complete structured tool trace. A model apology alone is weak evidence of a defect.
- `server/consolidation.ts` cleans up factual memories; it is not a procedural learning loop.
- Dispatcher journal previews and worker logs truncate inputs/results. They are insufficient as the authoritative evidence for replay and verification.
- Runtime-neutral tools already provide a suitable integration boundary. Codex's isolated runtime homes make a global filesystem skill directory a poor source of truth.
- Reminder receipts and deterministic calendar search already reduce specific failure modes. The time-tracker incident shows that prompt guidance alone still permits invalid conversions.

Keep saved notes/collections unchanged: “movies recommended to me” is user content. “How to add an overnight time entry correctly” is a procedure. “My timezone is America/New_York” is a personal setting/fact.

## Layer 1: make actions verifiable

Implement this before claiming autonomous learning fixes the reported failures.

### Time tracker

Expose local intent fields: start date, wall-clock time, end date/time and IANA timezone. Resolve them with deterministic code. Return a resolution ID bound to the normalized interval and intent hash; writes consume that ID rather than model-authored UTC strings. A changed intent invalidates the ID.

Use an explicit ambiguity result for omitted AM/PM when context cannot resolve it, and for DST folds/gaps. Do not silently guess. Keep raw timestamp endpoints internal to the trusted adapter.

After writing, fetch the row by ID and compare its instants, duration and relevant fields with the resolved intent. Generate the confirmation from this verified result in the user's timezone. A mismatch produces a failure result, never “Fixed!”; an authorized repair can retry the same intended update, with duplicate protection.

For the reported example, Nov 1, 2026 22:30 through Nov 2 00:20 in America/New_York is `2026-11-02T03:30:00.000Z` through `2026-11-02T05:20:00.000Z`, duration 110 minutes. Relabeling those UTC clock values with `-05:00` changes the interval and must fail verification.

### Reminders and calendar search

Retain local-date resolution and deterministic reminder receipts. Track scheduling and delivery as separate outcomes; learning from a scheduling correction does not establish notification delivery reliability. Record runner claim, attempt, provider result and retry/failure state to diagnose missed alerts.

Keep calendar coverage, pagination and per-term earliest results explicit. A partial search cannot support “there are none.” Procedures should teach use of the structured search, while code supplies completeness evidence.

## Layer 2: persistent procedures

Use Convex as the authoritative store. Optional SKILL.md export can follow later.

| Record | Core fields |
| --- | --- |
| `learningIncidents` | conversation/turn IDs, parent-worker linkage, workflow, evidence references, expected/observed facts, kind, status: suspected/verified/resolved/needs-engineering |
| `procedureSkills` | stable slug, workflow, tool triggers, description, active revision ID, pinned/locked state |
| `procedureRevisions` | immutable body, base revision ID, source incidents, content hash, tool schema version, candidate/validated/active/retired state, replay references |
| `learningReviews` | unique incident/revision key, queued/running/done/no-change/failed, lease token/expiry, attempts, usage, reason |
| `learningReplays` | fixture ID, typed parameters, expected invariants, baseline/candidate results, runtime/model/settings, procedure and tool-schema hashes |
| structured action traces | turn/action/parent IDs, tool name/version, bounded arguments/results, truncation markers or protected evidence references, verification facts, timestamps |

Preserve enough evidence to reconstruct date conversions and selected record IDs. Apply existing user isolation and bounded retention; exclude credentials and unrelated content. Truncated previews must never masquerade as complete tool evidence. A replay must not need unrestricted access to the user's entire history.

Start with three procedures: time tracking, reminders, calendar search. Each contains scope, tool sequence, ambiguity handling, verification and known pitfalls. Generalize the mechanism, never incidental values: “resolve local wall time with the resolver,” not “always use 10:30 PM.”

Always include a small fixed set of execution invariants. Select up to three relevant active procedures using workflow/tool metadata, with a bounded prompt budget. Log the loaded revision IDs. Workers inherit the selected revision snapshot; the next turn fetches the newest active revision. Do not rely on a model deciding to reread a changed file.

## Layer 3: bounded learning reviewer

1. Detect candidates from explicit user corrections, deterministic verification failures and recovered tool failures. Preserve the failure-to-repair sequence across turns.
2. Enqueue a durable job after the foreground turn. A user challenge opens an investigation; it does not automatically establish that the user or the assistant is correct.
3. Reviewer reads the evidence and existing relevant procedure. It can return no-change, propose a scoped revision, or flag a code defect as needs-engineering.
4. Validate provenance, scope, conflicts, length and duplication. Treat retrieved documents/screenshots/tool text as evidence, not instructions to modify Boop.
5. Run the candidate through trusted fixture templates using isolated simulated tools. Compare baseline and candidate on the same fixtures. No generated arbitrary code is executed.
6. Promote only with verified evidence, passing workflow fixtures and no regression on critical invariants. Use an atomic transaction checking the base revision, schema version and replay hashes.
7. Record the result and make it available on the next relevant turn. Allow inspection and “undo that learned rule”; preserve prior revisions.

The reviewer gets only incident reads, procedure reads and candidate proposal tools. Enforce this in dispatch, not just the prompt. It cannot send messages, edit real entries, change credentials/model settings, rewrite base instructions or invoke terminal/code deployment tools. Permission changes and source patches are outside automatic procedure promotion.

Proposed initial budget: one review per conversation, at most three model calls, 12k input tokens in aggregate, 2k output tokens, a 60-second deadline and configurable daily quota. Debounce the correction sequence until evidence is settled. Foreground work has priority. Leases and idempotency let a crashed process resume safely without duplicate promotion. These are Boop starting limits, not Hermes defaults.

If the problem is in backend code, save a precise engineering incident with a reproduction. Do not report it as learned/fixed merely because a skill says to avoid it. An isolated patch proposal and test pipeline could be a later capability.

## Initial replay suite

| Case | Required outcome |
| --- | --- |
| Yesterday 10:30–11:59 with unresolved AM/PM | Ask for the missing distinction; no write |
| Explicit overnight Nov 1 22:30 → Nov 2 00:20 | Resolve to 03:30Z → 05:20Z; 110 minutes; verify read-back |
| UTC clock values incorrectly tagged -05:00 | Reject mismatch; no false success receipt |
| DST repeated/nonexistent wall time | Surface ambiguity/invalidity through resolver |
| Local today differs from UTC date | Reminder uses the user's intended local day |
| Future reminder followed by “you missed it” prose | Receipt remains consistent with actual schedule |
| Unsorted, all-day exam events across hidden/paginated calendars | Earliest correct results; complete coverage or explicit partial result |
| User challenges an already-correct UTC interval | Inspect evidence before changing data or accepting blame |
| Candidate says always choose PM | Reject overgeneralization |
| Repeated same correction | Update relevant procedure; no duplicate skill |
| New turn and delegated worker after promotion | Correct active revision is loaded and logged |
| Stale candidate, restart, cancellation, attempted external write | CAS rejection, job recovery, foreground priority, dispatch denial |

A passing finite suite provides evidence, not a guarantee for arbitrary future requests. New verified failures extend the suite through typed fixture parameters; unknown failure classes remain candidates for engineering review.

## Implementation order

1. **Action foundation:** normalized local-time intent, resolution IDs, read-back verification, idempotency and structured receipts/traces. Seed timezone and overnight tests. This is the first implementation slice.
2. **Procedure registry:** versioned records, incident capture, runtime-neutral read/propose tools, deterministic scoped loading and debug inspection/rollback. Seed the three initial procedures from known verified cases.
3. **Learning loop:** durable queue, evidence adjudication, bounded reviewer, trusted replay runner and atomic gated promotion. Start in shadow mode to measure proposed lessons before enabling automatic activation.
4. **Maintenance:** measure recurrence and usefulness; merge duplicate proposals and retire superseded revisions recoverably. Never age out pinned execution invariants merely because they are rarely exercised.

Likely integration points: new `server/learning/{trace,incidents,select,tools,review,replay}.ts`, corresponding Convex record modules and validators, `server/interaction-agent.ts`, `server/execution-agent.ts`, prompt construction, the server job loop, and usage accounting sources for review/replay. Read Convex guidelines before implementing schema/functions.

## Model choice and success criteria

Keep Luna medium as the measured baseline and compare high reasoning using the same replay cases, tool schemas and procedure revisions. Record correctness, clarification quality, latency and token cost. Change the setting only if the measured benefit is worthwhile. More reasoning does not enforce timezone conversion or prove that an external write succeeded.

Track unassisted verified task completion, repeated corrections by workflow, recurrence after promotion, procedure loading rate, regressions/rollbacks and review cost. Avoid rewarding the number of skills or apologies. The user-facing success condition is that Boop handles the next analogous task correctly without requiring another Codex intervention.
