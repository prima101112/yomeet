// Energy-based voice activity detection that cuts 16 kHz PCM16 audio into utterances.
export const SAMPLE_RATE = 16000;
const FRAME = 320; // 20 ms

export interface Utterance {
  pcm: Int16Array;
  startedAt: Date;
}

export class Segmenter {
  private pending = new Int16Array(0);
  private preroll: Int16Array[] = [];
  private current: Int16Array[] = [];
  private voicedRun = 0;
  private silentRun = 0;
  private voicedTotal = 0;
  private inSpeech = false;
  private startedAt = new Date();

  constructor(
    private threshold: number,
    private silenceMs: number,
    private onUtterance: (u: Utterance) => void,
    private maxMs = 25000,
  ) {}

  push(chunk: Int16Array) {
    const merged = new Int16Array(this.pending.length + chunk.length);
    merged.set(this.pending);
    merged.set(chunk, this.pending.length);
    let off = 0;
    for (; off + FRAME <= merged.length; off += FRAME) this.frame(merged.slice(off, off + FRAME));
    this.pending = merged.slice(off);
  }

  private frame(f: Int16Array) {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const voiced = Math.sqrt(sum / f.length) > this.threshold;

    if (!this.inSpeech) {
      this.preroll.push(f);
      if (this.preroll.length > 15) this.preroll.shift(); // 300 ms pre-roll
      this.voicedRun = voiced ? this.voicedRun + 1 : 0;
      if (this.voicedRun >= 3) {
        this.inSpeech = true;
        this.startedAt = new Date(Date.now() - this.preroll.length * 20);
        this.current = [...this.preroll];
        this.preroll = [];
        this.voicedTotal = this.voicedRun;
        this.silentRun = 0;
      }
      return;
    }

    this.current.push(f);
    if (voiced) {
      this.voicedTotal++;
      this.silentRun = 0;
    } else {
      this.silentRun++;
    }
    const durMs = this.current.length * 20;
    if (this.silentRun * 20 >= this.silenceMs || durMs >= this.maxMs) this.flush();
  }

  flush() {
    if (!this.inSpeech) return;
    const frames = this.current;
    const voicedMs = this.voicedTotal * 20;
    this.inSpeech = false;
    this.current = [];
    this.voicedRun = 0;
    this.silentRun = 0;
    if (voicedMs < 300) return; // clicks / coughs
    const pcm = new Int16Array(frames.length * FRAME);
    frames.forEach((fr, i) => pcm.set(fr, i * FRAME));
    this.onUtterance({ pcm, startedAt: this.startedAt });
  }
}

export function toWav(pcm: Int16Array, rate = SAMPLE_RATE): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
