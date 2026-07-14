import { EventEmitter } from "node:events";

/**
 * Tiny in-process event bus used to push live updates to the dashboard (SSE).
 * Single-process only — good enough for this service. If you later scale to
 * multiple instances, back this with Redis pub/sub.
 */

export type BusEvent =
  | { type: "call.created"; call: unknown }
  | { type: "call.updated"; call: unknown }
  | { type: "call.transcript"; callId: string; turn: unknown }
  | { type: "agent.updated"; agent: unknown }
  | { type: "voicelink.link"; link: unknown }
  | { type: "log"; level: string; message: string };

class Bus extends EventEmitter {
  emitEvent(e: BusEvent) {
    this.emit("event", e);
  }
  onEvent(fn: (e: BusEvent) => void) {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(1000);
