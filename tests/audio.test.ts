import assert from "node:assert";
import test from "node:test";
import { decodeAlaw, encodeAlaw } from "../src/audio/g711";
import { concatInt16, downsample16to8, upsample8to16 } from "../src/audio/resample";
import { pcm16ToWav, stripWavHeader } from "../src/audio/wav";
import { Vad } from "../src/audio/vad";

test("g711 A-law round-trip stays close to the original", () => {
  const pcm = new Int16Array(512);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 8) * 10000);
  const alaw = encodeAlaw(pcm);
  assert.equal(alaw.length, pcm.length);
  const back = decodeAlaw(alaw);
  let err = 0;
  for (let i = 0; i < pcm.length; i++) err += Math.abs(back[i] - pcm[i]);
  const avg = err / pcm.length;
  assert.ok(avg < 400, `average error too high: ${avg}`);
});

test("A-law encodes silence deterministically", () => {
  const silence = new Int16Array(160); // all zeros
  const alaw = encodeAlaw(silence);
  assert.equal(alaw[0], 0xd5); // canonical A-law value for 0
});

test("upsample 8k->16k doubles length and keeps anchors", () => {
  const pcm = Int16Array.from([0, 100, 200, 300]);
  const up = upsample8to16(pcm);
  assert.equal(up.length, 8);
  assert.equal(up[0], 0);
  assert.equal(up[2], 100);
  const down = downsample16to8(up);
  assert.equal(down.length, 4);
});

test("concatInt16 joins chunks", () => {
  const out = concatInt16([Int16Array.from([1, 2]), Int16Array.from([3])]);
  assert.deepEqual(Array.from(out), [1, 2, 3]);
});

test("WAV header is well-formed and strippable", () => {
  const pcm = Int16Array.from([1, 2, 3, 4]);
  const wav = pcm16ToWav(pcm, 16000);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), 16000);
  const data = stripWavHeader(wav);
  assert.equal(data.length, 8); // 4 samples * 2 bytes
});

test("VAD endpoints an utterance after trailing silence", () => {
  const vad = new Vad({ sampleRate: 8000, threshold: 500, silenceMs: 200, minSpeechMs: 60, maxMs: 5000, preRollMs: 40 });
  const loud = new Int16Array(160).fill(8000);
  const quiet = new Int16Array(160);
  let utt: { pcm: Int16Array } | null = null;
  for (let i = 0; i < 20; i++) vad.push(loud);
  for (let i = 0; i < 20 && !utt; i++) {
    const r = vad.push(quiet);
    if (r.type === "utterance") utt = r;
  }
  assert.ok(utt, "expected an utterance to be emitted");
  assert.ok(utt!.pcm.length > 0);
});

test("VAD emits a speculative early endpoint before the final one", () => {
  const vad = new Vad({ sampleRate: 8000, threshold: 500, silenceMs: 200, minSpeechMs: 60, maxMs: 5000, preRollMs: 40, earlyMs: 80 });
  const loud = new Int16Array(160).fill(8000);
  const quiet = new Int16Array(160);
  for (let i = 0; i < 20; i++) vad.push(loud);
  const seen: string[] = [];
  let earlyLen = 0;
  for (let i = 0; i < 20; i++) {
    const r = vad.push(quiet);
    if (r.type === "speech-early") earlyLen = r.pcm.length;
    if (r.type === "speech-early" || r.type === "utterance") seen.push(r.type);
  }
  assert.deepEqual(seen, ["speech-early", "utterance"]);
  assert.ok(earlyLen > 0);
});

test("VAD re-arms the early endpoint when speech resumes", () => {
  const vad = new Vad({ sampleRate: 8000, threshold: 500, silenceMs: 200, minSpeechMs: 60, maxMs: 60000, preRollMs: 40, earlyMs: 80 });
  const loud = new Int16Array(160).fill(8000);
  const quiet = new Int16Array(160);
  const earlies: number[] = [];
  const feed = (frame: Int16Array, n: number) => {
    for (let i = 0; i < n; i++) if (vad.push(frame).type === "speech-early") earlies.push(i);
  };
  feed(loud, 20);
  feed(quiet, 6); // 120 ms silence: early fires, but no endpoint yet
  feed(loud, 10); // caller resumes
  feed(quiet, 6); // early fires again
  assert.equal(earlies.length, 2);
});

test("VAD ignores pure silence", () => {
  const vad = new Vad({ sampleRate: 8000, threshold: 500, silenceMs: 200, minSpeechMs: 60, maxMs: 5000 });
  let emitted = false;
  const quiet = new Int16Array(160);
  for (let i = 0; i < 100; i++) if (vad.push(quiet).type === "utterance") emitted = true;
  assert.equal(emitted, false);
});
