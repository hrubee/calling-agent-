import "dotenv/config";
import WebSocket from "ws";
import { config } from "../src/config";
import { synthesizeAlaw8k } from "../src/sarvam/tts";

/**
 * Simulate a VoiceLink call against a locally running server, without a real
 * phone. It performs the WSS handshake, streams a synthesized caller utterance
 * as inbound A-law audio, then silence to trigger endpointing — and observes
 * the bot's audio + marks coming back (the full STT → LLM → TTS loop).
 *
 * Prereq: run the server with a FIXED WSS_TOKEN in .env, then run this.
 */

const PORT = process.env.PORT || "8080";
const token = process.env.WSS_TOKEN;
if (!token) {
  console.error("Set WSS_TOKEN in .env (same value the server uses) before running the mock.");
  process.exit(1);
}

const USER_LINE = process.argv[2] || "Hi, what are your opening hours?";
const url = `ws://localhost:${PORT}/media-stream?token=${token}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function silenceFrame(): Buffer {
  return Buffer.alloc(160, 0xd5); // A-law encoded 0 (silence), 20 ms
}

async function streamAlaw(ws: WebSocket, alaw: Buffer) {
  for (let i = 0; i < alaw.length; i += 160) {
    const frame = alaw.subarray(i, Math.min(i + 160, alaw.length));
    ws.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: frame.toString("base64") } }));
    if ((i / 160) % 5 === 4) await sleep(100);
  }
}

async function main() {
  console.log(`Connecting to ${url}`);
  const ws = new WebSocket(url);
  let botFrames = 0;
  let marks = 0;

  ws.on("message", (raw) => {
    let m: any;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.event === "media") botFrames++;
    else if (m.event === "mark") {
      marks++;
      console.log(`← mark: ${m.mark?.name} (bot audio frames so far: ${botFrames})`);
    } else if (m.event === "clear") console.log("← clear (barge-in flush)");
    else console.log("←", m.event);
  });

  ws.on("open", async () => {
    console.log("WS open → sending connected + start");
    ws.send(JSON.stringify({ event: "connected" }));
    ws.send(
      JSON.stringify({
        event: "start",
        sequence_number: 0,
        stream_sid: "mock_stream_1",
        start: {
          stream_sid: "mock_stream_1",
          call_sid: "mockcall_" + Date.now(),
          account_sid: "1",
          from: "+919999999999",
          to: "+918888888888",
          custom_parameters: { direction: "inbound" },
          media_format: { encoding: "audio/alaw", sample_rate: 8000 },
        },
      }),
    );

    // Let the greeting play, then send a caller utterance.
    await sleep(3500);
    if (config.sarvam.configured) {
      console.log(`→ caller says: "${USER_LINE}"`);
      const alaw = await synthesizeAlaw8k(USER_LINE, { targetLanguage: config.ttsFallbackLanguage });
      if (alaw.length) {
        await streamAlaw(ws, alaw);
        // trailing silence to trigger endpointing
        for (let i = 0; i < 45; i++) {
          ws.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: silenceFrame().toString("base64") } }));
          await sleep(20);
        }
      } else {
        console.log("TTS produced no audio; skipping utterance.");
      }
    } else {
      console.log("SARVAM_API_KEY not set → only verifying handshake (no audio loop).");
    }

    await sleep(16000);
    console.log(`\nDone. bot audio frames: ${botFrames}, marks: ${marks}`);
    ws.send(JSON.stringify({ event: "stop", stop: { callSid: "mockcall" } }));
    ws.close();
    process.exit(botFrames > 0 || !config.sarvam.configured ? 0 : 1);
  });

  ws.on("error", (err) => {
    console.error("WS error:", err);
    process.exit(1);
  });
}

main();
