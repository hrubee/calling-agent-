import { config } from "../config";
import { assertConfigured, SarvamError, sarvamHeaders, sarvamUrl } from "./client";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Called with each streamed text delta. */
  onDelta?: (delta: string) => void;
  /** External abort (e.g. barge-in cancels the in-flight reply). */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Streamed chat completion. Returns the full assistant text. */
export async function streamChat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  assertConfigured();
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30000);
  const onExternalAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const res = await fetch(sarvamUrl("/v1/chat/completions"), {
      method: "POST",
      headers: sarvamHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: opts.model || config.sarvam.chatModel,
        messages,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? config.sarvam.chatMaxTokens,
        reasoning_effort: config.sarvam.reasoningEffort,
        stream: true,
      }),
      signal: ctrl.signal,
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new SarvamError(res.status, body);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
          // ignore keep-alive / partial fragments
        }
      }
    }
    return full.trim();
  } finally {
    clearTimeout(timeout);
    if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
  }
}

/** Non-streaming chat completion. Returns the assistant text. */
export async function completeChat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  assertConfigured();
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30000);
  try {
    const res = await fetch(sarvamUrl("/v1/chat/completions"), {
      method: "POST",
      headers: sarvamHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: opts.model || config.sarvam.chatModel,
        messages,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? config.sarvam.chatMaxTokens,
        reasoning_effort: config.sarvam.reasoningEffort,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new SarvamError(res.status, text);
    const json = JSON.parse(text);
    return (json.choices?.[0]?.message?.content ?? "").trim();
  } finally {
    clearTimeout(timeout);
  }
}
