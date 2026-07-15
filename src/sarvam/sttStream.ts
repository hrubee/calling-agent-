import WebSocket from "ws";
import { config } from "../config";
import { logger } from "../logger";
import { upsample8to16 } from "../audio/resample";
import { sttLanguageCode, type SttResult } from "./stt";

const log = logger.child({ mod: "stt-stream" });

// Batch outgoing audio into ~100 ms messages (5 x 20 ms telephony frames):
// 50 JSON+base64 messages/s per call is needless overhead, and the server's
// endpoint decision comes from OUR Vad anyway, so up to 100 ms of send lag
// costs nothing.
const BATCH_MS = 100;
const SAMPLES_16K_PER_MS = 16;
const BATCH_SAMPLES = BATCH_MS * SAMPLES_16K_PER_MS;

// After flush, give the server this long to produce the final transcript.
// On expiry: resolve with whatever segments were already delivered (the
// server had endpointed everything before our flush), or reject if nothing
// ever arrived — the Vad guarantees the utterance held real speech, so
// zero transcripts by now means the stream is broken, not the audio silent.
// finish() rejection routes the turn to REST STT, so a false positive only
// costs latency, never the turn.
const FINISH_TIMEOUT_MS = 3000;

// Quiet period after the flush that ends the wait. There is no protocol
// marker distinguishing "the segment the flush forced out" from "a segment
// the server's own VAD finalized that was still in flight when we flushed" —
// TCP ordering only guarantees in-flight segments land BEFORE the flush
// response. Settling on the first post-flush data could therefore truncate
// the caller's last words, so instead we settle once the server has been
// quiet for this long (re-armed by every data message, started at flush time
// when segments already arrived). Costs a fixed ~150 ms per turn against the
// ~0.5-1 s the stream saves over REST.
const SETTLE_GRACE_MS = 150;

export interface SttStreamOpts {
  /** "auto" (server-side detection) or a BCP-47 code like "hi-IN". */
  language: string;
  /** Sarvam STT model with WS support, e.g. "saaras:v3". */
  model: string;
  /** Flush watchdog override (tests). Defaults to FINISH_TIMEOUT_MS. */
  finishTimeoutMs?: number;
  /** Post-flush quiet period override (tests). Defaults to SETTLE_GRACE_MS. */
  settleGraceMs?: number;
}

/**
 * One Sarvam streaming-STT WebSocket session, scoped to a single caller
 * utterance.
 *
 * Protocol (per Sarvam docs + the sarvamai SDK): connect to
 * /speech-to-text/ws?language-code=...&model=...&input_audio_codec=pcm_s16le&
 * sample_rate=16000, then send {audio:{data:<base64 pcm>,...}} messages and
 * finally {type:"flush"}. The server VAD-segments as audio arrives and emits
 * {type:"data",data:{transcript,...}} per segment; flush forces the tail
 * segment out. The `encoding:"audio/wav"` field is what the SDK hardcodes
 * even for raw PCM — the connection-level input_audio_codec governs decode.
 *
 * The win over REST: the server transcribes WHILE the caller is speaking, so
 * the transcript lands ~one flush round-trip after the endpoint instead of a
 * whole upload + inference round-trip after it.
 */
export class SttStreamSession {
  private ws: WebSocket;
  private open = false;
  private closed = false;
  private error: Error | null = null;
  private queued: string[] = []; // JSON messages awaiting the socket open
  private batch: Buffer[] = []; // 16 kHz PCM accumulating toward BATCH_SAMPLES
  private batchSamples = 0;
  private segments: string[] = []; // non-empty transcripts, in arrival order
  private languageCode?: string;
  private lastRaw: unknown = null;
  private flushed = false;
  private finishing: {
    resolve: (r: SttResult) => void;
    reject: (err: Error) => void;
  } | null = null;
  private finishTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private readonly opts: SttStreamOpts;

