import assert from "node:assert";
import test, { after, before } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";

// The module under test transitively imports src/config, which parses
// process.env at import time — so the env (and the mock STT server the config
// must point at) has to exist BEFORE the first import. Hence dynamic imports
// from a `before` hook instead of static ones.
let SttStreamSession: typeof import("../src/sarvam/sttStream").SttStreamSession;
let wss: WebSocketServer;

interface Conn {
  ws: WebSocket;
  url: URL;
  /** Decoded PCM bytes from every {audio} message, in order. */
  audio: Buffer[];
  flushes: number;
}

/** Per-test server behavior, invoked for every parsed client message. */
let onMessage: (conn: Conn, msg: any) => void = () => {};

const dataMsg = (transcript: string, language?: string) =>
  JSON.stringify({
    type: "data",
    data: { request_id: "r1", transcript, language_code: language ?? null, metrics: {} },
  });

/** Register interest in the NEXT connection before triggering it. */
function nextConn(): Promise<Conn> {
  return new Promise((resolve) => {
    wss.once("connection", (ws: WebSocket, req: any) => {
      const conn: Conn = {
        ws,
        url: new URL(req.url as string, "http://localhost"),
        audio: [],
        flushes: 0,
      };
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.audio?.data) conn.audio.push(Buffer.from(msg.audio.data, "base64"));
        if (msg.type === "flush") conn.flushes++;
        onMessage(conn, msg);
      });
      resolve(conn);
    });
  });
}

