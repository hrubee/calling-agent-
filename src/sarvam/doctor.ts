import { config } from "../config";
import { decodeAlaw } from "../audio/g711";
import { completeChat } from "./chat";
import { transcribePcm8k } from "./stt";
import { synthesizeAlaw8k } from "./tts";

export interface DoctorReport {
  sarvamConfigured: boolean;
  tts: { ok: boolean; bytes?: number; detail?: string };
  stt: { ok: boolean; transcript?: string; detail?: string };
  chat: { ok: boolean; workingModel?: string; tried: { model: string; ok: boolean; detail?: string }[] };
}

const CHAT_CANDIDATES = ["sarvam-m", "sarvam-30b", "sarvam-105b"];

/**
 * Live health probe of the Sarvam integration. Verifies TTS (A-law 8k), STT
 * (round-tripping the TTS output), and resolves which chat model responds.
 */
export async function runDoctor(): Promise<DoctorReport> {
  const report: DoctorReport = {
    sarvamConfigured: config.sarvam.configured,
    tts: { ok: false },
    stt: { ok: false },
    chat: { ok: false, tried: [] },
  };

  if (!config.sarvam.configured) {
    const msg = "SARVAM_API_KEY not set";
    report.tts.detail = report.stt.detail = msg;
    return report;
  }

  // --- TTS ---
  let alaw: Buffer | null = null;
  try {
    alaw = await synthesizeAlaw8k("Hello, this is a test of the calling agent.", {
      targetLanguage: config.ttsFallbackLanguage,
    });
    report.tts = { ok: alaw.length > 0, bytes: alaw.length };
    if (alaw.length === 0) report.tts.detail = "empty audio returned";
  } catch (err) {
    report.tts = { ok: false, detail: (err as Error).message };
  }

  // --- STT (round-trip the synthesized audio) ---
  if (alaw && alaw.length > 0) {
    try {
      const pcm = decodeAlaw(alaw);
      const r = await transcribePcm8k(pcm, "auto");
      report.stt = { ok: true, transcript: r.transcript };
    } catch (err) {
      report.stt = { ok: false, detail: (err as Error).message };
    }
  } else {
    report.stt.detail = "skipped (no TTS audio to transcribe)";
  }

  // --- Chat model resolution ---
  const models = Array.from(new Set([config.sarvam.chatModel, ...CHAT_CANDIDATES]));
  for (const model of models) {
    try {
      const out = await completeChat([{ role: "user", content: "Reply with a short greeting." }], {
        model,
        maxTokens: 30,
        timeoutMs: 20000,
      });
      report.chat.tried.push({ model, ok: true, detail: out.slice(0, 80) });
      if (!report.chat.ok) {
        report.chat.ok = true;
        report.chat.workingModel = model;
      }
    } catch (err) {
      report.chat.tried.push({ model, ok: false, detail: (err as Error).message.slice(0, 120) });
    }
  }

  return report;
}
