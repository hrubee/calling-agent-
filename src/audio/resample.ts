/**
 * Minimal linear resampling between 8 kHz (telephony) and 16 kHz (Sarvam STT).
 * Not audiophile-grade, but perfectly adequate for speech recognition.
 */

/** Upsample 8 kHz -> 16 kHz by linear interpolation (2x length). */
export function upsample8to16(pcm: Int16Array): Int16Array {
  const n = pcm.length;
  if (n === 0) return new Int16Array(0);
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const cur = pcm[i];
    const next = i + 1 < n ? pcm[i + 1] : cur;
    out[i * 2] = cur;
    out[i * 2 + 1] = (cur + next) >> 1;
  }
  return out;
}

/** Downsample 16 kHz -> 8 kHz by averaging sample pairs. */
export function downsample16to8(pcm: Int16Array): Int16Array {
  const outLen = Math.floor(pcm.length / 2);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = (pcm[i * 2] + pcm[i * 2 + 1]) >> 1;
  }
  return out;
}

/** Concatenate an array of Int16Array chunks into one. */
export function concatInt16(chunks: Int16Array[]): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
