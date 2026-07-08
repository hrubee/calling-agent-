import { config } from "../config";
import { logger } from "../logger";
import { synthesizeAlaw8k } from "../sarvam/tts";
import { db } from "../store/db";
import type { Agent } from "../store/types";

/**
 * Pre-synthesized greeting audio cache.
 *
 * On an outbound/inbound call, the greeting must play the instant the call
 * connects — otherwise the caller hears dead air while we call the TTS API and
 * often hangs up. We synthesize each agent's greeting once and cache the raw
 * A-law bytes, keyed by the content that affects the audio.
 */

const log = logger.child({ mod: "greeting" });
const cache = new Map<string, { key: string; audio: Buffer }>();

function greetLang(agent: Agent): string {
  return agent.language && agent.language !== "auto" ? agent.language : config.ttsFallbackLanguage;
}

function cacheKey(agent: Agent): string {
  return [agent.greeting.trim(), greetLang(agent), agent.ttsSpeaker, agent.ttsModel].join("|");
}

/** Return cached greeting audio (A-law 8k), synthesizing + caching on a miss. */
export async function getGreetingAudio(agent: Agent): Promise<Buffer> {
  const text = agent.greeting?.trim();
  if (!text || !config.sarvam.configured) return Buffer.alloc(0);

  const key = cacheKey(agent);
  const hit = cache.get(agent.id);
  if (hit && hit.key === key) return hit.audio;

  const audio = await synthesizeAlaw8k(text, {
    targetLanguage: greetLang(agent),
    speaker: agent.ttsSpeaker,
    model: agent.ttsModel,
  });
  cache.set(agent.id, { key, audio });
  return audio;
}

/** Drop a cached greeting (call when an agent is edited/deleted). */
export function invalidateGreeting(agentId: string): void {
  cache.delete(agentId);
}

/** Warm the cache for every agent at startup so the first call is instant too. */
export async function warmAllGreetings(): Promise<void> {
  if (!config.sarvam.configured) return;
  for (const agent of db.listAgents()) {
    try {
      const audio = await getGreetingAudio(agent);
      log.info({ agent: agent.name, bytes: audio.length }, "greeting cached");
    } catch (err) {
      log.warn({ agent: agent.name, err: (err as Error).message }, "greeting warm failed");
    }
  }
}
