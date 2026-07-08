import { concatInt16 } from "./resample";

/**
 * Energy-based voice activity detector with endpointing.
 *
 * Feed it fixed-size PCM16 frames (e.g. 160 samples = 20 ms at 8 kHz). It tracks
 * speech vs. silence using short-term RMS energy and emits a complete utterance
 * once it sees enough trailing silence after real speech (or hits a max length).
 *
 * A small pre-roll is kept so the very start of speech isn't clipped.
 */

export type VadResult =
  | { type: "silence" }
  | { type: "speech-start" }
  | { type: "speech" }
  | { type: "utterance"; pcm: Int16Array; durationMs: number };

export interface VadOptions {
  sampleRate: number;
  /** RMS threshold above which a frame counts as speech. */
  threshold: number;
  /** Trailing silence (ms) that ends an utterance. */
  silenceMs: number;
  /** Minimum speech (ms) required before an utterance is considered valid. */
  minSpeechMs: number;
  /** Hard cap (ms) on a single utterance. */
  maxMs: number;
  /** Pre-roll (ms) prepended to captured speech. */
  preRollMs?: number;
}

export class Vad {
  private opts: Required<VadOptions>;
  private state: "idle" | "speaking" = "idle";
  private buffer: Int16Array[] = [];
  private preRoll: Int16Array[] = [];
  private silenceMs = 0;
  private speechMs = 0;
  private capturedMs = 0;

  constructor(opts: VadOptions) {
    this.opts = { preRollMs: 240, ...opts };
  }

  get speaking(): boolean {
    return this.state === "speaking";
  }

  reset(): void {
    this.state = "idle";
    this.buffer = [];
    this.preRoll = [];
    this.silenceMs = 0;
    this.speechMs = 0;
    this.capturedMs = 0;
  }

  private static rms(frame: Int16Array): number {
    if (frame.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    return Math.sqrt(sum / frame.length);
  }

  push(frame: Int16Array): VadResult {
    const frameMs = (frame.length / this.opts.sampleRate) * 1000;
    const voiced = Vad.rms(frame) >= this.opts.threshold;

    if (this.state === "idle") {
      // Maintain a rolling pre-roll of recent frames.
      this.preRoll.push(frame);
      let preRollTotal = this.preRoll.reduce((a, f) => a + (f.length / this.opts.sampleRate) * 1000, 0);
      while (preRollTotal > this.opts.preRollMs && this.preRoll.length > 1) {
        const dropped = this.preRoll.shift()!;
        preRollTotal -= (dropped.length / this.opts.sampleRate) * 1000;
      }

      if (voiced) {
        this.state = "speaking";
        this.buffer = [...this.preRoll];
        this.capturedMs = this.buffer.reduce(
          (a, f) => a + (f.length / this.opts.sampleRate) * 1000,
          0,
        );
        this.speechMs = frameMs;
        this.silenceMs = 0;
        this.preRoll = [];
        return { type: "speech-start" };
      }
      return { type: "silence" };
    }

    // state === "speaking"
    this.buffer.push(frame);
    this.capturedMs += frameMs;
    if (voiced) {
      this.speechMs += frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += frameMs;
    }

    const endpointed = this.silenceMs >= this.opts.silenceMs && this.speechMs >= this.opts.minSpeechMs;
    const tooLong = this.capturedMs >= this.opts.maxMs;

    if (endpointed || tooLong) {
      const pcm = concatInt16(this.buffer);
      const durationMs = this.capturedMs;
      const hadSpeech = this.speechMs >= this.opts.minSpeechMs;
      this.reset();
      if (!hadSpeech) return { type: "silence" };
      return { type: "utterance", pcm, durationMs };
    }
    return { type: "speech" };
  }
}
