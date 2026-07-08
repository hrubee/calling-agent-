/**
 * WAV (RIFF/PCM) helpers. Sarvam STT accepts a mono 16-bit PCM WAV.
 */

/** Wrap PCM16 mono samples into a WAV file buffer. */
export function pcm16ToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bytesPerSample = 2;
  const dataSize = pcm.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < pcm.length; i++) {
    buffer.writeInt16LE(pcm[i], 44 + i * 2);
  }
  return buffer;
}

/**
 * If a buffer starts with a RIFF/WAVE header, return just the PCM/audio data
 * payload; otherwise return the buffer unchanged. Used to defensively strip a
 * container in case Sarvam returns WAV-wrapped audio when we asked for raw.
 */
export function stripWavHeader(buf: Buffer): Buffer {
  if (buf.length >= 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    // Find the "data" sub-chunk.
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === "data") {
        return buf.subarray(offset + 8, Math.min(offset + 8 + size, buf.length));
      }
      offset += 8 + size;
    }
  }
  return buf;
}
