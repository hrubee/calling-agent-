import { config } from "../config";
import { logger } from "../logger";
import { synthesizeAlaw8k } from "../sarvam/tts";
import { readFileSync } from "node:fs"; import { stripWavHeader } from "../audio/wav"; import { encodeAlaw } from "../audio/g711";
import { db } from "../store/db";
import type { Agent } from "../store/types";

/**
 * Pre-synthesized audio cache for fixed lines (greetings, filler phrases).
 *
 * On an outbound/inbound call, the greeting must play the instant the call
 * connects — otherwise the caller hears dead air while we call the TTS API and
 * often hangs up. Fillers likewise must play instantly to mask response
 * latency. Entries are keyed by everything that affects the audio (text,
 * language, speaker, model), so edits simply produce a new entry and the
 * cache never goes stale.
 */

const log = logger.child({ mod: "greeting" });
const cache = new Map<string, Buffer>();
const MAX_ENTRIES = 300;

function greetLang(agent: Agent): string {
  return agent.language && agent.language !== "auto" ? agent.language : config.ttsFallbackLanguage;
}

async function cachedTts(agent: Agent, text: string, lang: string): Promise<Buffer> {
  if (!text || !config.sarvam.configured) return Buffer.alloc(0);
  const key = [text, lang, agent.ttsSpeaker, agent.ttsModel].join("|");
  const hit = cache.get(key);
  if (hit) return hit;

  const audio = await synthesizeAlaw8k(text, {
    targetLanguage: lang,
    speaker: agent.ttsSpeaker,
    model: agent.ttsModel,
  });
  if (audio.length) {
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, audio);
  }
  return audio;
}

let recordingCache: Buffer | null = null; function loadRecordingAlaw(path: string): Buffer { if (recordingCache) return recordingCache; const pcm16le = stripWavHeader(readFileSync(path)); const n = Math.floor(pcm16le.length / 2); const pcm = new Int16Array(n); for (let i = 0; i < n; i++) pcm[i] = pcm16le.readInt16LE(i * 2); recordingCache = encodeAlaw(pcm); return recordingCache; }
/** Return cached greeting audio (A-law 8k), synthesizing + caching on a miss. */
export async function getGreetingAudio(agent: Agent): Promise<Buffer> {
  if (config.campaignAudioFile) { try { return loadRecordingAlaw(config.campaignAudioFile); } catch (err) { log.warn({ err: (err as Error).message }, "campaign audio load failed; using TTS"); } }
  return cachedTts(agent, agent.greeting?.trim() ?? "", greetLang(agent));
}

/** Return cached filler audio (rotates through the configured phrases). */
export async function getFillerAudio(agent: Agent, idx: number, lang: string): Promise<Buffer> {
  const texts = config.filler.texts;
  if (!texts.length) return Buffer.alloc(0);
  return cachedTts(agent, texts[idx % texts.length], lang);
}

/** Warm the cache for every agent at startup so the first call is instant too. */
export async function warmAllGreetings(): Promise<void> {
  if (!config.sarvam.configured) return;
  for (const agent of db.listAgents()) {
    try {
      const audio = await getGreetingAudio(agent);
      log.info({ agent: agent.name, bytes: audio.length }, "greeting cached");
      if (config.filler.enabled) {
        for (let i = 0; i < config.filler.texts.length; i++) {
          await getFillerAudio(agent, i, greetLang(agent));
        }
      }
    } catch (err) {
      log.warn({ agent: agent.name, err: (err as Error).message }, "greeting warm failed");
    }
  }
}
