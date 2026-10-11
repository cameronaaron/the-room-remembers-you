/**
 * Why the room is not seeing anybody.
 *
 * Sensing runs through six stages, and every one of them can fail silently:
 *
 *   camera → frames → changed pixels → cells → blobs → tracks → the wall
 *
 * When it breaks, the installation does not report an error. It renders a
 * beautiful empty field, exactly as it would in an empty gallery, and the
 * operator is left guessing. This module walks the stages in order and names
 * the first one that is actually broken, because that is the only one worth
 * fixing — everything downstream of a stall is starved by definition.
 *
 * Pure and testable on purpose: the failure modes worth catching are the ones
 * that only appear in front of a real camera, so the logic that recognises them
 * must be checkable without one.
 */

export type SensingStage =
  | 'camera'
  | 'frames'
  | 'pixels'
  | 'cells'
  | 'blobs'
  | 'tracks'
  | 'output';

export type SensingSnapshot = {
  cameraState: 'idle' | 'starting' | 'ready' | 'failed';
  videoWidth: number;
  videoHeight: number;
  /** HTMLMediaElement.readyState; 2 or more means frames are decodable. */
  videoReadyState: number;
  /** Measured rate of the sensing loop. */
  analysisHz: number;
  warmingUp: boolean;
  /** The background model has warmed up but is still adapting. */
  settling: boolean;
  changedPercent: number;
  /** Share of the motion grid lit this frame. This is what the guard tests. */
  coveragePercent: number;
  sceneChangeLimitPercent: number;
  rejectedFraction: number;
  candidateCells: number;
  activeCells: number;
  blobCount: number;
  visibleTracks: number;
  occludedTracks: number;
  sensitivity: number;
  demoMode: boolean;
  simulationRate: number;
};

export type Finding = {
  stage: SensingStage;
  severity: 'ok' | 'warn' | 'blocked';
  headline: string;
  /** What to actually do about it. */
  fix: string;
};

/** Pixels must change by at least this share for the frame to be worth anything. */
const DEAD_FRAME_PERCENT = 0.15;

/** A cell needs this many changed pixels out of its 16 to become a candidate. */
export const CELL_CANDIDATE_PIXELS = 5;

const SEVERITY_ORDER = { blocked: 0, warn: 1, ok: 2 } as const;

/**
 * Most severe first, so `findings[0]` is always the thing worth reading. The
 * walk below still stops at the first stalled stage; this only ensures an
 * advisory noted along the way — a slow sensing loop, say — cannot outrank an
 * actual blockage in the headline.
 */
