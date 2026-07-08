/**
 * G.711 A-law codec (ITU-T), pure JS with precomputed lookup tables.
 *
 * VoiceLink streams call audio as A-law, 8-bit, 8 kHz, mono, base64.
 * We decode inbound A-law -> PCM16 for STT, and (when needed) encode PCM16 -> A-law.
 * Sarvam TTS can emit A-law directly, so the encode path is mainly for tests/tools.
 *
 * Reference: Sun Microsystems g711.c (public domain).
 */

const SIGN_BIT = 0x80;
const QUANT_MASK = 0x0f;
const SEG_SHIFT = 4;
const SEG_MASK = 0x70;
const SEG_AEND = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

function alaw2linear(aval: number): number {
  aval ^= 0x55;
  let t = (aval & QUANT_MASK) << 4;
  const seg = (aval & SEG_MASK) >> SEG_SHIFT;
  switch (seg) {
    case 0:
      t += 8;
      break;
    case 1:
      t += 0x108;
      break;
    default:
      t += 0x108;
      t <<= seg - 1;
  }
  return aval & SIGN_BIT ? t : -t;
}

function search(val: number, table: number[]): number {
  for (let i = 0; i < table.length; i++) if (val <= table[i]) return i;
  return table.length;
}

function linear2alaw(pcm: number): number {
  // Clamp to signed 16-bit.
  if (pcm > 32767) pcm = 32767;
  else if (pcm < -32768) pcm = -32768;

  pcm = pcm >> 3;
  let mask: number;
  if (pcm >= 0) {
    mask = 0xd5;
  } else {
    mask = 0x55;
    pcm = -pcm - 1;
  }
  const seg = search(pcm, SEG_AEND);
  if (seg >= 8) return (0x7f ^ mask) & 0xff;
  let aval = seg << SEG_SHIFT;
  if (seg < 2) aval |= (pcm >> 1) & QUANT_MASK;
  else aval |= (pcm >> seg) & QUANT_MASK;
  return (aval ^ mask) & 0xff;
}

// Precompute decode table (256 entries) and encode table (65536 entries).
const DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) DECODE[i] = alaw2linear(i);

const ENCODE = new Uint8Array(65536);
for (let i = 0; i < 65536; i++) {
  const sample = i >= 32768 ? i - 65536 : i; // interpret as signed
  ENCODE[i] = linear2alaw(sample);
}

/** Decode A-law bytes to PCM16 samples. */
export function decodeAlaw(alaw: Uint8Array | Buffer): Int16Array {
  const out = new Int16Array(alaw.length);
  for (let i = 0; i < alaw.length; i++) out[i] = DECODE[alaw[i]];
  return out;
}

/** Encode PCM16 samples to A-law bytes. */
export function encodeAlaw(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = ENCODE[pcm[i] & 0xffff];
  return out;
}
