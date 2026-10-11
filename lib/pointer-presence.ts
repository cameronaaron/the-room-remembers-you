import type { MotionBlob } from './room-types.ts';

/** Demo input shares the analysis clock; older events cannot clear newer motion. */
export class PointerPresence {
  private latest: { blob: MotionBlob; expiresAt: number } | null = null;

  move(blob: MotionBlob, now: number): void {
    this.latest = { blob: { ...blob }, expiresAt: now + 180 };
  }

  sample(now: number): MotionBlob | null {
    if (!this.latest) return null;
    if (now >= this.latest.expiresAt) {
      this.latest = null;
      return null;
    }
    return { ...this.latest.blob };
  }
}
