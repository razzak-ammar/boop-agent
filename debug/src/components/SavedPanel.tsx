import { useState } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import type { Doc, Id } from "../../../convex/_generated/dataModel.js";
import { PanelPage, panelCardClass } from "./PanelPrimitives.js";

function SavedImage({ id }: { id: Id<"_storage"> }) {
  const url = useQuery(api.messages.getStorageUrl, { storageId: id });
  return url ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="Saved attachment" className="max-h-60 max-w-full rounded-lg border border-zinc-500/20" /></a> : <p>Image unavailable</p>;
}

function ItemEditor({ item, collection, onClose, isDark }: {
  item: Doc<"savedItems">; collection: string; onClose: () => void; isDark: boolean;
}) {
  const [title, setTitle] = useState(item.title);
  const [content, setContent] = useState(item.content);
  const [status, setStatus] = useState(item.status);
  const [recommendedBy, setRecommendedBy] = useState(item.recommendedBy ?? "");
  const [destination, setDestination] = useState(collection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = useMutation(api.savedItems.update);
  const remove = useMutation(api.savedItems.remove);
  const field = `w-full rounded-lg border p-2 text-sm ${isDark ? "border-white/10 bg-black/20" : "border-zinc-200 bg-white"}`;
  async function save() {
    setBusy(true); setError("");
    try {
      await update({ id: item._id, title, content, status, recommendedBy,
        ...(destination.trim() ? { collection: destination } : {}) });
      onClose();
    } catch { setError("Couldn't save changes. Check the fields and try again."); }
    finally { setBusy(false); }
  }
  async function deleteItem() {
    if (!confirm("Delete this saved item?")) return;
    setBusy(true); setError("");
    try { await remove({ id: item._id }); onClose(); }
    catch { setError("Couldn't delete this item. Please try again."); }
    finally { setBusy(false); }
  }
  return <form className="mt-4 space-y-3 border-t border-zinc-500/20 pt-4" onSubmit={event => { event.preventDefault(); void save(); }}>
    <label className="block text-xs">Title<input className={field} value={title} onChange={event => setTitle(event.target.value)} required maxLength={300} /></label>
    <label className="block text-xs">Full note<textarea className={`${field} min-h-36`} value={content} onChange={event => setContent(event.target.value)} maxLength={100_000} /></label>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-xs">Collection<input className={field} value={destination} onChange={event => setDestination(event.target.value)} placeholder="Keep current collection" maxLength={100} /></label>
      <label className="text-xs">Status<input className={field} value={status} onChange={event => setStatus(event.target.value)} required maxLength={60} /></label>
      <label className="text-xs">Recommended by<input className={field} value={recommendedBy} onChange={event => setRecommendedBy(event.target.value)} /></label>
    </div>
    {item.urls.map(url => <a className="block break-all text-sm text-sky-500 underline" key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}
    <div className="flex flex-wrap gap-3">{item.imageStorageIds.map(id => <SavedImage id={id} key={id} />)}</div>
    <p className="text-xs text-zinc-500">Saved {new Date(item.createdAt).toLocaleString()} · {item.sourceConversationId.startsWith("telegram:") ? "Telegram" : item.sourceConversationId === "dashboard" ? "Dashboard" : "Chat"}</p>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    <div className="flex gap-4 text-sm">
      <button disabled={busy} className="rounded-lg bg-violet-600 px-3 py-2 text-white disabled:opacity-50">Save changes</button>
      <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" disabled={busy} className="ml-auto text-red-500" onClick={() => void deleteItem()}>Delete</button>
    </div>
  </form>;
}

export function SavedPanel({ isDark, demoMode = false }: { isDark: boolean; demoMode?: boolean }) {
  const [collection, setCollection] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newCollection, setNewCollection] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const createCollection = useMutation(api.savedItems.createCollection);
  const saveItem = useMutation(api.savedItems.save);
  const collections = usePaginatedQuery(api.savedItems.listCollections, demoMode ? "skip" : {}, { initialNumItems: 50 });
  const items = usePaginatedQuery(api.savedItems.list, demoMode ? "skip" : {
    ...(collection ? { collection } : {}), ...(status.trim() ? { status: status.trim() } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  }, { initialNumItems: 30 });
  const names = new Map(collections.results.map(row => [row._id, row.name]));
  const field = `rounded-lg border p-2 text-sm ${isDark ? "border-white/10 bg-[#202024]" : "border-zinc-200 bg-white"}`;
  async function addCollection() {
    setBusy(true); setError("");
    try { await createCollection({ name: newCollection }); setCollection(newCollection.trim()); setNewCollection(""); }
    catch { setError("Couldn't create collection. Use a name of 1–100 characters."); }
    finally { setBusy(false); }
  }
  async function addNote() {
    setBusy(true); setError("");
    try {
      await saveItem({ collection: collection || "Notes", title, content, kind: "note", sourceConversationId: "dashboard" });
      setTitle(""); setContent(""); setAddingNote(false);
    } catch { setError("Couldn't save note. Please try again."); }
    finally { setBusy(false); }
  }
  return <PanelPage eyebrow="Library" title="Saved" description="Notes, links, screenshots, and collections. Kept until you delete them.">
    {demoMode ? <p className="text-sm text-zinc-500">Your saved library is hidden in demo mode.</p> : <>
      <div className="flex flex-wrap gap-2">
        <button className={`${field} ${!collection ? "ring-1 ring-violet-500" : ""}`} onClick={() => setCollection("")}>All saved</button>
        {collections.results.map(row => <button key={row._id} className={`${field} ${collection === row.name ? "ring-1 ring-violet-500" : ""}`} onClick={() => setCollection(row.name)}>{row.name}</button>)}
        {collections.status === "CanLoadMore" && <button className={field} onClick={() => collections.loadMore(50)}>More collections</button>}
      </div>
      <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void addCollection(); }}>
        <input aria-label="New collection name" className={`${field} min-w-0 flex-1`} placeholder="New collection, e.g. Movies" value={newCollection} onChange={event => setNewCollection(event.target.value)} maxLength={100} required />
        <button className={field} disabled={busy}>Create collection</button>
      </form>
      <div className="flex flex-wrap gap-2">
        <input className={`${field} w-full min-w-0 sm:w-auto sm:flex-1`} aria-label="Search saved items" placeholder="Search notes, titles, or recommenders…" value={search} onChange={event => setSearch(event.target.value)} />
        <input className={field} aria-label="Filter by exact status" placeholder="Status, e.g. watched" value={status} onChange={event => setStatus(event.target.value)} />
        <button className={field} onClick={() => setAddingNote(!addingNote)}>New note</button>
      </div>
      {addingNote && <form className={panelCardClass(isDark, "space-y-3 p-4")} onSubmit={event => { event.preventDefault(); void addNote(); }}>
        <p className="text-sm">Save to {collection || "Notes"}</p>
        <input className={`${field} w-full`} aria-label="Note title" placeholder="Title" value={title} onChange={event => setTitle(event.target.value)} maxLength={300} required />
        <textarea className={`${field} min-h-32 w-full`} aria-label="Note content" placeholder="Full note" value={content} onChange={event => setContent(event.target.value)} maxLength={100_000} />
        <button className={field} disabled={busy}>Save note</button>
      </form>}
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      {items.status === "LoadingFirstPage" ? <p className="text-sm text-zinc-500">Loading saved items…</p> : !items.results.length ? <p className="py-10 text-sm text-zinc-500">No saved items here yet. Add a note, text /remember to Boop, or share a link or screenshot.</p> :
        <div className="space-y-3">{items.results.map(item => <article key={item._id} className={panelCardClass(isDark, "p-4")}>
          <button className="w-full text-left" aria-expanded={expanded === item._id} onClick={() => setExpanded(expanded === item._id ? null : item._id)}>
            <div className="flex justify-between gap-3"><span className="font-medium">{item.title}</span><span className="text-xs text-zinc-500">{item.status}</span></div>
            <p className="mt-1 text-xs text-zinc-500">{names.get(item.collectionId) ?? "Collection"} · {item.kind}{item.recommendedBy ? ` · ${item.recommendedBy}` : ""}</p>
            <p className="mt-2 line-clamp-2 whitespace-pre-wrap break-words text-sm text-zinc-500">{item.content}</p>
          </button>
          {expanded === item._id && <ItemEditor key={item._id} item={item} collection={names.get(item.collectionId) ?? collection} onClose={() => setExpanded(null)} isDark={isDark} />}
        </article>)}</div>}
      {items.status === "CanLoadMore" && <button className={field} onClick={() => items.loadMore(30)}>Load more items</button>}
      {items.status === "LoadingMore" && <p className="text-sm text-zinc-500">Loading more…</p>}
    </>}
  </PanelPage>;
}
