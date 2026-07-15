import { config } from "../config";
import { decodeAlaw } from "../audio/g711";
import { concatInt16 } from "../audio/resample";
import { Vad } from "../audio/vad";
import { bus } from "../events";
import { logger } from "../logger";
import { streamReply } from "../llm/chat";
import { type ChatMessage } from "../sarvam/chat";
import { warmSarvam } from "../sarvam/client";
import { transcribePcm8k, type SttResult } from "../sarvam/stt";
import { synthesizeAlaw8k } from "../sarvam/tts";
import { TtsStreamSession } from "../sarvam/ttsStream";
import { db } from "../store/db";
import type { Agent, TranscriptTurn } from "../store/types";
import { buildSystemPrompt, TRANSFER_TOKEN } from "./prompt";
import { getFillerAudio, getGreetingAudio } from "./greeting";

const FRAME_SAMPLES = 160; // 20 ms @ 8 kHz
const FRAME_BYTES = 160; // A-law: 1 byte/sample
const ALAW_SILENCE = 0xd5;

// The LLM can "think" for 5s+; chain up to this many fillers while waiting.
const MAX_FILLERS_PER_TURN = 2;
const FILLER_REARM_MS = 2500;

type Send = (obj: unknown) => void;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TERMINATORS = ".!?।";

/**
 * Split completed sentences off the front of a streaming buffer. A terminator
 * only ends a sentence when followed by whitespace, so decimals ("Rs 1.5")
 * stay glued together, and a terminator at the buffer edge — where the next
 * delta may continue the number — keeps accumulating until more text arrives
 * (the end-of-stream tail flush picks it up).
 */
