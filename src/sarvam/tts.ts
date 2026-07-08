import { config } from "../config";
import { stripWavHeader } from "../audio/wav";
import { assertConfigured, fetchWithTimeout, SarvamError, sarvamHeaders, sarvamUrl } from "./client";

export interface TtsOptions {
  targetLanguage: string; // BCP-47, e.g. en-IN
  speaker?: string;
  model?: string;
  pace?: number;
}

/**
 * Synthesize speech via Sarvam Text-to-Speech, returning raw A-law bytes at
 * 8 kHz mono — exactly VoiceLink's wire format (no transcoding required).
 */
export async function synthesizeAlaw8k(text: string, opts: TtsOptions): Promise<Buffer> {
  assertConfigured();
  const clean = text.trim();
  if (!clean) return Buffer.alloc(0);

  const speaker = opts.speaker || config.sarvam.ttsSpeaker;
  const model = opts.model || config.sarvam.ttsModel;

  const baseBody: Record<string, unknown> = {
    target_language_code: opts.targetLanguage,
    speaker,
    model,
    speech_sample_rate: 8000,
    output_audio_codec: "alaw",
    pace: opts.pace ?? 1.0,
  };

  // Primary shape uses `text`. Some Sarvam versions expect `inputs: [text]`.
  const audios = await requestTts({ ...baseBody, text: clean }).catch(async (err) => {
    if (err instanceof SarvamError && err.status === 400 && /input/i.test(err.body)) {
      return requestTts({ ...baseBody, inputs: [clean] });
    }
    throw err;
  });

  if (!audios.length) return Buffer.alloc(0);
  const raw = Buffer.from(audios[0], "base64");
  return stripWavHeader(raw);
}

async function requestTts(body: Record<string, unknown>): Promise<string[]> {
  const res = await fetchWithTimeout(
    sarvamUrl("/text-to-speech"),
    {
      method: "POST",
      headers: sarvamHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    },
    20000,
  );
  const text = await res.text();
  if (!res.ok) throw new SarvamError(res.status, text);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SarvamError(res.status, text, "TTS returned non-JSON");
  }
  const audios: string[] = json.audios ?? (json.audio ? [json.audio] : []);
  return audios;
}