before(async () => {
  wss = new WebSocketServer({ port: 0, path: "/speech-to-text/ws" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  process.env.SARVAM_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.SARVAM_API_KEY = "test-key";

  ({ SttStreamSession } = await import("../src/sarvam/sttStream"));

  // bun runs every test file in ONE process, so another file may have already
  // imported (and frozen the values of) src/config before our env was set.
  // The session reads config live at construction — patch the cached object
  // so this file works under both runners regardless of import order.
  const { config } = await import("../src/config");
  const sarvam = config.sarvam as { baseUrl: string; apiKey: string };
  sarvam.baseUrl = `http://127.0.0.1:${port}`;
  sarvam.apiKey = "test-key";
});

after(() => {
  for (const c of wss.clients) c.terminate();
  wss.close();
});

/** 20 ms of 8 kHz PCM (160 samples) with a recognizable ramp. */
function frame8k(seed = 0): Int16Array {
  const f = new Int16Array(160);
  for (let i = 0; i < f.length; i++) f[i] = ((seed + i) % 64) * 100;
  return f;
}

test("connects with protocol query params and resolves the flushed transcript", async () => {
  onMessage = (conn, msg) => {
    if (msg.type === "flush") conn.ws.send(dataMsg("hello there", "en-IN"));
  };
  const connP = nextConn();
  const session = new SttStreamSession({
    language: "auto",
    model: "saaras:v3",
    settleGraceMs: 40,
  });
  // Queue audio before the socket opens — it must be delivered after open.
  for (let i = 0; i < 5; i++) session.sendPcm8k(frame8k(i));
  const conn = await connP;

  const result = await session.finish();
  assert.equal(result.transcript, "hello there");
  assert.equal(result.languageCode, "en-IN");

  assert.equal(conn.url.searchParams.get("language-code"), "unknown"); // "auto" mapped
  assert.equal(conn.url.searchParams.get("model"), "saaras:v3");
  assert.equal(conn.url.searchParams.get("input_audio_codec"), "pcm_s16le");
  assert.equal(conn.url.searchParams.get("sample_rate"), "16000");
  assert.equal(conn.flushes, 1);

  // 5 x 160 samples @ 8 kHz upsampled 2x -> 1600 samples -> 3200 bytes, and
  // batching (100 ms = 1600 samples @ 16 kHz) packs them into one message.
  const total = conn.audio.reduce((a, b) => a + b.length, 0);
  assert.equal(total, 3200);
  assert.equal(conn.audio.length, 1);
});

test("passes an explicit language code through", async () => {
  onMessage = (conn, msg) => {
    if (msg.type === "flush") conn.ws.send(dataMsg("नमस्कार"));
  };
  const connP = nextConn();
  const session = new SttStreamSession({
    language: "mr-IN",
    model: "saaras:v3",
    settleGraceMs: 40,
  });
  session.sendPcm8k(frame8k());
  const conn = await connP;
  const result = await session.finish();
  assert.equal(result.transcript, "नमस्कार");
  assert.equal(result.languageCode, undefined); // server sent null (language was pinned)
  assert.equal(conn.url.searchParams.get("language-code"), "mr-IN");
});

test("concatenates a pre-flush server-VAD segment with the flushed tail", async () => {
  onMessage = (conn, msg) => {
    // First audio message -> an early segment; flush -> the tail segment.
    if (msg.audio && conn.audio.length === 1) conn.ws.send(dataMsg("hello"));
    if (msg.type === "flush") conn.ws.send(dataMsg("there", "en-IN"));
  };
  const connP = nextConn();
  const session = new SttStreamSession({
    language: "auto",
    model: "saaras:v3",
    settleGraceMs: 40,
  });
  // A full 100 ms batch so the first audio message goes out immediately.
  for (let i = 0; i < 5; i++) session.sendPcm8k(frame8k(i));
  await connP;
  // Let the early segment arrive while the stream is still un-flushed.
  await new Promise((r) => setTimeout(r, 80));
  session.sendPcm8k(frame8k(5));
  const result = await session.finish();
  assert.equal(result.transcript, "hello there");
});

test("rejects finish() on a server error message", async () => {
  onMessage = (conn, msg) => {
    if (msg.audio) conn.ws.send(JSON.stringify({ type: "error", data: { error: "boom", code: "500" } }));
  };
  const connP = nextConn();
  const session = new SttStreamSession({ language: "auto", model: "saaras:v3" });
  session.sendPcm8k(frame8k());
  await connP;
  await assert.rejects(session.finish(), /STT stream/);
});

test("rejects finish() when the server never answers the flush", async () => {
  onMessage = () => {}; // accept everything, answer nothing
  const connP = nextConn();
  const session = new SttStreamSession({
    language: "auto",
    model: "saaras:v3",
    finishTimeoutMs: 150,
  });
  session.sendPcm8k(frame8k());
  await connP;
  await assert.rejects(session.finish(), /no transcript within/);
});

test("resolves with pre-flush segments when the flush answer never comes", async () => {
  onMessage = (conn, msg) => {
    if (msg.audio && conn.audio.length === 1) conn.ws.send(dataMsg("early bird", "hi-IN"));
    // flush: never answered — the server had already finalized everything
  };
  const connP = nextConn();
  const session = new SttStreamSession({
    language: "auto",
    model: "saaras:v3",
    settleGraceMs: 40,
    finishTimeoutMs: 500,
  });
  for (let i = 0; i < 5; i++) session.sendPcm8k(frame8k(i));
  await connP;
  await new Promise((r) => setTimeout(r, 80));
  const t0 = Date.now();
  const result = await session.finish();
  assert.equal(result.transcript, "early bird");
  assert.equal(result.languageCode, "hi-IN");
  // Settled via the quiet-period grace, not the full watchdog.
  assert.ok(Date.now() - t0 < 400, "should settle on grace, not the watchdog");
});

test("resolves with delivered segments when the server closes instead of answering", async () => {
  onMessage = (conn, msg) => {
    if (msg.audio && conn.audio.length === 1) conn.ws.send(dataMsg("done already"));
    if (msg.type === "flush") conn.ws.close();
  };
  const connP = nextConn();
  const session = new SttStreamSession({ language: "auto", model: "saaras:v3" });
  session.sendPcm8k(frame8k());
  await connP;
  await new Promise((r) => setTimeout(r, 50));
  const result = await session.finish();
  assert.equal(result.transcript, "done already");
});

test("rejects when the server closes without ever sending a transcript", async () => {
  onMessage = (conn, msg) => {
    if (msg.type === "flush") conn.ws.close();
  };
  const connP = nextConn();
  const session = new SttStreamSession({ language: "auto", model: "saaras:v3" });
  session.sendPcm8k(frame8k());
  await connP;
  await assert.rejects(session.finish(), /closed/);
});

test("an empty flushed transcript resolves empty (no false REST fallback)", async () => {
  onMessage = (conn, msg) => {
    if (msg.type === "flush") conn.ws.send(dataMsg("   "));
  };
  const connP = nextConn();
  const session = new SttStreamSession({
    language: "auto",
    model: "saaras:v3",
    settleGraceMs: 40,
  });
  session.sendPcm8k(frame8k());
  await connP;
  const result = await session.finish();
  assert.equal(result.transcript, "");
});

test("close() is safe, idempotent, and rejects a pending finish()", async () => {
  onMessage = () => {};
  const connP = nextConn();
  const session = new SttStreamSession({ language: "auto", model: "saaras:v3" });
  session.sendPcm8k(frame8k());
  await connP;
  const pending = session.finish();
  session.close();
  session.close();
  await assert.rejects(pending, /closed/);
  // Audio + finish after close are no-ops / immediate rejections.
  session.sendPcm8k(frame8k());
  await assert.rejects(session.finish(), /closed/);
});

test("a sub-batch tail is flushed with finish(), nothing lost", async () => {
  onMessage = (conn, msg) => {
    if (msg.type === "flush") conn.ws.send(dataMsg("ok"));
  };
  const connP = nextConn();
  const session = new SttStreamSession({
    language: "auto",
    model: "saaras:v3",
    settleGraceMs: 40,
  });
  const conn = await connP;
  // 3 frames = 60 ms < the 100 ms batch: nothing may be sent until finish().
  for (let i = 0; i < 3; i++) session.sendPcm8k(frame8k(i));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(conn.audio.length, 0);
  await session.finish();
  const total = conn.audio.reduce((a, b) => a + b.length, 0);
  assert.equal(total, 3 * 160 * 2 * 2); // 3 frames, 2x upsample, 2 bytes/sample
});
