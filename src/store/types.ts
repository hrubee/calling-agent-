/** Language mode: "auto" = detect per utterance, or a BCP-47 code like "hi-IN". */
export type LanguageMode = string;

export interface Agent {
  id: string;
  name: string;
  /** System prompt describing the agent's persona, goals, and constraints. */
  systemPrompt: string;
  /** First thing the agent says when the call connects. */
  greeting: string;
  /** "auto" or a BCP-47 code (en-IN, hi-IN, ...). */
  language: LanguageMode;
  /** Sarvam TTS model, e.g. bulbul:v2 / bulbul:v3. */
  ttsModel: string;
  /** Sarvam TTS speaker/voice name. */
  ttsSpeaker: string;
  /** Optional number to transfer the call to when the agent decides to hand off. */
  transferNumber?: string;
  /** LLM temperature. */
  temperature: number;
  /** Max reply tokens per turn (kept small for snappy voice replies). */
  maxTokens: number;
  createdAt: string;
  updatedAt: string;
}

export type CallDirection = "inbound" | "outbound";

export type CallStatus =
  | "initiated"
  | "ringing"
  | "answered"
  | "in-progress"
  | "completed"
  | "failed"
  | "no-answer"
  | "ended";

export interface TranscriptTurn {
  role: "user" | "assistant" | "system";
  text: string;
  lang?: string;
  at: string;
}

export interface Call {
  id: string;
  /** VoiceLink identifiers. */
  callSid?: string;
  streamSid?: string;
  accountSid?: string;
  agentId?: string;
  agentName?: string;
  direction: CallDirection;
  from?: string;
  to?: string;
  status: CallStatus;
  startedAt: string;
  answeredAt?: string;
  endedAt?: string;
  durationSec?: number;
  recordingUrl?: string;
  transcript: TranscriptTurn[];
  customParameters?: Record<string, unknown>;
  /** Free-form notes (errors, transfer target, etc.). */
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NumberRec {
  id: string;
  /** The DID / phone number in E.164 or panel format. */
  number: string;
  label?: string;
  /** Agent that answers inbound calls on this DID. */
  agentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  /** Fallback agent when a call can't be matched to a DID or custom param. */
  defaultAgentId?: string;
  updatedAt: string;
}

export interface DBShape {
  agents: Agent[];
  numbers: NumberRec[];
  calls: Call[];
  settings: Settings;
}