  constructor(opts: SttStreamOpts) {
    this.opts = opts;
    const wsBase = config.sarvam.baseUrl.replace(/^http/, "ws");
    const params = new URLSearchParams({
      "language-code": sttLanguageCode(opts.language),
      model: opts.model,
      input_audio_codec: "pcm_s16le",
      sample_rate: "16000",
    });
    this.ws = new WebSocket(`${wsBase}/speech-to-text/ws?${params}`, {
      headers: { "api-subscription-key": config.sarvam.apiKey },
      handshakeTimeout: 5000,
    });

    this.ws.on("open", () => {
      this.open = true;
      const backlog = this.queued;
      this.queued = [];
      for (const msg of backlog) this.rawSend(msg);
    });

    this.ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "data") {
        this.lastRaw = msg;
        const t = String(msg.data?.transcript ?? "").trim();
        if (t) this.segments.push(t);
        if (msg.data?.language_code) this.languageCode = msg.data.language_code;
        // Settle once the server goes quiet after the flush — this data may
        // be an in-flight segment with the real tail still to come.
        if (this.flushed) this.armSettleGrace();
      } else if (msg.type === "error") {
        this.fail(new Error(`STT stream error: ${JSON.stringify(msg.data).slice(0, 200)}`));
      }
      // {type:"events"} (VAD signals) are not requested and ignored if sent.
    });

    this.ws.on("error", (err) => this.fail(err as Error));
    this.ws.on("close", () => {
      if (this.closed) return;
      // Server closed on its own: fine if it already delivered transcripts a
      // finish() is waiting on, fatal otherwise.
      if (this.finishing && this.segments.length > 0) {
        this.settle();
        return;
      }
      this.fail(new Error("STT stream closed unexpectedly"));
    });
  }

  /** Feed mono PCM16 samples at 8 kHz (telephony rate); safe before open. */
  sendPcm8k(pcm8k: Int16Array): void {
    if (this.closed || this.flushed || this.error) return;
    const pcm16k = upsample8to16(pcm8k);
    this.batch.push(Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength));
    this.batchSamples += pcm16k.length;
    if (this.batchSamples >= BATCH_SAMPLES) this.emitBatch();
  }

  /**
   * Flush and await the final transcript (all segments concatenated). Rejects
   * on stream failure or a silent server — the caller should fall back to
   * REST STT with the buffered utterance. Terminal: the socket closes once
   * the returned promise settles. Callable once.
   */
  finish(): Promise<SttResult> {
    return new Promise<SttResult>((resolve, reject) => {
      if (this.error || this.closed || this.finishing) {
        reject(this.error ?? new Error("STT stream already closed"));
        return;
      }
      this.finishing = { resolve, reject };
      this.flushed = true;
      this.emitBatch();
      this.enqueue(JSON.stringify({ type: "flush" }));
      // A server that already endpointed everything may not answer the flush
      // at all — with segments in hand, quiet is the completion signal.
      if (this.segments.length > 0) this.armSettleGrace();
      const ms = this.opts.finishTimeoutMs ?? FINISH_TIMEOUT_MS;
      this.finishTimer = setTimeout(() => {
        if (this.segments.length > 0) this.settle();
        else this.fail(new Error(`STT stream produced no transcript within ${ms}ms of flush`));
      }, ms);
    });
  }

  /** Tear down (call end / session abandoned). Rejects a pending finish(). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.queued = [];
    this.batch = [];
    this.batchSamples = 0;
    const f = this.finishing;
    this.finishing = null;
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
    f?.reject(this.error ?? new Error("STT stream closed"));
  }

  /** (Re)start the post-flush quiet period that completes the transcript. */
  private armSettleGrace(): void {
    if (this.closed || !this.finishing) return;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => this.settle(), this.opts.settleGraceMs ?? SETTLE_GRACE_MS);
  }

  private settle(): void {
    const f = this.finishing;
    if (!f) return;
    this.finishing = null;
    const result: SttResult = {
      transcript: this.segments.join(" ").trim(),
      languageCode: this.languageCode,
      raw: this.lastRaw,
    };
    this.close();
    f.resolve(result);
  }

  private fail(err: Error): void {
    if (this.closed) return;
    if (!this.error) this.error = err; // a later finish() rejects with this
    log.warn({ err: err.message }, "STT stream failed");
    this.close(); // rejects the pending finish(), if any
  }

  private emitBatch(): void {
    if (this.batchSamples === 0) return;
    const pcm = this.batch.length === 1 ? this.batch[0] : Buffer.concat(this.batch);
    this.batch = [];
    this.batchSamples = 0;
    this.enqueue(
      JSON.stringify({
        audio: { data: pcm.toString("base64"), sample_rate: 16000, encoding: "audio/wav" },
      }),
    );
  }

  private enqueue(msg: string): void {
    if (this.open) this.rawSend(msg);
    else this.queued.push(msg);
  }

  private rawSend(msg: string): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(msg);
      } catch (err) {
        this.fail(err as Error);
      }
    }
  }
}
