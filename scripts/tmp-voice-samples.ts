import "dotenv/config";
import { writeFileSync } from "node:fs";
import { synthesizeAlaw8k } from "../src/sarvam/tts";
import { decodeAlaw } from "../src/audio/g711";
import { pcm16ToWav } from "../src/audio/wav";

/** Generate Marathi TTS samples across speakers, phone-realistic (A-law 8 kHz). */

const TEXT =
  "नमस्कार! व्हॉइसलिंक मध्ये आपले स्वागत आहे. आज आम्ही आपली कशी मदत करू शकतो?";

const CANDIDATES: { model: string; speaker: string; note: string }[] = [
  { model: "bulbul:v2", speaker: "anushka", note: "current voice (v2)" },
  { model: "bulbul:v3", speaker: "anushka", note: "same voice on v3" },
  { model: "bulbul:v3", speaker: "priya", note: "v3 female" },
  { model: "bulbul:v3", speaker: "ritu", note: "v3 female" },
  { model: "bulbul:v3", speaker: "neha", note: "v3 female" },
  { model: "bulbul:v3", speaker: "shreya", note: "v3 female" },
  { model: "bulbul:v3", speaker: "rupali", note: "v3 female" },
  { model: "bulbul:v3", speaker: "shruti", note: "v3 female" },
  { model: "bulbul:v3", speaker: "aditya", note: "v3 male" },
  { model: "bulbul:v3", speaker: "rohan", note: "v3 male" },
];

async function main() {
  const out: { model: string; speaker: string; note: string; wavB64: string; ms: number }[] = [];
  for (const c of CANDIDATES) {
    const t0 = Date.now();
    try {
      const alaw = await synthesizeAlaw8k(TEXT, {
        targetLanguage: "mr-IN",
        model: c.model,
        speaker: c.speaker,
      });
      const ms = Date.now() - t0;
      if (!alaw.length) {
        console.log(`${c.model}/${c.speaker}: EMPTY`);
        continue;
      }
      const wav = pcm16ToWav(decodeAlaw(alaw), 8000);
      out.push({ ...c, wavB64: wav.toString("base64"), ms });
      console.log(`${c.model}/${c.speaker}: ${alaw.length} bytes, ${ms}ms`);
    } catch (err) {
      console.log(`${c.model}/${c.speaker}: FAILED ${(err as Error).message.slice(0, 120)}`);
    }
  }
  writeFileSync(process.env.SAMPLES_OUT || "voice-samples.json", JSON.stringify(out));
  console.log(`wrote ${out.length} samples`);
}

void main();
