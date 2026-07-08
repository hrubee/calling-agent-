import { config } from "../config";
import { decodeAlaw } from "../audio/g711";
import { concatInt16 } from "../audio/resample";
import { Vad } from "../audio/vad";
import { bus } from "../events";
import { logger } from "../logger";
import { streamChat, type ChatMessage } from "../sarvam/chat";
import { transcribePcm8k } from "../sarvam/stt";
import { synthesizeAlaw8k } from "../sarvam/tts";
import { db } from "../store/db";
import type { Agent, TranscriptTurn } from "../store/types";
import { buildSystemPrompt, TRANSFER_TOKEN } from "./prompt";

const FRAME_SAMPLES = 160; // 20 ms @ 8 kHz
const FRAME_BYTES = 160; // A-law: 1 byte/sample

type Send = (obj: unknown) => void;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function splitSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  const re = /[^.!?।\n]*[.!?।\n]+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m[0].trim();
    if (s) sentences.push(s);
    last = re.lastIndex;
  }
  return { sentences, rest: text.slice(last) };
}

/**
 * Drives one phone call: turns caller audio into text (STT), thinks (LLM),
 * and speaks back (TTS) over the VoiceLink WebSocket — with barge-in.
 */
export class Conversation {
  private readonly agent: Agent;
  private readonly send: Send;
  readonly callId: string;
  streamSid = "";
  private readonly log = logger.child({ mod: "conversation" });

  private messages: ChatMessage[];
  private vad: Vad;
  private carry = new Int16Array(0);

  // Turn serialization
  private turnChain: Promise<void> = Promise.resolve();
  private detectedLang?: string;

  // Barge-in / playback control
  private speechGen = 0;
  private abortController: AbortController | null = null;
  private responseComplete = true;
  private botSpeaking = false;
  private pendingTransfer = false;

  // Outbound audio frame queue (A-law, 20 ms frames)
  private frameQueue: Buffer[] = [];
  private draining = false;

  // Serial TTS worker
  private ttsQueue: { text: string; gen: number }[] = [];
  private ttsWorking = false;

  private closed = false;

  constructor(opts: { agent: Agent; send: Send; callId: string }) {
    this.agent = opts.agent;
    this.send = opts.send;
    this.callId = opts.callId;
    this.messages = [{ role: "system", content: buildSystemPrompt(this.agent) }];
    this.vad = new Vad({
      sampleRate: 8000,
      threshold: config.vad.threshold,
      silenceMs: config.vad.silenceMs,
      minSpeechMs: config.vad.minSpeechMs,
      maxMs: config.vad.utteranceMaxMs,
    });
  }

  // ---- Lifecycle ----

  async start(streamSid: string): Promise<void> {
    this.streamSid = streamSid;
    if (config.greetingEnabled && this.agent.greeting?.trim()) {
      await this.greet();
    }
  }

  onMark(name: string): void {
    this.log.debug({ name, callId: this.callId }, "mark echo");
  }

  onStop(): void {
    this.finish("ended");
  }

  close(): void {
    this.finish("ended");
  }

  private finish(_reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.speechGen++; // cancel any playback/tts
    this.frameQueue = [];
    this.ttsQueue = [];
    this.abortController?.abort();
  }

  // ---- Inbound audio ----

  onInboundAudio(base64: string): void {
    if (this.closed) return;
    let pcm: Int16Array;
    try {
      pcm = decodeAlaw(Buffer.from(base64, "base64"));
    } catch {
      return;
    }
    const data = this.carry.length ? concatInt16([this.carry, pcm]) : pcm;
    let off = 0;
    for (; off + FRAME_SAMPLES <= data.length; off += FRAME_SAMPLES) {
      this.feedVad(data.subarray(off, off + FRAME_SAMPLES));
    }
    this.carry = data.slice(off);
  }

  private feedVad(frame: Int16Array): void {
    const r = this.vad.push(frame);
    if (r.type === "speech-start") {
      if (this.botSpeaking || this.ttsWorking || this.frameQueue.length > 0) this.bargeIn();
    } else if (r.type === "utterance") {
      const pcm = r.pcm;
      this.turnChain = this.turnChain.then(() =>
        this.handleUtterance(pcm).catch((err) => this.log.error({ err }, "turn failed")),
      );
    }
  }

  private bargeIn(): void {
    this.log.debug({ callId: this.callId }, "barge-in");
    this.speechGen++;
    this.frameQueue = [];
    this.ttsQueue = [];
    this.abortController?.abort();
    this.botSpeaking = false;
    this.pendingTransfer = false;
    if (this.streamSid) this.send({ event: "clear", stream_sid: this.streamSid });
  }

  // ---- Turns ----

  private async handleUtterance(pcm8k: Int16Array): Promise<void> {
    if (this.closed) return;
    let transcript = "";
    try {
      const r = await transcribePcm8k(pcm8k, this.agent.language);
      transcript = r.transcript;
      if (r.languageCode) this.detectedLang = r.languageCode;
    } catch (err) {
      this.log.error({ err }, "STT failed");
      return;
    }
    if (!transcript) return;

    this.recordTurn({ role: "user", text: transcript, lang: this.detectedLang });
    this.messages.push({ role: "user", content: transcript });

    await this.respond();
  }

  private async greet(): Promise<void> {
    this.beginResponse();
    const gen = this.speechGen;
    const text = this.agent.greeting.trim();
    this.recordTurn({ role: "assistant", text });
    this.messages.push({ role: "assistant", content: text });
    this.enqueueSentence(text, gen);
    this.responseComplete = true;
  }

