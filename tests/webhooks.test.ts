import assert from "node:assert";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the store at a throwaway dir BEFORE the config/db modules load, and
// seed it with a long-running call so the end-of-call match window is testable.
const dataDir = mkdtempSync(join(tmpdir(), "webhooks-test-"));
process.env.DATA_DIR = dataDir;

const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
writeFileSync(
  join(dataDir, "db.json"),
  JSON.stringify({
    calls: [
      {
        id: "long-call-1",
        direction: "outbound",
        from: "+1 555 000 1111",
        to: "+1 555 000 2222",
        callSid: "wss-sid-long",
        status: "in-progress",
        transcript: [],
        createdAt: twoHoursAgo,
        updatedAt: twoHoursAgo,
        startedAt: twoHoursAgo,
      },
    ],
  }),
);

async function load() {
  const { handleVoicelinkWebhook } = await import("../src/voicelink/webhooks");
  const { db } = await import("../src/store/db");
  return { handleVoicelinkWebhook, db };
}

test("NO_ANSWER callStatus maps to no-answer, not answered", async () => {
  const { handleVoicelinkWebhook, db } = await load();
  const call = db.createCall({ direction: "outbound", callSid: "sid-noanswer", status: "initiated" });
  const res = handleVoicelinkWebhook({
    event: "call.status",
    callId: "sid-noanswer",
    callStatus: "NO_ANSWER",
  });
  assert.equal(res.matched, true);
  assert.equal(db.getCall(call.id)?.status, "no-answer");
});

test("plain ANSWERED callStatus still maps to answered", async () => {
  const { handleVoicelinkWebhook, db } = await load();
  const call = db.createCall({ direction: "outbound", callSid: "sid-answered", status: "initiated" });
  handleVoicelinkWebhook({ event: "call.status", callId: "sid-answered", callStatus: "ANSWERED" });
  assert.equal(db.getCall(call.id)?.status, "answered");
});

test("FAILED callStatus maps to failed", async () => {
  const { handleVoicelinkWebhook, db } = await load();
  const call = db.createCall({ direction: "outbound", callSid: "sid-failed", status: "initiated" });
  handleVoicelinkWebhook({ event: "call.status", callId: "sid-failed", callStatus: "FAILED" });
  assert.equal(db.getCall(call.id)?.status, "failed");
});

test("snake_case JSON-string custom_parameters link via call_ref", async () => {
  const { handleVoicelinkWebhook, db } = await load();
  // No callSid and no phone numbers: only call_ref can link this webhook.
  const call = db.createCall({ direction: "outbound", status: "initiated" });
  const res = handleVoicelinkWebhook({
    event: "call.completed",
    callId: "provider-id-unknown",
    duration: 42,
    recording_url: "https://example.com/rec.mp3",
    custom_parameters: JSON.stringify({ call_ref: call.id, campaign: "july" }),
  });
  assert.equal(res.matched, true);
  const updated = db.getCall(call.id);
  assert.equal(updated?.status, "completed");
  assert.equal(updated?.durationSec, 42);
  assert.equal(updated?.recordingUrl, "https://example.com/rec.mp3");
  assert.equal(updated?.customParameters?.campaign, "july");
});

test("camelCase customParameters object still works", async () => {
  const { handleVoicelinkWebhook, db } = await load();
  const call = db.createCall({ direction: "outbound", status: "initiated" });
  const res = handleVoicelinkWebhook({
    event: "call.completed",
    customParameters: { call_ref: call.id, lead: "abc" },
  });
  assert.equal(res.matched, true);
  assert.equal(db.getCall(call.id)?.customParameters?.lead, "abc");
});

test("end-of-call webhook links a >15min call by phone match", async () => {
  const { handleVoicelinkWebhook, db } = await load();
  const res = handleVoicelinkWebhook({
    event: "call.completed",
    callId: "webhook-namespace-id", // differs from stored callSid
    fromNumber: "15550001111",
    toNumber: "15550002222",
    duration: 7300,
  });
  assert.equal(res.matched, true);
  const call = db.getCall("long-call-1");
  assert.equal(call?.status, "completed");
  assert.equal(call?.durationSec, 7300);
});

test("non-final webhook does not fuzzy-match a stale call", async () => {
  const { handleVoicelinkWebhook } = await load();
  // long-call-1 is now completed; a fresh initiated webhook for the same pair
  // must not attach to a 2-hour-old record via the 15-minute window.
  const res = handleVoicelinkWebhook({
    event: "call.ringing",
    fromNumber: "15550001111",
    toNumber: "15550002222",
    callStatus: "RINGING",
  });
  assert.equal(res.matched, false);
});
