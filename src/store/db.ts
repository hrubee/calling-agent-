import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { logger } from "../logger";
import type { Agent, Call, DBShape, NumberRec, Settings } from "./types";

const MAX_CALLS = 5000;

function nowIso() {
  return new Date().toISOString();
}

function defaultDB(): DBShape {
  const t = nowIso();
  const agent: Agent = {
    id: randomUUID(),
    name: "Assistant",
    systemPrompt:
      "You are a warm, concise voice assistant for phone calls. Speak naturally, " +
      "one or two short sentences at a time. Ask clarifying questions when needed and " +
      "confirm important details. Never mention that you are an AI unless asked.",
    greeting: "Hello! Thanks for calling. How can I help you today?",
    language: config.defaultLanguage,
    ttsModel: config.sarvam.ttsModel,
    ttsSpeaker: config.sarvam.ttsSpeaker,
    temperature: 0.4,
    maxTokens: 200,
    createdAt: t,
    updatedAt: t,
  };
  return {
    agents: [agent],
    numbers: [],
    calls: [],
    settings: { defaultAgentId: agent.id, updatedAt: t },
  };
}

class Store {
  private data: DBShape;
  private readonly file: string;
  private writeTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor() {
    mkdirSync(config.dataDir, { recursive: true });
    this.file = join(config.dataDir, "db.json");
    if (existsSync(this.file)) {
      try {
        this.data = JSON.parse(readFileSync(this.file, "utf8"));
        // Backfill any missing top-level keys from older versions.
        const d = defaultDB();
        this.data.agents ??= d.agents;
        this.data.numbers ??= d.numbers;
        this.data.calls ??= d.calls;
        this.data.settings ??= d.settings;
        logger.info(
          { agents: this.data.agents.length, calls: this.data.calls.length },
          "store loaded",
        );
      } catch (err) {
        logger.error({ err }, "failed to parse db.json — starting fresh");
        this.data = defaultDB();
        this.flush();
      }
    } else {
      this.data = defaultDB();
      this.flush();
      logger.info({ file: this.file }, "store initialized with a default agent");
    }
  }

