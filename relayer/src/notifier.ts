// ─────────────────────────────────────────────────────────────────────────────
// Phantom Pool Relayer — Notification Service
// ─────────────────────────────────────────────────────────────────────────────
// Central pub/sub hub so prover/submitter can notify connected WebSocket clients
// and the rest of the relayer can listen for internal events.

import type { WsEvent, WsEventType } from "./types.js";

type Listener = (event: WsEvent) => void;

class Notifier {
  private readonly listeners = new Map<string, Set<Listener>>();
  // WebSocket clients — keyed by a random ID
  private readonly wsClients = new Map<string, { send: (msg: string) => void }>();

  // ── Internal pub/sub ──────────────────────────────────────────────────────
  on(type: WsEventType | "*", listener: Listener): () => void {
    const key = type as string;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(listener);
    return () => this.listeners.get(key)?.delete(listener);
  }

  emit(event: WsEvent): void {
    // Specific type listeners
    this.listeners.get(event.type)?.forEach((l) => l(event));
    // Wildcard listeners
    this.listeners.get("*")?.forEach((l) => l(event));
    // Broadcast to all WS clients
    const msg = JSON.stringify(event);
    for (const [id, client] of this.wsClients) {
      try {
        client.send(msg);
      } catch {
        // Dead client — remove
        this.wsClients.delete(id);
      }
    }
  }

  // ── WebSocket client management ───────────────────────────────────────────
  addWsClient(id: string, send: (msg: string) => void): void {
    this.wsClients.set(id, { send });
    console.log(`[notifier] WS client connected: ${id} (total: ${this.wsClients.size})`);
  }

  removeWsClient(id: string): void {
    this.wsClients.delete(id);
    console.log(`[notifier] WS client disconnected: ${id} (total: ${this.wsClients.size})`);
  }

  wsClientCount(): number {
    return this.wsClients.size;
  }
}

// Singleton
export const notifier = new Notifier();
