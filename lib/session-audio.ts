/** Private session PCM: deliberately separate from serializable WhisperMemory. */
export class SessionAudio {
  private ring: Float32Array;
  private cursor = 0;
  private filled = 0;
  private clips = new Map<string, Float32Array>();
  readonly sampleRate: number;
  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.ring = new Float32Array(Math.ceil(sampleRate * 7));
  }
  push(samples: Float32Array) {
    for (const sample of samples) {
      this.ring[this.cursor] = sample;
      this.cursor = (this.cursor + 1) % this.ring.length;
      this.filled = Math.min(this.ring.length, this.filled + 1);
    }
  }
  capture(id: string, seconds: number) {
    const length = Math.min(this.filled, Math.ceil(seconds * this.sampleRate));
    if (!length) return;
    const clip = new Float32Array(length);
    for (let i = 0; i < length; i++) clip[i] = this.ring[(this.cursor - length + i + this.ring.length) % this.ring.length];
    this.clips.set(id, clip);
    // Iterating the map itself is what makes the eviction loop terminate by
    // construction: a `while` over the size needed an is-it-empty guard that no
    // state the class can reach could ever satisfy, and so could never be tested.
    for (const [oldest, clip] of this.clips) {
      if (this.clips.size <= 80 && this.bytes <= 32 * 1024 * 1024) break;
      clip.fill(0);
      this.clips.delete(oldest);
    }
  }
  get bytes() { return [...this.clips.values()].reduce((sum, clip) => sum + clip.byteLength, 0); }
  get(id: string) { return this.clips.get(id); }
  clearRing() { this.ring.fill(0); this.cursor = 0; this.filled = 0; }
  clear() { this.clearRing(); for (const clip of this.clips.values()) clip.fill(0); this.clips.clear(); }
}
