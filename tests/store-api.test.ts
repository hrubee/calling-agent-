import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Point the store at a throwaway dir before anything imports config.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "store-api-test-"));
process.env.LOG_LEVEL = "silent";

// Lazy shared setup: tests in this file run sequentially against one store.
type Ctx = {
  db: typeof import("../src/store/db").db;
  agent: import("../src/store/types").Agent;
  req: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
};
let ctxPromise: Promise<Ctx> | null = null;
function ctx(): Promise<Ctx> {
  return (ctxPromise ??= init());
}
async function init(): Promise<Ctx> {
  const { db } = await import("../src/store/db");
  const { callsRouter } = await import("../src/api/calls");
  const { numbersRouter } = await import("../src/api/numbers");
  const { settingsRouter } = await import("../src/api/settings");
  const express = (await import("express")).default;

  const app = express();
  app.use(express.json());
  app.use("/api/calls", callsRouter);
  app.use("/api/numbers", numbersRouter);
  app.use("/api/settings", settingsRouter);
  const server = app.listen(0);
  server.unref(); // never keep the test process alive
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const req = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  // A fresh store starts with one default agent.
  const agent = db.listAgents()[0];
  assert.ok(agent, "fresh store should seed a default agent");
  return { db, agent, req };
}

test("GET /api/calls clamps a negative limit instead of returning the whole store", async () => {
  const { db, req } = await ctx();
  for (let i = 0; i < 3; i++) db.createCall({ direction: "outbound", to: `+91${i}` });
  const r = await req("GET", "/api/calls?limit=-5");
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  const r2 = await req("GET", "/api/calls?limit=2");
  assert.equal(r2.body.length, 2);
});

test("POST /api/calls rejects an unknown agentId with 400 and creates no call", async () => {
  const { db, req } = await ctx();
  const before = db.listCalls(1000).length;
  const r = await req("POST", "/api/calls", { to: "+911234567890", agentId: "no-such-agent" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown agentId/);
  assert.equal(db.listCalls(1000).length, before);
});

test("PUT /api/numbers/:id can clear the inbound agent with null", async () => {
  const { db, agent, req } = await ctx();
  const created = await req("POST", "/api/numbers", { number: "+911111111111", agentId: agent.id });
  assert.equal(created.status, 201);
  assert.equal(created.body.agentId, agent.id);

  const cleared = await req("PUT", "/api/numbers/" + created.body.id, { agentId: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.agentId, undefined);
  assert.equal(db.getNumberByDid("+911111111111")?.agentId, undefined);

  // An absent key must still leave the assignment untouched.
  await req("PUT", "/api/numbers/" + created.body.id, { agentId: agent.id });
  const relabeled = await req("PUT", "/api/numbers/" + created.body.id, { label: "front desk" });
  assert.equal(relabeled.body.agentId, agent.id);
  assert.equal(relabeled.body.label, "front desk");
});

test("number routes reject an unknown agentId with 400", async () => {
  const { req } = await ctx();
  const bad = await req("POST", "/api/numbers", { number: "+912222222222", agentId: "bogus" });
  assert.equal(bad.status, 400);
  const rec = await req("POST", "/api/numbers", { number: "+912222222222" });
  const badPut = await req("PUT", "/api/numbers/" + rec.body.id, { agentId: "bogus" });
  assert.equal(badPut.status, 400);
});

test("PUT /api/settings validates defaultAgentId and accepts null to clear it", async () => {
  const { db, agent, req } = await ctx();
  const bad = await req("PUT", "/api/settings", { defaultAgentId: "bogus" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /unknown defaultAgentId/);

  const cleared = await req("PUT", "/api/settings", { defaultAgentId: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.defaultAgentId, undefined);
  assert.equal(db.getSettings().defaultAgentId, undefined);

  const set = await req("PUT", "/api/settings", { defaultAgentId: agent.id });
  assert.equal(set.status, 200);
  assert.equal(set.body.defaultAgentId, agent.id);
  db.flushSync();
});
