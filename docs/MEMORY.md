# Personal memory and preferences

Personal memory stores facts about the user, scoped preferences, relationships and ongoing projects. Saved notes, movie lists, links and screenshots belong in the separate saved library. This change does not add procedural self-improvement or switch models.

## Recall across turns

Dispatcher turns and execution workers load a bounded active profile automatically. It considers the latest 300 records in each of identity, preference and correction, keeps up to 15 active non-demo records per segment, and includes up to 8,000 characters. Background context cannot crowd these segments out. Other relevant facts remain available through `recall`; the profile is not an exhaustive memory dump.

Stored context is framed as data, with the current user message taking precedence. Preferences apply only within their saved scope. For example, “brief work updates” does not mean “brief explanations of every subject.”

## Saving and changing preferences

`write_memory` supports the correction segment and defaults new preferences and durable personal corrections to permanent retention. The decay cleaner also protects legacy active preferences/corrections. They can still be explicitly superseded or forgotten; permanent does not mean immutable.

For “Actually, I prefer coffee instead of tea,” the agent recalls the old preference and saves the new fact with the old memory ID in `supersedes`. Archiving the old fact and storing its replacement occur in one mutation. A stale correction referencing an already-archived target is rejected rather than replacing the current belief. Unrelated details must be preserved.

Foreground and automatic writes request exact-text deduplication, ignoring whitespace and case, across the latest 500 active records. The tool confirms the actual stored ID after reading it back. This handles duplicate writes of the same sentence; semantic paraphrases still depend on extraction/consolidation.

## Automatic extraction

The extractor receives bounded existing candidates (profile plus recent active records, up to 16,000 characters). It can identify explicit replacements using those IDs. It must quote the user's actual words for every text fact; quotes are checked before persistence and saved with source-turn provenance. Image-description facts are the exception when an inbound image exists.

The prompt distinguishes standing defaults from one-time requests, excludes assistant-only claims and task repair narratives, and avoids re-extracting requests to forget. Parsing validates shapes, limits output count/length, removes duplicate facts and permits replacement IDs only from the provided candidates. Meaning and scope still require model judgment; a matching quote alone does not prove a valid interpretation.

## Forgetting

At the user's request, `forget_memory` archives recalled IDs, removing them from active profile/search. This is not permanent erasure of conversation history, retained archived records or backups, and it does not delete saved notes/collections. Restoring or restating a fact can make it available again; this is not a permanent suppression list.

## Verification and rollout

Regression coverage includes atomic replacement, preserving unrelated facts, stale correction rejection, duplicate writes, profile selection despite context volume, archive exclusion, evidence validation and bounded profile formatting. Tests run against local Convex simulation and mocked runtimes, without writing to the user's live memory.

Deploy the updated Convex functions before restarting the updated server: the profile query and new optional mutation arguments must exist first. There is no schema migration or automatic rewrite of historical memories. Historical conflicts are corrected when explicitly superseded or through existing consolidation.
