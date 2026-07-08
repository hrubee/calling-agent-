import { config } from "../config";
import { pcm16ToWav } from "../audio/wav";
import { upsample8to16 } from "../audio/resample";
import { assertConfigured, fetchWithTimeout, SarvamError, sarvamHeaders, sarvamUrl } from "./client";

export interface SttResult {
  transcript: string;
  languageCode?: string;
  raw: unknown;
}

/**
 * Transcribe PCM16 audio via Sarvam Speech-to-Text.
 *
 * @param pcm8k  mono PCM16 samples at 8 kHz (telephony rate)
 * @param language  "auto" (detect) or a BCP-47 code
 */
export async function transcribePcm8k(pcm8k: Int16Array, language = "auto"): Promise<SttResult> {
  assertConfigured();
  // Sarvam works best at 16 kHz — upsample and wrap as WAV.
  const pcm16k = upsample8to16(pcm8k);
  const wav = pcm16ToWav(pcm16k, 16000);
  return transcribeWav(wav, language);
}

export async function transcribeWav(wav: Buffer, language = "auto"): Promise<SttResult> {
  assertConfigured();
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.append("model", config.sarvam.sttModel);
  form.append("language_code", language === "auto" ? "unknown" : language);
  if (config.sarvam.sttModel.toLowerCase().includes("saaras")) {
    form.append("mode", "transcribe");
  }

  const res = await fetchWithTimeout(
    sarvamUrl("/speech-to-text"),
    { method: "POST", headers: sarvamHeaders(), body: form },
    20000,
  );
  const text = await res.text();
  if (!res.ok) throw new SarvamError(res.status, text);

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SarvamError(res.status, text, "STT returned non-JSON");
  }
  return {
    transcript: (json.transcript ?? "").trim(),
    languageCode: json.language_code ?? undefined,
    raw: json,
  };
}
