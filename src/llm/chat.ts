import { config } from "../config";
import { logger } from "../logger";
import { streamChat, type ChatMessage, type ChatOptions } from "../sarvam/chat";

const log = logger.child({ mod: "llm" });

/** Human-readable description of the active reply LLM (for health/settings). */
export function chatProviderInfo(): string {
  if (config.chatLlm.configured) {
    let host = config.chatLlm.baseUrl;
    try {
      host = new URL(config.chatLlm.baseUrl).host;
    } catch {
      /* keep raw */
    }
    return `${config.chatLlm.model} @ ${host}`;
  }
  return `${config.sarvam.chatModel} @ sarvam (reasoning model, slow)`;
}

/**
 * Stream the assistant reply for a conversation turn.
 *
 * Dispatches to the configured fast OpenAI-compatible endpoint (CHAT_LLM_*),
 * falling back to Sarvam chat when none is configured. Sarvam's chat models
 * spend 5-10s "reasoning" before the first token; a fast external model
 * brings time-to-first-token down to a few hundred ms while Sarvam still
 * powers STT and the TTS voice.
 */
export async function streamReply(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  if (!config.chatLlm.configured) return streamChat(messages, opts);

  const ctrl = new AbortController();
  // Idle watchdog, not a whole-stream cap: reset on every chunk so a healthy
  // long reply is never cut off mid-sentence — only a silent/stalled stream
  // times out. Surfaced as TimeoutError so callers can tell it apart from a
  // barge-in abort (which skips turn bookkeeping; a timeout must not).
  const timeoutMs = opts.timeoutMs ?? 20000;
  let timedOut = false;
  const onStall = () => {
    timedOut = true;
    ctrl.abort();
  };
  let timeout = setTimeout(onStall, timeoutMs);
  const bumpTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(onStall, timeoutMs);
  };
  const onExternalAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const res = await fetch(`${config.chatLlm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.chatLlm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.chatLlm.model,
        messages,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? config.chatLlm.maxTokens,
        stream: true,
      }),
      signal: ctrl.signal,
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`chat LLM error ${res.status}: ${body.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bumpTimeout();
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta: string = json.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            full += delta;
            opts.onDelta?.(delta);
          }
        } catch {
          // ignore keep-alives / partial fragments
        }
      }
    }
    return full.trim();
  } catch (err) {
    if (timedOut && (err as Error)?.name === "AbortError" && !opts.signal?.aborted) {
      log.error({ provider: chatProviderInfo(), timeoutMs }, "fast LLM stream stalled — timed out");
      const e = new Error(`chat LLM stalled: no data for ${timeoutMs}ms`);
      e.name = "TimeoutError";
      throw e;
    }
    // Surface external aborts as-is (barge-in); log real failures for diagnosis.
    if ((err as Error)?.name !== "AbortError") {
      log.error({ err, provider: chatProviderInfo() }, "fast LLM request failed");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
  }
}
