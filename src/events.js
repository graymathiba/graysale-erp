// Real-time event hub: SSE (Server-Sent Events) for multi-device sync.
// Zero external dependencies — uses native node:http.
// One event hub instance is shared across all API routes.
// Clients connect via GET /api/v1/events and receive live broadcasts.
import { EventEmitter } from 'node:events';

class EventHub extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.clients = new Set();
  }

  // Register an SSE client. Calls onEvent(event, data) as they arrive.
  // Returns an unsubscribe function to remove the client.
  subscribe(onEvent) {
    const client = { onEvent, alive: true };
    this.clients.add(client);
    return () => {
      this.clients.delete(client);
    };
  }

  // Broadcast an event to all connected clients.
  broadcast(event, data) {
    this.emit(event, data);
    for (const c of this.clients) {
      if (c.alive) {
        try { c.onEvent(event, data); } catch (_) { this.clients.delete(c); }
      }
    }
  }

  get clientCount() {
    return this.clients.size;
  }
}

export { EventHub };
