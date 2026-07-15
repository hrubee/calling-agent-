import WebSocket from "ws";
import { config } from "../config";
import { logger } from "../logger";

const log = logger.child({ mod: "tts-stream" });

const FRAME_BYTES = 160; // 20 ms of A-law @ 8 kHz
const ALAW_SILENCE = 0xd5;
// Fail the session when a pending flush produces neither audio nor its
// "final" event for this long (half-open socket / server stall). Only the
// handshake was time-bounded before; a dropped "final" hung the reply
// forever with botSpeaking stuck. fail() routes lost sentences to the REST
// fallback, so a false positive only costs latency, never the reply.
const STALL_TIMEOUT_MS = 10000;

export interface TtsStreamOpts {
  model: string;
  speaker: string;
  targetLanguage: string;
  /** Called with A-law audio sliced to whole 20 ms frames, in order. */
  onAudio: (alaw: Buffer) => void;
  /** All text sent so far has been fully synthesized (per-flush "final" events drained). */
  onIdle: () => void;
  /** Stream failed. `pendingTexts` = sentences whose audio may be lost. */
  onError: (err: Error, pendingTexts: string[]) => void;
  /** Stall watchdog override (tests). Defaults to STALL_TIMEOUT_MS. */
  stallTimeoutMs?: number;
}

/**
 * One Sarvam TTS WebSocket session, scoped to a single response generation.
 *
 * Protocol (verified live): connect to /text-to-speech/ws?model=...&
 * send_completion_event=true, send {type:"config"} once, then per sentence
 * {type:"text"} + {type:"flush"}. Audio arrives as {type:"audio"} chunks and
 * every flush eventually yields {type:"event",data:{event_type:"final"}}.
 * First audio ~0.5 s after the first sentence — vs ~1.6 s via REST on
 * bulbul:v3.
 */
export class TtsStreamSession {
  private ws: WebSocket;
  private open = false;
  private closed = false;
  private queued: string[] = []; // texts submitted before the socket opened
  private pendingTexts: string[] = []; // sent, awaiting their "final" event
  private remainder: Buffer = Buffer.alloc(0);
  private watchdog: NodeJS.Timeout | null = null;
  private readonly opts: TtsStreamOpts;

  constructor(opts: TtsStreamOpts) {
    this.opts = opts;
    const wsBase = config.sarvam.baseUrl.replace(/^http/, "ws");
    const url = `${wsBase}/text-to-speech/ws?model=${encodeURIComponent(opts.model)}&send_completion_event=true`;
    this.ws = new WebSocket(url, {
      headers: { "api-subscription-key": config.sarvam.apiKey },
      handshakeTimeout: 5000,
    });

    this.ws.on("open", () => {
      this.open = true;
      this.send({
        type: "config",
        data: {
          target_language_code: this.opts.targetLanguage,
          speaker: this.opts.speaker,
          output_audio_codec: "alaw",
          speech_sample_rate: 8000,
          enable_preprocessing: true,
        },
      });
      const backlog = this.queued;
      this.queued = [];
      for (const text of backlog) this.sendText(text);
    });

    this.ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "audio" && msg.data?.audio) {
        if (this.pendingTexts.length > 0) this.armWatchdog(); // progress — push the deadline
        this.emitAudio(Buffer.from(msg.data.audio, "base64"));
      } else if (msg.type === "event" && msg.data?.event_type === "final") {
        if (this.pendingTexts.length === 0) return; // spurious duplicate final — ignore
        this.pendingTexts.shift();
        if (this.pendingTexts.length === 0) {
          this.clearWatchdog();
          this.flushRemainder();
          this.opts.onIdle();
        } else {
          this.armWatchdog();
        }
      } else if (msg.type === "error") {
        this.fail(new Error(`TTS stream error: ${JSON.stringify(msg).slice(0, 200)}`));
      }
    });

    this.ws.on("error", (err) => this.fail(err as Error));
    this.ws.on("close", () => {
      // A close while sentences are still pending means their audio was lost.
      if (!this.closed && this.pendingTexts.length > 0) {
        this.fail(new Error("TTS stream closed with pending sentences"));
      }
    });
  }

  /** Number of sentences sent (or queued) whose audio hasn't fully arrived. */
  get pending(): number {
    return this.pendingTexts.length + this.queued.length;
  }

  /** Queue a sentence for synthesis. */
  speak(text: string): void {
    if (this.closed) return;
    if (!this.open) {
      this.queued.push(text);
      return;
    }
    this.sendText(text);
  }

  /** Tear down (barge-in / call end / response superseded). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearWatchdog();
    this.remainder = Buffer.alloc(0);
    this.pendingTexts = [];
    this.queued = [];
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }

  private sendText(text: string): void {
    this.pendingTexts.push(text);
    this.send({ type: "text", data: { text } });
    this.send({ type: "flush" });
    this.armWatchdog();
  }

  /** (Re)start the stall deadline while any flush is outstanding. */
  private armWatchdog(): void {
    if (this.closed) return;
    if (this.watchdog) clearTimeout(this.watchdog);
    const ms = this.opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    this.watchdog = setTimeout(() => {
      this.fail(
        new Error(
          `TTS stream stalled: no audio or final event for ${ms}ms (${this.pending} pending)`,
        ),
      );
    }, ms);
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  private send(obj: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch (err) {
        this.fail(err as Error);
      }
    }
  }

  /** Slice incoming audio into whole 20 ms frames; keep the tail for the next chunk. */
  private emitAudio(chunk: Buffer): void {
    if (this.closed) return;
    const buf = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    const whole = Math.floor(buf.length / FRAME_BYTES) * FRAME_BYTES;
    if (whole > 0) this.opts.onAudio(buf.subarray(0, whole));
    this.remainder = Buffer.from(buf.subarray(whole));
  }

  /** Pad and emit the tail only at an utterance boundary (never mid-audio). */
  private flushRemainder(): void {
    if (this.remainder.length === 0) return;
    const padded = Buffer.alloc(FRAME_BYTES, ALAW_SILENCE);
    this.remainder.copy(padded);
    this.remainder = Buffer.alloc(0);
    this.opts.onAudio(padded);
  }

  private fail(err: Error): void {
    if (this.closed) return;
    const lost = [...this.pendingTexts, ...this.queued];
    this.close();
    log.warn({ err: err.message, lostSentences: lost.length }, "TTS stream failed");
    this.opts.onError(err, lost);
  }
}
