import assert from "node:assert";
import test, { after, before } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

// Both modules under test transitively import src/config, which parses
// process.env at import time — so the env (and the mock TTS server the config
// must point at) has to exist BEFORE the first import. Hence dynamic imports
// from a `before` hook instead of static ones.
let splitSentences: typeof import("../src/agent/conversation").splitSentences;
let TtsStreamSession: typeof import("../src/sarvam/ttsStream").TtsStreamSession;
let wss: WebSocketServer;

before(async () => {
  wss = new WebSocketServer({ port: 0, path: "/text-to-speech/ws" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  process.env.SARVAM_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.SARVAM_API_KEY = "test-key";
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "engine-test-"));

  // Per-flush behavior keyed on the sentence text: "stall..." gets no final,
  // "dup..." gets a duplicate final, anything else gets audio + one final.
  wss.on("connection", (ws: WebSocket) => {
    let lastText = "";
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "text") lastText = msg.data.text as string;
      if (msg.type !== "flush") return;
      const finalEvt = JSON.stringify({ type: "event", data: { event_type: "final" } });
      if (lastText.startsWith("stall")) return; // accept text, never complete it
      // 100 bytes: not frame-aligned, so audio is only released via the padded
      // remainder flush when the final arrives.
      const audio = JSON.stringify({
        type: "audio",
        data: { audio: Buffer.alloc(100, 0x55).toString("base64") },
      });
      ws.send(audio);
      ws.send(finalEvt);
      if (lastText.startsWith("dup")) ws.send(finalEvt);
    });
  });

  ({ splitSentences } = await import("../src/agent/conversation"));
  ({ TtsStreamSession } = await import("../src/sarvam/ttsStream"));
});

after(() => {
  for (const c of wss.clients) c.terminate();
  wss.close();
});

// ---- splitSentences (streaming sentence splitter) ----

test("splitSentences splits completed sentences", () => {
  const { sentences, rest } = splitSentences("Hello there. How are you? ");
  assert.deepEqual(sentences, ["Hello there.", "How are you?"]);
  assert.equal(rest, "");
});

test("splitSentences does not split decimals", () => {
  const { sentences, rest } = splitSentences("It costs Rs 1.5 lakh in total. Interested? ");
  assert.deepEqual(sentences, ["It costs Rs 1.5 lakh in total.", "Interested?"]);
  assert.equal(rest, "");
});

test("splitSentences keeps a terminator at the buffer edge in rest", () => {
  // The next delta may continue a number ("1." + "5 lakh") — don't cut yet.
  const { sentences, rest } = splitSentences("The price is Rs 1.");
  assert.deepEqual(sentences, []);
  assert.equal(rest, "The price is Rs 1.");
});

test("splitSentences handles danda, newlines and ellipses", () => {
  const { sentences, rest } = splitSentences("नमस्ते। कैसे हैं?\nWait... okay then");
  assert.deepEqual(sentences, ["नमस्ते।", "कैसे हैं?", "Wait..."]);
  assert.equal(rest, "okay then");
});

test("splitSentences never drops text", () => {
  const text = "A 1.5 mix. Of! everything?\nincluding.. edge cases. tail";
  const { sentences, rest } = splitSentences(text);
  const joined = (sentences.join(" ") + " " + rest).replace(/\s+/g, " ").trim();
  assert.equal(joined, text.replace(/\s+/g, " ").trim());
});

// ---- TtsStreamSession watchdog / final-event handling ----

test("watchdog fails the session when a flush never completes", async () => {
  const lost: string[][] = [];
  let idle = 0;
  const session = new TtsStreamSession({
    model: "bulbul:v2",
    speaker: "anushka",
    targetLanguage: "en-IN",
    stallTimeoutMs: 300,
    onAudio: () => {},
    onIdle: () => idle++,
    onError: (_err, texts) => lost.push(texts),
  });
  session.speak("stall on this sentence");
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(lost.length, 1, "onError should fire exactly once");
  assert.deepEqual(lost[0], ["stall on this sentence"]);
  assert.equal(idle, 0);
  assert.equal(session.pending, 0, "failed session clears pending");
});

test("normal flush completes: padded audio, one idle, no error", async () => {
  const audio: Buffer[] = [];
  let idle = 0;
  let errors = 0;
  const session = new TtsStreamSession({
    model: "bulbul:v2",
    speaker: "anushka",
    targetLanguage: "en-IN",
    stallTimeoutMs: 2000,
    onAudio: (b) => audio.push(b),
    onIdle: () => idle++,
    onError: () => errors++,
  });
  session.speak("hello world");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(errors, 0);
  assert.equal(idle, 1);
  assert.equal(session.pending, 0);
  const total = audio.reduce((n, b) => n + b.length, 0);
  assert.equal(total, 160, "100 audio bytes must be padded to one whole frame");
  session.close();
});

test("a spurious duplicate final is ignored", async () => {
  let idle = 0;
  let errors = 0;
  const session = new TtsStreamSession({
    model: "bulbul:v2",
    speaker: "anushka",
    targetLanguage: "en-IN",
    stallTimeoutMs: 2000,
    onAudio: () => {},
    onIdle: () => idle++,
    onError: () => errors++,
  });
  session.speak("dup final for this one");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(errors, 0, "duplicate final must not fail the session");
  assert.equal(idle, 1, "onIdle must fire exactly once");
  // The queue stayed aligned: another sentence still completes normally.
  session.speak("hello again");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(idle, 2);
  assert.equal(errors, 0);
  session.close();
});