export function splitSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      const s = text.slice(last, i).trim();
      if (s) sentences.push(s);
      last = i + 1;
    } else if (TERMINATORS.includes(ch)) {
      let j = i;
      while (j + 1 < text.length && TERMINATORS.includes(text[j + 1])) j++;
      if (j + 1 < text.length && /\s/.test(text[j + 1])) {
        const s = text.slice(last, j + 1).trim();
        if (s) sentences.push(s);
        last = j + 1;
      }
      i = j;
    }
  }
  return { sentences, rest: text.slice(last).trimStart() };
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

  // Serial TTS worker (REST path: greeting fallback + streaming-failure fallback)
  private ttsQueue: { text: string; gen: number }[] = [];
  private ttsWorking = false;

  // Streaming TTS session (one per response; ~0.5s to first audio vs ~1.6s REST)
  private ttsSession: TtsStreamSession | null = null;
  private ttsStreamBroken = false; // set on stream failure -> REST for rest of call

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
      // Serialize with caller turns: if the caller speaks while greeting audio
      // is still being synthesized (cache miss ~1.5s), their turn queues
      // behind greet() instead of racing it — a concurrent respond() shares
      // responseComplete and the TTS session, so the race could end drain()
      // mid-reply and fire a pending transfer early.
      this.turnChain = this.turnChain.then(() =>
        this.greet().catch((err) => this.log.error({ err }, "greeting failed")),
      );
      await this.turnChain;
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
    this.ttsSession?.close();
    this.ttsSession = null;
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
        // A reply is "in flight" from the moment respond() starts until its
        // last frame is sent: cover the LLM think window (!responseComplete)
        // and the streaming-TTS ramp (ttsStreamPending), not just audible
        // frames — otherwise a stale reply starts playing over the caller's
        // follow-up ("Hello? Are you there?") and both get answered.
        if (
          this.botSpeaking ||
          this.ttsWorking ||
          this.frameQueue.length > 0 ||
          this.ttsStreamPending() > 0 ||
          !this.responseComplete
        ) {
          this.bargeIn();
        }
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
    this.ttsSession?.close();
    this.ttsSession = null;
    this.clearFiller();
    this.abortController?.abort();
    this.botSpeaking = false;
    this.pendingTransfer = false;
    // The aborted respond() unwinds without touching state for a superseded
    // gen, so restore the resting value here — a lingering `false` would make
    // every later speech-start a spurious barge-in.
    this.responseComplete = true;
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
    this.openTtsSession(gen); // connect while the LLM is thinking
    let buffer = "";
    let full = "";
    let streamed = ""; // deltas accepted this generation — history source on timeout
    let firstChunkSent = false;

    const runLlm = () => {
      streamed = "";
      return streamReply(this.messages, {
        model: config.sarvam.chatModel,
        temperature: this.agent.temperature,
        // Sarvam reasoning models need headroom for "thinking" before the
        // answer; fast external models use their own (small) budget.
        maxTokens: config.chatLlm.configured
          ? config.chatLlm.maxTokens
          : Math.max(this.agent.maxTokens, config.sarvam.chatMaxTokens),
        signal: this.abortController!.signal,
        onDelta: (d) => {
          if (gen !== this.speechGen) return;
          if (this.marks && this.marks.llmFirstMs === undefined) {
            this.marks.llmFirstMs = Date.now() - this.marks.t0;
          }
          streamed += d;
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
          // Cut at a word boundary (never mid-word), which also keeps a
          // partial [[TRANSFER]] split across deltas out of the spoken text;
          // with no usable space, hold back just the partial token prefix.
          if (buffer.length > 240) {
            let cut = buffer.lastIndexOf(" ");
            if (cut < 160) {
              cut = buffer.length;
              for (let k = TRANSFER_TOKEN.length - 1; k > 0; k--) {
                if (buffer.endsWith(TRANSFER_TOKEN.slice(0, k))) {
                  cut = buffer.length - k;
                  break;
                }
              }
            }
            this.enqueueSentence(buffer.slice(0, cut), gen);
            buffer = buffer.slice(cut);
          }
        },
      });
    };

    try {
      full = await runLlm();
      // A reasoning model that exhausts max_tokens while "thinking" returns
      // empty content. Silence is worse than waiting — retry once.
      if (!full && gen === this.speechGen && !this.closed) {
        this.log.warn({ callId: this.callId }, "LLM returned empty reply — retrying once");
        full = await runLlm();
      }
    } catch (err: any) {
      // Only a barge-in / call end (which bump speechGen or set closed BEFORE
      // aborting) may skip the bookkeeping below. A stream timeout surfaces
      // here as TimeoutError: fall through so the turn closes cleanly —
      // responseComplete flips, drain() can emit response_done — and history
      // keeps what the caller actually heard.
      if (err?.name === "AbortError" && (gen !== this.speechGen || this.closed)) return;
      this.log.error({ err }, "chat failed");
      full = streamed;
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

  // ---- Streaming TTS session (per response) ----

  private openTtsSession(gen: number): void {
    this.ttsSession?.close();
    this.ttsSession = null;
    if (!config.ttsStreaming || !config.sarvam.configured || this.ttsStreamBroken) return;

    const session = new TtsStreamSession({
      model: this.agent.ttsModel,
      speaker: this.agent.ttsSpeaker,
      targetLanguage: this.ttsLang(),
      onAudio: (alaw) => {
        if (gen !== this.speechGen || this.closed) return;
        if (this.marks && this.marks.ttsFirstMs === undefined) {
          this.marks.ttsFirstMs = Date.now() - this.marks.t0;
        }
        this.enqueueAlaw(alaw);
      },
      onIdle: () => {
        // All submitted text synthesized; drop the socket once the reply is done.
        if (gen !== this.speechGen || this.responseComplete) {
          if (this.ttsSession === session) this.ttsSession = null;
          session.close();
        }
      },
      onError: (_err, lostTexts) => {
        this.ttsStreamBroken = true; // REST for the remainder of this call
        if (this.ttsSession === session) this.ttsSession = null;
        if (gen !== this.speechGen || this.closed) return;
        this.log.warn({ lost: lostTexts.length }, "TTS stream failed — falling back to REST");
        for (const text of lostTexts) {
          this.ttsQueue.push({ text, gen });
        }
        void this.runTtsWorker();
      },
    });
    this.ttsSession = session;
  }

  /** Sentences not yet fully synthesized on the streaming path. */
  private ttsStreamPending(): number {
    return this.ttsSession?.pending ?? 0;
  }

  private enqueueSentence(text: string, gen: number): void {
    const t = text.trim();
    if (!t) return;
    this.clearFiller(); // real speech is on the way
    if (this.ttsSession && gen === this.speechGen) {
      this.ttsSession.speak(t);
      return;
    }
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
          // Gen check BEFORE stamping marks: a pre-barge-in synthesis that
          // finishes late must not corrupt the next turn's latency numbers.
          if (item.gen !== this.speechGen || this.closed) continue;
          if (this.marks && this.marks.ttsFirstMs === undefined) {
            this.marks.ttsFirstMs = Date.now() - this.marks.t0;
          }
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
      this.ttsStreamPending() === 0 &&
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
        // Chain another filler only if a distinct phrase is configured —
        // repeating the same phrase (or padding with "one moment") irritates.
        const maxFillers = Math.min(MAX_FILLERS_PER_TURN, config.filler.texts.length);
        if (this.fillersThisTurn < maxFillers) this.armFiller(gen, FILLER_REARM_MS);
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
      const frame = alaw.subarray(i, Math.min(i + FRAME_BYTES, alaw.length));
      if (frame.length === FRAME_BYTES) {
        this.frameQueue.push(frame);
      } else {
        // REST/greeting audio isn't 160-byte aligned; pad the tail to a whole
        // 20 ms frame (the streaming path already does — flushRemainder).
        const padded = Buffer.alloc(FRAME_BYTES, ALAW_SILENCE);
        frame.copy(padded);
        this.frameQueue.push(padded);
      }
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
    let startWall = Date.now();
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
          if (
            this.responseComplete &&
            !this.ttsWorking &&
            this.ttsQueue.length === 0 &&
            this.ttsStreamPending() === 0
          )
            break;
          // Underrun (e.g. filler played, real reply still synthesizing):
          // re-anchor the pacing clock so the gap doesn't accumulate send
          // budget that would burst out in one iteration when audio arrives.
          startWall = Date.now() - sent * FRAME_MS;
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
