/**
 * Which bodies the sensing loop is looking at this tick, and where they came
 * from.
 *
 * Four sources can produce a body — a camera, an operator's pointer, the
 * synthetic crowd, and a replayed recording — and the rules for combining them
 * are not obvious: a replay replaces everything rather than adding to it, and a
 * simulation contributes bodies whether or not anything else did. The label is
 * not decoration either; `source: none` on the instrument is how an operator
 * tells a room that sees nobody from a room that is not sensing at all.
 */
import type { MotionBlob } from './room-types.ts';

export type SensorInput = {
  /** Camera blobs, or null when the camera is not ready. */
  camera: MotionBlob[] | null;
  /** Whether demo mode is on, and the pointer body if one is currently alive. */
  demo: { on: boolean; pointer: MotionBlob | null };
  /** The synthetic crowd: its configured rate, and whatever it produced. */
  simulation: { rate: number; blobs: MotionBlob[] };
  /** Replayed bodies, when a recording is playing. */
  replay: MotionBlob[] | null;
  /** The hardware profile's ceiling on bodies considered in one tick. */
  maxBodies: number;
};

export type SensorReading = { blobs: MotionBlob[]; sources: string[] };

export function gatherBlobs(input: SensorInput): SensorReading {
  // A replay is an account of a room that has already happened. Mixing live
  // bodies into it would make the reproduction of a defect depend on whoever
  // walked past the machine while it was being reproduced.
  if (input.replay) {
    return { blobs: input.replay.slice(0, input.maxBodies), sources: ['replay'] };
  }
  const blobs: MotionBlob[] = [];
  const sources: string[] = [];
  if (input.camera) {
    blobs.push(...input.camera);
    sources.push('camera');
  }
  // Labelled from the setting, not from whether a body arrived: demo mode with
  // the pointer at rest is still the reason the room is watching a pointer.
  if (input.demo.on) {
    sources.push('demo');
    if (input.demo.pointer) blobs.push(input.demo.pointer);
  }
  if (input.simulation.rate) sources.push('simulation');
  blobs.push(...input.simulation.blobs);
  return { blobs: blobs.slice(0, input.maxBodies), sources };
}

/** How the instrument names the combination. Empty means nothing is sensing. */
export function describeSources(sources: readonly string[], separator = ' + '): string {
  return sources.join(separator) || 'none';
}
