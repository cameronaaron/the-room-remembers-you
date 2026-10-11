import {
  selectObservedTracks,
  TRACK_CONFIRM_SIGHTINGS,
  type MotionTracker,
} from './motion-tracker.ts';
import type {
  RuntimeStatus,
  SensingSample,
  VisitorTrack,
} from './room-types.ts';

/** An explicit allowlist: telemetry contains aggregate counts, never positions or masks. */
export function sensingSample(
  elapsed: number,
  analysisHz: number,
  diagnostics: ReturnType<MotionTracker['getDiagnostics']>,
  audio: RuntimeStatus['audio'],
  active: readonly VisitorTrack[],
  fragmentRecoveries: number,
  whispersHeld: number,
  source: string,
): SensingSample {
  return {
    t: Math.round(elapsed),
    hz: Math.round(analysisHz * 10) / 10,
    changedPercent: Math.round(diagnostics.changedPercent * 100) / 100,
    coveragePercent: Math.round(diagnostics.coveragePercent * 10) / 10,
    rejectedFraction: Math.round(diagnostics.rejectedFraction * 100) / 100,
    candidateCells: diagnostics.candidateCells,
    activeCells: diagnostics.activeCells,
    blobs: diagnostics.blobCount,
    live: selectObservedTracks(active).length,
    hidden: active.filter((track) => track.occluded).length,
    fragmentRecoveries: fragmentRecoveries,
    cellsPerBody: diagnostics.cellsPerBody,
    candidates: active.filter(
      (track) => !track.occluded && track.sightings < TRACK_CONFIRM_SIGHTINGS,
    ).length,
    micLevel: audio.level,
    micThreshold: audio.threshold,
    whispersHeld: whispersHeld,
    whispersCaptured: audio.captured,
    whispersReplayed: audio.replayed,
    audioContext: audio.contextState,
    state: diagnostics.state,
    source: source,
  };
}

/** Half a second: enough to spot churn and rejection, cheap enough to run always. */
export const SENSING_SAMPLE_INTERVAL_MS = 500;

/** Roughly half an hour at two samples a second. */
export const SENSING_LOG_LIMIT = 3_600;

/**
 * The rolling sensing log.
 *
 * Aggregate counts only, which is what makes it safe to record continuously
 * rather than behind the opt-in the anonymous event recorder needs. The cadence
 * and the bound are here rather than in the loop because "how much of a gallery
 * day does an exported log actually cover" is a question an operator asks and a
 * test can answer.
 */
export class SensingLog {
  private samples: SensingSample[] = [];
  private startedAt: number | null = null;
  private lastAt: number | null = null;

  get all(): readonly SensingSample[] {
    return this.samples;
  }

  get size(): number {
    return this.samples.length;
  }

  /** Whether a sample is due, given a monotonic clock. */
  due(now: number): boolean {
    return this.lastAt === null || now - this.lastAt >= SENSING_SAMPLE_INTERVAL_MS;
  }

  /** Elapsed time this sample should be stamped with, advancing the cadence. */
  mark(now: number): number {
    if (this.startedAt === null) this.startedAt = now;
    this.lastAt = now;
    return now - this.startedAt;
  }

  push(sample: SensingSample) {
    this.samples.push(sample);
    while (this.samples.length > SENSING_LOG_LIMIT) this.samples.shift();
  }
}