function bySeverity(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function diagnoseSensing(snapshot: SensingSnapshot): Finding[] {
  const findings: Finding[] = [];
  const synthetic = snapshot.demoMode || snapshot.simulationRate > 0;

  // 1. Is there a camera at all?
  if (snapshot.cameraState !== 'ready') {
    findings.push({
      stage: 'camera',
      severity: synthetic ? 'warn' : 'blocked',
      headline: `Camera is ${snapshot.cameraState}`,
      fix: snapshot.cameraState === 'failed'
        ? 'Grant camera access, or pick a different device in the browser. Chrome remembers the choice per origin.'
        : 'Waiting for the camera to start. If it stays here, the browser is holding the permission prompt.',
    });
    if (!synthetic) return bySeverity(findings);
  }

  // 2. Is it delivering pictures?
  if (snapshot.cameraState === 'ready' && (!snapshot.videoWidth || !snapshot.videoHeight)) {
    findings.push({
      stage: 'frames',
      severity: 'blocked',
      headline: 'Camera is open but reports no picture',
      fix: 'The stream has no dimensions yet. Another application may hold the device, or the tab lost it on resume.',
    });
    return bySeverity(findings);
  }
  if (snapshot.cameraState === 'ready' && snapshot.videoReadyState < 2) {
    findings.push({
      stage: 'frames',
      severity: 'blocked',
      headline: 'Camera has not decoded a frame yet',
      fix: 'The video element is not playing. This usually means autoplay was blocked before the room was entered.',
    });
    return bySeverity(findings);
  }

  // 3. Is the sensing loop running at all?
  if (snapshot.analysisHz < 1) {
    findings.push({
      stage: 'frames',
      severity: 'blocked',
      headline: 'The sensing loop is not running',
      fix: 'No analysis passes are completing. The room was probably never entered, or the tab is throttled in the background.',
    });
    return bySeverity(findings);
  }

  // A slow sensing loop makes the two-frame persistence rule expensive: at 9 Hz
  // a movement has to last 215 ms to be accepted at all.
  if (snapshot.analysisHz < 12) {
    findings.push({
      stage: 'frames',
      severity: 'warn',
      headline: `Sensing is only running at ${snapshot.analysisHz.toFixed(1)} Hz`,
      fix: 'Motion must persist across two analysis frames to be accepted, which at this rate means holding still for over 200 ms. Move to the STANDARD or FULL hardware profile if the machine can carry it.',
    });
  }

  if (snapshot.settling) {
    findings.push({
      stage: 'pixels',
      severity: 'warn',
      headline: 'Settling: the background is still being learned',
      fix: 'Anything already in the room when sensing started is being learned in, so the changed area is larger than it will be. Tracking works; the room will not say anything about what it sees until this passes.',
    });
  }

  if (snapshot.warmingUp) {
    findings.push({
      stage: 'pixels',
      severity: 'warn',
      headline: 'Learning what the empty room looks like',
      fix: 'Stay out of frame for about a second. Nothing is tracked until the background model settles.',
    });
    return bySeverity(findings);
  }

  // 4. Are pixels changing, and is the guard eating them?
  if (snapshot.rejectedFraction > 0.3) {
    findings.push({
      stage: 'pixels',
      severity: 'blocked',
      headline: `${Math.round(snapshot.rejectedFraction * 100)}% of frames rejected as a scene change`,
      fix: `${snapshot.coveragePercent.toFixed(0)}% of the motion grid is lit against a ${snapshot.sceneChangeLimitPercent.toFixed(0)}% limit, so the room is being read as a lighting change rather than as movement. Raise the scene-change limit, or find what is changing across the whole frame — an auto-exposing camera or a light in shot.`,
    });
    return bySeverity(findings);
  }
  if (snapshot.changedPercent < DEAD_FRAME_PERCENT) {
    findings.push({
      stage: 'pixels',
      severity: 'blocked',
      headline: 'Almost no pixels are changing',
      fix: `Movement sensitivity is ${snapshot.sensitivity}; every pixel has to shift by more than that to count. Lower it, add light, or check that the lens is not covered.`,
    });
    return bySeverity(findings);
  }

  // 5. Does the change gather into cells?
  if (snapshot.candidateCells === 0) {
    findings.push({
      stage: 'cells',
      severity: 'blocked',
      headline: 'Pixels are changing but no cell reaches the threshold',
      fix: `Change is too scattered: a cell needs ${CELL_CANDIDATE_PIXELS} of its 16 pixels to shift together. This is usually sensor noise in a dim room rather than a person.`,
    });
    return bySeverity(findings);
  }
  if (snapshot.activeCells === 0) {
    findings.push({
      stage: 'cells',
      severity: 'blocked',
      headline: 'Motion is not lasting two frames',
      fix: 'Cells light up and vanish before they can be accepted. Either the movement is very fast, or the frame rate is too low for the two-frame rule to catch it.',
    });
    return bySeverity(findings);
  }

  // 6. Do cells become bodies, and bodies become tracks?
  if (snapshot.blobCount === 0) {
    findings.push({
      stage: 'blobs',
      severity: 'blocked',
      headline: 'Accepted cells are not forming a body',
      fix: 'The moving region is too small or too broken up to become a connected blob. Try larger, slower movement.',
    });
    return bySeverity(findings);
  }
  if (snapshot.visibleTracks === 0) {
    findings.push({
      stage: 'tracks',
      severity: snapshot.occludedTracks > 0 ? 'warn' : 'blocked',
      headline: snapshot.occludedTracks > 0
        ? `${snapshot.occludedTracks} track(s) held as occluded, none visible`
        : 'Bodies are detected but no track is being held',
      fix: snapshot.occludedTracks > 0
        ? 'The tracker is predicting through a gap. Occluded tracks deliberately do not reach the artwork; if this persists, detection is flickering.'
        : 'Blobs are appearing but not associating into a track. They are probably jumping too far between frames.',
    });
    return bySeverity(findings);
  }

  findings.push({
    stage: 'output',
    severity: 'ok',
    headline: `Tracking ${snapshot.visibleTracks} ${snapshot.visibleTracks === 1 ? 'person' : 'people'}`,
    fix: 'Sensing is reaching the artwork. If nothing is visible on the wall, the problem is calibration or the renderer, not the camera.',
  });
  return bySeverity(findings);
}

/** The single stage that is holding everything up, for a headline readout. */
export function blockingStage(findings: Finding[]): Finding | null {
  return findings.find((finding) => finding.severity === 'blocked') ?? null;
}