  private async respond(): Promise<void> {
    this.beginResponse();
    const gen = this.speechGen;
    let buffer = "";
    let full = "";

    try {
      full = await streamChat(this.messages, {
        model: config.sarvam.chatModel,
        temperature: this.agent.temperature,
        // Reasoning models need headroom for "thinking" before the answer;
        // never send less than the configured budget.
        maxTokens: Math.max(this.agent.maxTokens, config.sarvam.chatMaxTokens),
        signal: this.abortController!.signal,
        onDelta: (d) => {
          if (gen !== this.speechGen) return;
          buffer += d;
          if (buffer.includes(TRANSFER_TOKEN)) {
            this.pendingTransfer = true;
            buffer = buffer.split(TRANSFER_TOKEN).join(" ");
          }
          const { sentences, rest } = splitSentences(buffer);
          for (const s of sentences) this.enqueueSentence(s, gen);
          // Flush an over-long tail without a terminator to keep latency low.
          if (rest.length > 240) {
            this.enqueueSentence(rest, gen);
            buffer = "";
          } else {
            buffer = rest;
          }
        },
      });
    } catch (err: any) {
      if (err?.name === "AbortError") return; // barged-in
      this.log.error({ err }, "chat failed");
    }

    if (gen !== this.speechGen) return; // superseded

    let tail = buffer.trim();
    if (tail.includes(TRANSFER_TOKEN)) {
      this.pendingTransfer = true;
      tail = tail.split(TRANSFER_TOKEN).join(" ").trim();
    }
    if (tail) this.enqueueSentence(tail, gen);

    const spoken = full.split(TRANSFER_TOKEN).join(" ").trim();
    if (spoken) {
      this.recordTurn({ role: "assistant", text: spoken, lang: this.ttsLang() });
      this.messages.push({ role: "assistant", content: spoken });
    }
    this.responseComplete = true;
  }

  private beginResponse(): void {
    this.abortController = new AbortController();
    this.responseComplete = false;
    this.pendingTransfer = false;
  }

  // ---- TTS worker (serial, preserves sentence order) ----

  private enqueueSentence(text: string, gen: number): void {
    const t = text.trim();
    if (!t) return;
    this.ttsQueue.push({ text: t, gen });
    void this.runTtsWorker();
  }

  private async runTtsWorker(): Promise<void> {
    if (this.ttsWorking) return;
    this.ttsWorking = true;
    try {
      while (this.ttsQueue.length) {
        const item = this.ttsQueue.shift()!;
        if (item.gen !== this.speechGen || this.closed) continue;
        try {
          const alaw = await synthesizeAlaw8k(item.text, {
            targetLanguage: this.ttsLang(),
            speaker: this.agent.ttsSpeaker,
            model: this.agent.ttsModel,
          });
          if (item.gen !== this.speechGen || this.closed) continue;
          this.enqueueAlaw(alaw);
        } catch (err) {
          this.log.error({ err }, "TTS failed");
        }
      }
    } finally {
      this.ttsWorking = false;
    }
  }

  private ttsLang(): string {
    if (this.agent.language && this.agent.language !== "auto") return this.agent.language;
    return this.detectedLang || config.ttsFallbackLanguage;
  }

  // ---- Outbound audio playback ----

  private enqueueAlaw(alaw: Buffer): void {
    for (let i = 0; i < alaw.length; i += FRAME_BYTES) {
      this.frameQueue.push(alaw.subarray(i, Math.min(i + FRAME_BYTES, alaw.length)));
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const gen = this.speechGen;
    this.botSpeaking = true;
    try {
      while (!this.closed) {
        if (gen !== this.speechGen) break;
        if (this.frameQueue.length === 0) {
          // Response still being synthesized? wait for more frames.
          if (this.responseComplete && !this.ttsWorking && this.ttsQueue.length === 0) break;
          await sleep(20);
          continue;
        }
        // Send ~100 ms of audio, then pace to roughly real time.
        for (let k = 0; k < 5 && this.frameQueue.length && gen === this.speechGen; k++) {
          const frame = this.frameQueue.shift()!;
          this.send({ event: "media", media: { payload: frame.toString("base64") } });
        }
        await sleep(90);
      }
    } finally {
      this.draining = false;
    }

    if (gen === this.speechGen && !this.closed) {
      this.botSpeaking = false;
      this.send({ event: "mark", mark: { name: "response_done" } });
      if (this.pendingTransfer && this.agent.transferNumber) {
        this.doTransfer();
      }
    }
  }

  private doTransfer(): void {
    const digits = (this.agent.transferNumber || "").replace(/[^\d]/g, "");
    if (!digits) return;
    this.pendingTransfer = false;
    this.log.info({ callId: this.callId, to: digits }, "transferring call");
    this.send({ event: "transfer", target: Number(digits) });
    db.updateCall(this.callId, { notes: `transferred to ${digits}`, status: "completed" });
  }

  // ---- Persistence ----

  private recordTurn(t: Omit<TranscriptTurn, "at">): void {
    const turn: TranscriptTurn = { ...t, at: new Date().toISOString() };
    db.addTranscript(this.callId, turn);
    bus.emitEvent({ type: "call.transcript", callId: this.callId, turn });
    const call = db.getCall(this.callId);
    if (call) bus.emitEvent({ type: "call.updated", call });
  }
}
