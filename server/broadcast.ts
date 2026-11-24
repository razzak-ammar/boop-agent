import type { WebSocket } from "ws";

type Client = WebSocket;
type Listener = (event: string, data: unknown) => void;
const clients = new Set<Client>();
const listeners = new Set<Listener>();

export function addClient(ws: Client): void {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
}

// In-process listeners (the iOS app's event streams). Returns an unsubscribe.
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function broadcast(event: string, data: unknown): void {
  const payload = JSON.stringify({ event, data, at: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
  for (const listener of listeners) {
    try {
      listener(event, data);
    } catch (err) {
      console.error("[broadcast] listener failed", err);
    }
  }
}
