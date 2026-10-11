import type { HardwareProfile, MotionBlob } from './room-types';

export const HARDWARE_PROFILES: Record<HardwareProfile, {
  analysisIntervalMs: number;
  maxBodies: number;
  cameraLimit: number;
  audioChannels: number;
  fieldScale: number;
}> = {
  CHEAP: { analysisIntervalMs: 100, maxBodies: 4, cameraLimit: 1, audioChannels: 1, fieldScale: 1 },
  STANDARD: { analysisIntervalMs: 67, maxBodies: 8, cameraLimit: 2, audioChannels: 2, fieldScale: 1.35 },
  FULL: { analysisIntervalMs: 42, maxBodies: 12, cameraLimit: 4, audioChannels: 4, fieldScale: 1.7 },
};

export class GallerySimulation {
  private startedAt = 0;
  private seed: number;

  constructor(seed = 0x51f15e) {
    this.seed = seed >>> 0;
  }

  reset(realNow: number) {
    this.startedAt = realNow;
  }

  sample(realNow: number, rate: 0 | 60 | 720, profile: HardwareProfile): MotionBlob[] {
    if (!rate) return [];
    if (!this.startedAt) this.startedAt = realNow;
    const seconds = ((realNow - this.startedAt) / 1000) * rate;
    const capacity = HARDWARE_PROFILES[profile].maxBodies;
    const wave = Math.sin(seconds / 780) * 0.5 + 0.5;
    const count = Math.max(1, Math.min(capacity, Math.round(1 + wave * (capacity - 1))));
    const blobs: MotionBlob[] = [];
    for (let index = 0; index < count; index += 1) {
      const local = seconds + index * 37 + this.noise(index) * 19;
      const cycle = local % 150;
      const still = cycle > 102 && cycle < 124;
      const progress = still ? 0.68 : (cycle % 102) / 102;
      const lane = (index + 1) / (count + 1);
      const pathKind = index % 4;
      let x = progress;
      let y = lane;
      if (pathKind === 1) {
        x = 1 - progress;
        y = 0.2 + 0.62 * Math.sin(progress * Math.PI);
      } else if (pathKind === 2) {
        x = 0.5 + Math.cos(progress * Math.PI * 2) * 0.28;
        y = 0.5 + Math.sin(progress * Math.PI * 2) * 0.28;
      } else if (pathKind === 3) {
        x = progress < 0.5 ? progress * 1.4 : 1.4 - progress * 0.8;
        y = 0.18 + progress * 0.68;
      }
      const cluster = cycle > 45 && cycle < 64;
      if (cluster) {
        x = x * 0.2 + 0.44;
        y = y * 0.2 + 0.42;
      }
      blobs.push({
        x: clamp(x, 0.03, 0.97),
        y: clamp(y, 0.05, 0.95),
        width: cluster ? 0.16 : 0.07,
        height: 0.18,
        energy: 0.55 + this.noise(Math.floor(local / 10) + index) * 0.35,
      });
    }
    return blobs;
  }

  private noise(value: number) {
    let state = (this.seed ^ Math.imul(value + 1, 0x9e3779b1)) >>> 0;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

