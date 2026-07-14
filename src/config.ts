import "dotenv/config";
import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Central configuration, parsed and validated from the environment.
 *
 * Secrets that are missing are auto-generated at boot (and logged) so the app
 * runs out-of-the-box locally. In production you should ALWAYS set them
 * explicitly so they survive restarts.
 */

function genToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/** Track which secrets we generated, so index.ts can warn about them. */
export const generatedSecrets: string[] = [];

function orGenerate(value: string | undefined, name: string, bytes = 24): string {
  if (value && value.trim().length > 0) return value.trim();
  const v = genToken(bytes);
  generatedSecrets.push(name);
  return v;
}

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : /^(1|true|yes|on)$/i.test(v)));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().finite());

const EnvSchema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  PORT: num(8080),
  APP_BASE_URL: z.string().optional().default(""),
  LOG_LEVEL: z.string().optional().default("info"),

  DASHBOARD_PASSWORD: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  WSS_TOKEN: z.string().optional(),
  WEBHOOK_TOKEN: z.string().optional(),

  SARVAM_API_KEY: z.string().optional().default(""),
  SARVAM_BASE_URL: z.string().optional().default("https://api.sarvam.ai"),
  SARVAM_CHAT_MODEL: z.string().optional().default("sarvam-30b"),
  // Sarvam chat models are reasoning models: they spend tokens "thinking" before
  // answering (observed ~5-7k chars of reasoning even at low effort), so
  // max_tokens must be generous or the answer comes back empty.
  SARVAM_REASONING_EFFORT: z.enum(["low", "medium", "high"]).optional().default("low"),
  SARVAM_MAX_TOKENS: num(4096),
  SARVAM_STT_MODEL: z.string().optional().default("saaras:v3"),
  SARVAM_TTS_MODEL: z.string().optional().default("bulbul:v2"),
  SARVAM_TTS_SPEAKER: z.string().optional().default("anushka"),

  DEFAULT_LANGUAGE: z.string().optional().default("auto"),
  TTS_FALLBACK_LANGUAGE: z.string().optional().default("en-IN"),

  VOICELINK_LEAD_API_URL: z.string().optional().default(""),
  VOICELINK_LEAD_API_KEY: z.string().optional().default(""),
  VOICELINK_LEAD_AUTH_STYLE: z
    .enum(["bearer", "header", "query", "none"])
    .optional()
    .default("bearer"),
  VOICELINK_LEAD_AUTH_NAME: z.string().optional().default("Authorization"),
  VOICELINK_LEAD_METHOD: z.string().optional().default("POST"),
  VOICELINK_LEAD_FIELD_PHONE: z.string().optional().default("customer_number"),
  VOICELINK_LEAD_FIELD_DID: z.string().optional().default("did_number"),
  VOICELINK_LEAD_FIELD_PARAMS: z.string().optional().default("custom_parameters"),
  VOICELINK_LEAD_EXTRA_JSON: z.string().optional().default("{}"),

  DATA_DIR: z.string().optional().default("./data"),

  VAD_THRESHOLD: num(650),
  VAD_SILENCE_MS: num(450),
  VAD_MIN_SPEECH_MS: num(250),
  // Trailing silence (ms) at which STT starts speculatively, before the final
  // endpoint. Discarded if the caller resumes speaking. 0 disables.
  VAD_SPECULATIVE_MS: num(250),
  UTTERANCE_MAX_MS: num(15000),
  GREETING_ENABLED: bool(true),

  // Filler phrases ("Hmm.") played if the reply isn't ready within the delay,
  // so the caller never sits in dead air. Semicolon-separated, rotated per turn.
  FILLER_ENABLED: bool(true),
  FILLER_DELAY_MS: num(900),
  FILLER_TEXTS: z.string().optional().default("Hmm."),
});

const parsed = EnvSchema.parse(process.env);

let extraLead: Record<string, unknown> = {};
try {
  extraLead = JSON.parse(parsed.VOICELINK_LEAD_EXTRA_JSON || "{}");
} catch {
  extraLead = {};
}

export const config = {
  env: parsed.NODE_ENV,
  isProd: parsed.NODE_ENV === "production",
  port: parsed.PORT,
  appBaseUrl: parsed.APP_BASE_URL.replace(/\/$/, ""),
  logLevel: parsed.LOG_LEVEL,

  dashboardPassword: orGenerate(parsed.DASHBOARD_PASSWORD, "DASHBOARD_PASSWORD", 12),
  sessionSecret: orGenerate(parsed.SESSION_SECRET, "SESSION_SECRET", 32),
  wssToken: orGenerate(parsed.WSS_TOKEN, "WSS_TOKEN", 18),
  webhookToken: orGenerate(parsed.WEBHOOK_TOKEN, "WEBHOOK_TOKEN", 18),

  sarvam: {
    apiKey: parsed.SARVAM_API_KEY,
    baseUrl: parsed.SARVAM_BASE_URL.replace(/\/$/, ""),
    chatModel: parsed.SARVAM_CHAT_MODEL,
    reasoningEffort: parsed.SARVAM_REASONING_EFFORT,
    chatMaxTokens: parsed.SARVAM_MAX_TOKENS,
    sttModel: parsed.SARVAM_STT_MODEL,
    ttsModel: parsed.SARVAM_TTS_MODEL,
    ttsSpeaker: parsed.SARVAM_TTS_SPEAKER,
    configured: parsed.SARVAM_API_KEY.trim().length > 0,
  },

  defaultLanguage: parsed.DEFAULT_LANGUAGE,
  ttsFallbackLanguage: parsed.TTS_FALLBACK_LANGUAGE,

  voicelink: {
    lead: {
      url: parsed.VOICELINK_LEAD_API_URL,
      apiKey: parsed.VOICELINK_LEAD_API_KEY,
      authStyle: parsed.VOICELINK_LEAD_AUTH_STYLE,
      authName: parsed.VOICELINK_LEAD_AUTH_NAME,
      method: parsed.VOICELINK_LEAD_METHOD.toUpperCase(),
      fieldPhone: parsed.VOICELINK_LEAD_FIELD_PHONE,
      fieldDid: parsed.VOICELINK_LEAD_FIELD_DID,
      fieldParams: parsed.VOICELINK_LEAD_FIELD_PARAMS,
      extra: extraLead,
      configured: parsed.VOICELINK_LEAD_API_URL.trim().length > 0,
    },
  },

  dataDir: parsed.DATA_DIR,

  vad: {
    threshold: parsed.VAD_THRESHOLD,
    silenceMs: parsed.VAD_SILENCE_MS,
    minSpeechMs: parsed.VAD_MIN_SPEECH_MS,
    speculativeMs: parsed.VAD_SPECULATIVE_MS,
    utteranceMaxMs: parsed.UTTERANCE_MAX_MS,
  },
  greetingEnabled: parsed.GREETING_ENABLED,

  filler: {
    enabled: parsed.FILLER_ENABLED,
    delayMs: parsed.FILLER_DELAY_MS,
    texts: parsed.FILLER_TEXTS.split(";")
      .map((s) => s.trim())
      .filter(Boolean),
  },
} as const;

export type Config = typeof config;

/** The URLs the operator must paste into the VoiceLink panel. */
export function panelUrls() {
  const base = config.appBaseUrl || `http://localhost:${config.port}`;
  const wssBase = base.replace(/^http/, "ws");
  return {
    wssUrl: `${wssBase}/media-stream?token=${config.wssToken}`,
    webhookUrl: `${base}/webhooks/voicelink?token=${config.webhookToken}`,
  };
}