  /** Debounced atomic persist. */
  private persist() {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      if (this.dirty) this.flush();
    }, 250);
  }

  private flush() {
    this.dirty = false;
    const tmp = this.file + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.file);
    } catch (err) {
      logger.error({ err }, "failed to write db.json");
    }
  }

  /** Force a synchronous flush (used on shutdown). */
  flushSync() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.flush();
  }

  // ---- Agents ----
  listAgents(): Agent[] {
    return this.data.agents.slice().sort((a, b) => a.name.localeCompare(b.name));
  }
  getAgent(id: string): Agent | undefined {
    return this.data.agents.find((a) => a.id === id);
  }
  createAgent(input: Partial<Agent> & { name: string }): Agent {
    const t = nowIso();
    const agent: Agent = {
      id: randomUUID(),
      name: input.name,
      systemPrompt: input.systemPrompt ?? "You are a helpful voice assistant.",
      greeting: input.greeting ?? "Hello! How can I help you?",
      language: input.language ?? config.defaultLanguage,
      ttsModel: input.ttsModel ?? config.sarvam.ttsModel,
      ttsSpeaker: input.ttsSpeaker ?? config.sarvam.ttsSpeaker,
      transferNumber: input.transferNumber,
      temperature: input.temperature ?? 0.4,
      maxTokens: input.maxTokens ?? 200,
      createdAt: t,
      updatedAt: t,
    };
    this.data.agents.push(agent);
    this.persist();
    return agent;
  }
  updateAgent(id: string, patch: Partial<Agent>): Agent | undefined {
    const a = this.getAgent(id);
    if (!a) return undefined;
    Object.assign(a, patch, { id: a.id, createdAt: a.createdAt, updatedAt: nowIso() });
    this.persist();
    return a;
  }
  deleteAgent(id: string): boolean {
    const n = this.data.agents.length;
    this.data.agents = this.data.agents.filter((a) => a.id !== id);
    if (this.data.settings.defaultAgentId === id) {
      this.data.settings.defaultAgentId = this.data.agents[0]?.id;
    }
    this.data.numbers.forEach((num) => {
      if (num.agentId === id) num.agentId = undefined;
    });
    this.persist();
    return this.data.agents.length < n;
  }

  // ---- Numbers (DIDs) ----
  listNumbers(): NumberRec[] {
    return this.data.numbers.slice();
  }
  getNumberByDid(did: string): NumberRec | undefined {
    const norm = (s: string) => s.replace(/[^\d]/g, "");
    return this.data.numbers.find((n) => norm(n.number) === norm(did));
  }
  createNumber(input: { number: string; label?: string; agentId?: string }): NumberRec {
    const t = nowIso();
    const rec: NumberRec = {
      id: randomUUID(),
      number: input.number,
      label: input.label,
      agentId: input.agentId,
      createdAt: t,
      updatedAt: t,
    };
    this.data.numbers.push(rec);
    this.persist();
    return rec;
  }
  updateNumber(id: string, patch: Partial<NumberRec>): NumberRec | undefined {
    const n = this.data.numbers.find((x) => x.id === id);
    if (!n) return undefined;
    Object.assign(n, patch, { id: n.id, createdAt: n.createdAt, updatedAt: nowIso() });
    this.persist();
    return n;
  }
  deleteNumber(id: string): boolean {
    const before = this.data.numbers.length;
    this.data.numbers = this.data.numbers.filter((n) => n.id !== id);
    this.persist();
    return this.data.numbers.length < before;
  }

  // ---- Calls ----
  listCalls(limit = 200): Call[] {
    return this.data.calls
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }
  getCall(id: string): Call | undefined {
    return this.data.calls.find((c) => c.id === id);
  }
  getCallByCallSid(callSid: string): Call | undefined {
    return this.data.calls.find((c) => c.callSid === callSid);
  }
  createCall(input: Partial<Call> & { direction: Call["direction"] }): Call {
    const t = nowIso();
    const call: Call = {
      status: "initiated",
      transcript: [],
      ...input,
      id: randomUUID(),
      direction: input.direction,
      startedAt: input.startedAt ?? t,
      createdAt: t,
      updatedAt: t,
    } as Call;
    this.data.calls.push(call);
    // Bound the store size.
    if (this.data.calls.length > MAX_CALLS) {
      this.data.calls = this.data.calls
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, MAX_CALLS);
    }
    this.persist();
    return call;
  }
  updateCall(id: string, patch: Partial<Call>): Call | undefined {
    const c = this.getCall(id);
    if (!c) return undefined;
    Object.assign(c, patch, { id: c.id, createdAt: c.createdAt, updatedAt: nowIso() });
    this.persist();
    return c;
  }
  addTranscript(id: string, turn: Call["transcript"][number]): Call | undefined {
    const c = this.getCall(id);
    if (!c) return undefined;
    c.transcript.push(turn);
    c.updatedAt = nowIso();
    this.persist();
    return c;
  }

  // ---- Settings ----
  getSettings(): Settings {
    return this.data.settings;
  }
  updateSettings(patch: Partial<Settings>): Settings {
    Object.assign(this.data.settings, patch, { updatedAt: nowIso() });
    this.persist();
    return this.data.settings;
  }

  /**
   * Resolve which agent should handle a call, given optional custom params
   * (outbound passes agent_id) and the DID that was dialed (inbound).
   */
  resolveAgent(opts: { agentId?: string; did?: string }): Agent | undefined {
    if (opts.agentId) {
      const a = this.getAgent(opts.agentId);
      if (a) return a;
    }
    if (opts.did) {
      const num = this.getNumberByDid(opts.did);
      if (num?.agentId) {
        const a = this.getAgent(num.agentId);
        if (a) return a;
      }
    }
    const def = this.data.settings.defaultAgentId;
    if (def) {
      const a = this.getAgent(def);
      if (a) return a;
    }
    return this.data.agents[0];
  }
}

export const db = new Store();
