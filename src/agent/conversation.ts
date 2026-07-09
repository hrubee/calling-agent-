import { config } from "../config";
import { decodeAlaw } from "../audio/g711";
import { concatInt16 } from "../audio/resample";
import { Vad } from "../audio/vad";
import { bus } from "../events";
import { logger } from "../logger";
import { streamChat, type ChatMessage } from "../sarvam/chat";
import { warmSarvam } from "../sarvam/client";
import { transcribePcm8k, type SttResult } from "../sarvam/stt";
import { synthesizeAlaw8k } from "../sarvam/tts";
import { db } from "../store/db";
import type { Agent, TranscriptTurn } from "../store/types";
import { buildSystemPrompt, TRANSFER_TOKEN } from "./prompt";
import { getFillerAudio, getGreetingAudio } from "./greeting";

const FRAME_SAMPLES = 160; // 20 ms @ 8 kHz
const FRAME_BYTES = 160; // A-law: 1 byte/sample

// The LLM can "think" for 5s+; chain up to this many fillers while waiting.
const MAX_FILLERS_PER_TURN = 2;
const FILLER_REARM_MS = 2500;

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

const FIRST_CHUNK_MIN = 24;
const FIRST_CHUNK_MAX = 60;

/**
 * Where to cut the FIRST audible chunk of a reply so TTS can start before a
 * full sentence exists: the first clause boundary past FIRST_CHUNK_MIN chars,
 * else a word boundary once the text exceeds FIRST_CHUNK_MAX. Returns 0 if
 * the text should keep accumulating.
 */
function firstClauseCut(text: string): number {
  const re = /[,;:]\s/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index + 1 >= FIRST_CHUNK_MIN) return m.index + 1;
  }
  if (text.length >= FIRST_CHUNK_MAX) {
    const sp = text.lastIndexOf(" ", FIRST_CHUNK_MAX);
    if (sp >= FIRST_CHUNK_MIN) return sp;
  }
  return 0;
}

/** Per-turn latency marks (ms since the caller stopped talking). */
interface TurnMarks {
  t0: number;
  sttMs?: number;
  llmFirstMs?: number;
  ttsFirstMs?: number;
  firstAudioMs?: number;
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

  // Speculative STT started during the caller's trailing silence.
  private specStt: Promise<SttResult | null> | null = null;

  // Filler ("Hmm.") played if the reply isn't ready within the delay.
  private fillerTimer: NodeJS.Timeout | null = null;
  private fillerIdx = 0;
  private fillersThisTurn = 0;

