# Saved notes and collections

Explicit saves live in `savedItems` and `savedCollections`, separately from
personal memory. Memory cleanup and consolidation never rewrite or prune them.
Saved items keep the original note/caption, title, status, recommender, links,
image references, source conversation, and timestamps until explicitly deleted.
The default collections are created on first use: **Notes** for `/remember`
and **Inbox** for Telegram shares. Names are case-insensitive.

## Use it

- `/remember Sam recommended Arrival. We talked about it over dinner.` saves
  the complete note to Notes without a model call on the capture path.
- “Add Arrival and Past Lives to Movies. Sam recommended both. Mark them
  want-to-watch.” creates separate items through the assistant's saved tools.
- “Show every movie in Movies” uses paginated collection listing, not top-k
  memory recall. “Mark Arrival watched” updates the existing item.
- “Find the note about dinner” searches saved titles, note text, recommenders,
  and links using full-text search. Exact wording and collection listing remain
  available even when semantic memory has forgotten the conversation.
- Open **Saved** in the dashboard to create notes/collections, browse, search,
  edit full text, change status, move items, open images/links, and delete items.
  Use **Load more items** to continue through the entire library.

Saved records are shared across this single-owner Boop instance, including its
messaging channels. They are hidden in dashboard demo mode. This feature uses
the existing deployment access model; it does not add multi-user authentication.

## Telegram links and screenshots

Send or forward a link, photo, or screenshot to your private bot. Valid HTTP(S)
links, including Telegram's hidden text-link targets, are preserved. Photos and
image documents support JPEG, PNG, WebP, and GIF, up to 10 MiB. The largest photo
variant supplied by Telegram is used. Each album message is a separate save.

Shared content lands in Inbox before a success acknowledgement. Bare links and
captionless screenshots are captured without a model call. Captions can ask
Boop to analyze an image or move the saved item to another collection. A
`/remember ...` caption or link-containing note saves directly to Notes.
Transport update IDs deduplicate replayed captures. Existing Telegram
checkpoint limitations still apply to subsequent assistant actions.

Screenshots remain viewable in Saved and are protected from chat-image cleanup.
There is no automatic OCR/indexing of captionless images or automatic webpage
archiving: search matches the saved text/caption and URLs. Add a descriptive
caption or ask Boop to describe and organize the screenshot when sharing it.
An ordinary message containing a link is also saved to Inbox before Boop answers.
Say “don't save this” to skip the library save for a one-off link/image request;
images used for that request still follow ordinary chat-image retention.
Voice notes and transcription are not included.

Deleting an item removes its library record. Referenced blobs can also belong
to chat or personal memory; existing image cleanup reclaims eligible chat
attachments when no saved item or memory anchors them. Deleting a saved item
does not erase facts already extracted into personal memory or chat history.
Existing raw notes from older versions remain in memory; they are not silently
migrated or removed by this change.

## Deployment

No new API keys or packages are required. Deploy the additive Convex schema and
functions to the same deployment your Boop server uses, then restart the server
and rebuild/restart the dashboard. For a configured development checkout:

```sh
npx convex dev --once
npm run build:debug
```

For production, use the existing `npm run deploy:convex` deployment workflow.
Do not run a second Telegram poller against the same bot token.
