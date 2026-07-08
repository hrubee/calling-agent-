import { config } from "../config";

export class SarvamError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Sarvam API error ${status}: ${body.slice(0, 300)}`);
    this.name = "SarvamError";
    this.status = status;
    this.body = body;
  }
}

export function sarvamHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "api-subscription-key": config.sarvam.apiKey,
    ...extra,
  };
}

export function sarvamUrl(path: string): string {
  return `${config.sarvam.baseUrl}${path.startsWith("/") ? path : "/" + path}`;
}

/** fetch with a timeout via AbortController. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function assertConfigured(): void {
  if (!config.sarvam.configured) {
    throw new SarvamError(0, "", "SARVAM_API_KEY is not set — configure it to enable STT/LLM/TTS.");
  }
}
