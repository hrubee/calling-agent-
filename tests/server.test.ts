import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

// Config reads the environment at import time, so set everything before the
// app is (dynamically) imported. DATA_DIR must be a temp dir or the store
// would read/write the repo's ./data.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calling-agent-test-"));
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.SESSION_SECRET = "test-session-secret";
process.env.WEBHOOK_TOKEN = "test-webhook-token";
process.env.WSS_TOKEN = "test-wss-token";
process.env.SARVAM_API_KEY = ""; // keep TTS warm-up a no-op

let server: Server;
let base = "";

before(async () => {
  const { buildApp } = await import("../src/server");
  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no server address");
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server?.close();
});

/**
 * `trust proxy` is enabled, so X-Forwarded-For controls req.ip. Tests that
 * provoke auth failures use a unique ip so the per-IP lockout never bleeds
 * into other tests (which run as 127.0.0.1).
 */
function req(
  path: string,
  opts: { method?: string; body?: unknown; rawBody?: string; bearer?: string | null; cookie?: string; ip?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.bearer !== null) headers.authorization = `Bearer ${opts.bearer ?? "test-password"}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    headers["content-type"] = "application/json";
    body = opts.rawBody;
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return fetch(base + path, { method: opts.method ?? (body ? "POST" : "GET"), headers, body });
}

function validAgent(id: string) {
  const t = new Date().toISOString();
  return {
    id,
    name: "Import Test Agent",
    systemPrompt: "You are a test agent.",
    greeting: "Hello!",
    language: "auto",
    ttsModel: "bulbul:v2",
    ttsSpeaker: "anushka",
    temperature: 0.4,
    maxTokens: 2048,
    createdAt: t,
    updatedAt: t,
  };
}

function validCall(id: string, turns: number) {
  const t = new Date().toISOString();
  return {
    id,
    direction: "inbound",
    status: "completed",
    startedAt: t,
    transcript: Array.from({ length: turns }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      text: `turn ${i} — ${"x".repeat(400)}`,
      at: t,
    })),
    createdAt: t,
    updatedAt: t,
  };
}

test("GET /api/me requires auth; Bearer password works", async () => {
  const anon = await fetch(`${base}/api/me`);
  assert.equal(anon.status, 401);
  const authed = await req("/api/me");
  assert.equal(authed.status, 200);
  assert.deepEqual(await authed.json(), { authenticated: true });
});

test("login sets a session cookie that authenticates", async () => {
  const res = await req("/api/login", { body: { password: "test-password" }, bearer: null, ip: "10.1.0.1" });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie") || "";
  const session = setCookie.split(";")[0];
  assert.match(session, /^ca_session=/);
  const me = await req("/api/me", { bearer: null, cookie: session });
  assert.equal(me.status, 200);
});

test("login is rate-limited per IP after repeated failures", async () => {
  const ip = "10.2.0.1";
  for (let i = 0; i < 10; i++) {
    const res = await req("/api/login", { body: { password: "wrong" }, bearer: null, ip });
    assert.equal(res.status, 401);
  }
  // Locked out now — even the correct password is refused from this IP.
  const locked = await req("/api/login", { body: { password: "test-password" }, bearer: null, ip });
  assert.equal(locked.status, 429);
  // Other IPs are unaffected.
  const other = await req("/api/login", { body: { password: "test-password" }, bearer: null, ip: "10.2.0.2" });
  assert.equal(other.status, 200);
});

test("Bearer brute-force is rate-limited per IP", async () => {
  const ip = "10.3.0.1";
  for (let i = 0; i < 10; i++) {
    const res = await req("/api/me", { bearer: `guess-${i}`, ip });
    assert.equal(res.status, 401);
  }
  const locked = await req("/api/me", { ip });
  assert.equal(locked.status, 401, "correct Bearer password refused while IP is locked out");
  const other = await req("/api/me", { ip: "10.3.0.2" });
  assert.equal(other.status, 200);
});

test("admin import accepts a valid export larger than 1MB", async () => {
  const calls = Array.from({ length: 350 }, (_, i) => validCall(`call-${i}`, 10));
  const body = { agents: [validAgent("agent-big")], calls, numbers: [], settings: undefined };
  assert.ok(JSON.stringify(body).length > 1_000_000, "fixture must exceed the 1mb global limit");
  const res = await req("/api/admin/import", { body });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const out = JSON.parse(text) as { ok: boolean; agents: number; calls: number };
  assert.equal(out.ok, true);
  assert.equal(out.agents, 1);
  assert.equal(out.calls, 350);
  const exported = await req("/api/admin/export");
  const dump = (await exported.json()) as { agents: Array<{ id: string }>; calls: unknown[] };
  assert.equal(dump.agents[0]?.id, "agent-big");
  assert.equal(dump.calls.length, 350);
});

test("admin import rejects malformed exports with 400", async () => {
  const res = await req("/api/admin/import", { body: { agents: [{ bogus: true }] } });
  assert.equal(res.status, 400);
  const out = (await res.json()) as { error: string };
  assert.match(out.error, /full DB export/);
});

test("malformed JSON gets a JSON error, not an HTML page", async () => {
  const res = await req("/api/login", { rawBody: "{oops", bearer: null, ip: "10.4.0.1" });
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type") || "", /application\/json/);
  const out = (await res.json()) as { error: string };
  assert.match(out.error, /malformed JSON/);
});

test("oversized body on a normal route gets a JSON 413", async () => {
  const res = await req("/api/agents", { body: { name: "big", systemPrompt: "y".repeat(1_100_000) } });
  assert.equal(res.status, 413);
  assert.match(res.headers.get("content-type") || "", /application\/json/);
  const out = (await res.json()) as { error: string };
  assert.match(out.error, /payload too large/);
});

test("webhook rejects bad, missing, and array tokens", async () => {
  const bad = await fetch(`${base}/webhooks/voicelink?token=nope`, { method: "POST" });
  assert.equal(bad.status, 401);
  const missing = await fetch(`${base}/webhooks/voicelink`, { method: "POST" });
  assert.equal(missing.status, 401);
  const arr = await fetch(`${base}/webhooks/voicelink?token=a&token=test-webhook-token`, { method: "POST" });
  assert.equal(arr.status, 401);
  const ok = await fetch(`${base}/webhooks/voicelink?token=test-webhook-token`, { method: "POST" });
  assert.equal(ok.status, 200);
});