  // Per-turn latency instrumentation.
  private marks: TurnMarks | null = null;

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
      earlyMs: config.vad.speculativeMs,
    });
  }

  // ---- Lifecycle ----

  async start(streamSid: string): Promise<void> {
    this.streamSid = streamSid;
    warmSarvam(); // pre-open the TLS connection before the first turn
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
    this.specStt = null;
    this.clearFiller();
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
    switch (r.type) {
      case "speech-start":
        warmSarvam(); // STT follows within seconds — pay the TLS handshake now
        this.specStt = null;
        if (this.botSpeaking || this.ttsWorking || this.frameQueue.length > 0) this.bargeIn();
        break;
      case "speech":
        // Caller resumed after a pause — any speculative transcript is stale.
        if (r.voiced) this.specStt = null;
        break;
      case "speech-early":
        // Start STT during the trailing silence; discarded if speech resumes.
        this.specStt = transcribePcm8k(r.pcm, this.agent.language).catch((err) => {
          this.log.debug({ err }, "speculative STT failed");
          return null;
        });
        break;
      case "utterance": {
        const pcm = r.pcm;
        const spec = this.specStt;
        this.specStt = null;
        this.turnChain = this.turnChain.then(() =>
          this.handleUtterance(pcm, spec).catch((err) => this.log.error({ err }, "turn failed")),
        );
        break;
      }
    }
  }

  private bargeIn(): void {
    this.log.debug({ callId: this.callId }, "barge-in");
    this.speechGen++;
    this.frameQueue = [];
    this.ttsQueue = [];
    this.clearFiller();
    this.abortController?.abort();
    this.botSpeaking = false;
    this.pendingTransfer = false;
    if (this.streamSid) this.send({ event: "clear", stream_sid: this.streamSid });
  }

  // ---- Turns ----

  private async handleUtterance(
    pcm8k: Int16Array,
    spec?: Promise<SttResult | null> | null,
  ): Promise<void> {
    if (this.closed) return;
    this.marks = { t0: Date.now() };
    this.fillersThisTurn = 0;
    this.armFiller(this.speechGen);

    let transcript = "";
    try {
      let r = spec ? await spec : null;
      if (!r) r = await transcribePcm8k(pcm8k, this.agent.language);
      transcript = r.transcript;
      if (r.languageCode) this.detectedLang = r.languageCode;
    } catch (err) {
      this.log.error({ err }, "STT failed");
      this.clearFiller();
      return;
    }
    if (this.marks) this.marks.sttMs = Date.now() - this.marks.t0;
    if (!transcript) {
      this.clearFiller();
      return;
    }

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
    try {
      const audio = await getGreetingAudio(this.agent); // instant if pre-cached
      if (gen !== this.speechGen || this.closed) return;
      if (audio.length) this.enqueueAlaw(audio);
      else this.enqueueSentence(text, gen); // fallback (e.g. Sarvam not configured)
    } catch (err) {
      this.log.error({ err }, "greeting audio failed; falling back to live TTS");
      this.enqueueSentence(text, gen);
    } finally {
      this.responseComplete = true;
    }
  }

  private async respond(): Promise<void> {
    this.beginResponse();
    const gen = this.speechGen;
    let buffer = "";
    let full = "";
    let firstChunkSent = false;

    const runLlm = () =>
      streamChat(this.messages, {
        model: config.sarvam.chatModel,
        temperature: this.agent.temperature,
        // Reasoning models need headroom for "thinking" before the answer;
        // never send less than the configured budget.
        maxTokens: Math.max(this.agent.maxTokens, config.sarvam.chatMaxTokens),
        signal: this.abortController!.signal,
        onDelta: (d) => {
          if (gen !== this.speechGen) return;
          if (this.marks && this.marks.llmFirstMs === undefined) {
            this.marks.llmFirstMs = Date.now() - this.marks.t0;
          }
          buffer += d;
          if (buffer.includes(TRANSFER_TOKEN)) {
            this.pendingTransfer = true;
            buffer = buffer.split(TRANSFER_TOKEN).join(" ");
          }
          const { sentences, rest } = splitSentences(buffer);
          for (const s of sentences) this.enqueueSentence(s, gen);
          if (sentences.length) firstChunkSent = true;
          buffer = rest;
          // First audible chunk: don't wait for a full sentence — flush the
          // first clause so TTS starts while the model is still writing.
          if (!firstChunkSent) {
            const cut = firstClauseCut(buffer);
            if (cut > 0) {
              this.enqueueSentence(buffer.slice(0, cut), gen);
              buffer = buffer.slice(cut);
              firstChunkSent = true;
            }
          }
          // Flush an over-long tail without a terminator to keep latency low.
          if (buffer.length > 240) {
            this.enqueueSentence(buffer, gen);
            buffer = "";
          }
        },
      });

    try {
      full = await runLlm();
      // A reasoning model that exhausts max_tokens while "thinking" returns
      // empty content. Silence is worse than waiting — retry once.
      if (!full && gen === this.speechGen && !this.closed) {
        this.log.warn({ callId: this.callId }, "LLM returned empty reply — retrying once");
        full = await runLlm();
      }
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
    this.clearFiller(); // real speech is on the way
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
          if (this.marks && this.marks.ttsFirstMs === undefined) {
            this.marks.ttsFirstMs = Date.now() - this.marks.t0;
          }
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

  // ---- Filler (masks response latency) ----

  private armFiller(gen: number, delayMs = config.filler.delayMs): void {
    if (!config.filler.enabled || !config.sarvam.configured) return;
    this.clearFiller();
    this.fillerTimer = setTimeout(() => {
      this.fillerTimer = null;
      void this.playFiller(gen);
    }, delayMs);
  }

  /** True while this turn is still waiting for the real reply's audio. */
  private fillerStillUseful(gen: number): boolean {
    return (
      gen === this.speechGen &&
      !this.closed &&
      this.marks?.firstAudioMs === undefined && // no real audio yet this turn
      !this.ttsWorking &&
      this.ttsQueue.length === 0 &&
      this.frameQueue.length === 0
    );
  }

  private async playFiller(gen: number): Promise<void> {
    if (!this.fillerStillUseful(gen)) return;
    try {
      const audio = await getFillerAudio(this.agent, this.fillerIdx++, this.ttsLang());
      // Re-check: the real reply may have started while we synthesized.
      if (!this.fillerStillUseful(gen)) return;
      if (audio.length) {
        this.enqueueAlaw(audio, true);
        this.fillersThisTurn++;
        if (this.fillersThisTurn < MAX_FILLERS_PER_TURN) this.armFiller(gen, FILLER_REARM_MS);
      }
    } catch (err) {
      this.log.debug({ err }, "filler audio failed");
    }
  }

  private clearFiller(): void {
    if (this.fillerTimer) {
      clearTimeout(this.fillerTimer);
      this.fillerTimer = null;
    }
  }

  private ttsLang(): string {
    if (this.agent.language && this.agent.language !== "auto") return this.agent.language;
    return this.detectedLang || config.ttsFallbackLanguage;
  }

  // ---- Outbound audio playback ----

  private enqueueAlaw(alaw: Buffer, isFiller = false): void {
    if (!isFiller && this.marks && this.marks.firstAudioMs === undefined) {
      const m = this.marks;
      m.firstAudioMs = Date.now() - m.t0;
      this.log.info(
        {
          callId: this.callId,
          sttMs: m.sttMs,
          llmFirstMs: m.llmFirstMs,
          ttsFirstMs: m.ttsFirstMs,
          firstAudioMs: m.firstAudioMs,
        },
        "turn latency (ms since caller stopped talking)",
      );
    }
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
    let sent = 0;
    // Wall-clock paced sender: emit audio at real time (20 ms/frame) while
    // keeping a small lead buffer. Robust to event-loop jitter — no bursts or
    // gaps, which otherwise sound like static/choppiness on the caller's end.
    const FRAME_MS = 20;
    const LEAD_MS = 200;
    const startWall = Date.now();
    try {
      while (!this.closed) {
        if (gen !== this.speechGen) break;
        const target = Math.floor((Date.now() - startWall + LEAD_MS) / FRAME_MS);
        while (sent < target && this.frameQueue.length && gen === this.speechGen && !this.closed) {
          const frame = this.frameQueue.shift()!;
          this.send({
            event: "media",
            stream_sid: this.streamSid,
            media: { payload: frame.toString("base64") },
          });
          sent++;
        }
        if (this.frameQueue.length === 0) {
          // Nothing queued: done if the response is complete, else wait for more.
          if (this.responseComplete && !this.ttsWorking && this.ttsQueue.length === 0) break;
        }
        await sleep(FRAME_MS);
      }
    } finally {
      this.draining = false;
    }

    if (gen === this.speechGen && !this.closed) {
      this.botSpeaking = false;
      this.log.info({ callId: this.callId, frames: sent }, "response audio sent");
      this.send({ event: "mark", stream_sid: this.streamSid, mark: { name: "response_done" } });
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
