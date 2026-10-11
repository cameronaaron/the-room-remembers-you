import assert from 'node:assert/strict';
import test from 'node:test';
import { blockingStage, diagnoseSensing, type SensingSnapshot } from './sensing-diagnosis.ts';

/** A room that is working: someone is being tracked. */
const healthy: SensingSnapshot = {
  cameraState: 'ready',
  videoWidth: 640,
  videoHeight: 360,
  videoReadyState: 4,
  analysisHz: 20,
  warmingUp: false,
  settling: false,
  changedPercent: 6,
  coveragePercent: 12,
  sceneChangeLimitPercent: 85,
  rejectedFraction: 0,
  candidateCells: 24,
  activeCells: 18,
  blobCount: 1,
  visibleTracks: 1,
  occludedTracks: 0,
  sensitivity: 24,
  demoMode: false,
  simulationRate: 0,
};

const snapshot = (patch: Partial<SensingSnapshot>): SensingSnapshot => ({ ...healthy, ...patch });

void test('a slow sensing loop is flagged without blocking', () => {
  // Straight from a real session: CHEAP profile delivered 9.3 Hz, which made
  // the two-frame persistence rule demand over 200 ms of held movement.
  const findings = diagnoseSensing(snapshot({ analysisHz: 9.3 }));
  assert.equal(blockingStage(findings), null, 'a slow loop still works');
  const slow = findings.find((finding) => /9.3 Hz/.test(finding.headline));
  assert.ok(slow, 'the low rate should be reported');
  assert.equal(slow.severity, 'warn');
  assert.match(slow.fix, /STANDARD|FULL/);
});

void test('a working room reports that it is working, and nothing is blocked', () => {
  const findings = diagnoseSensing(healthy);
  assert.equal(blockingStage(findings), null);
  assert.equal(findings[0].severity, 'ok');
  assert.equal(findings[0].stage, 'output');
  assert.match(findings[0].headline, /1 person/);
});

void test('a webcam at desk range is diagnosed as a scene-change rejection', () => {
  // The failure this whole module exists for. One person close to a laptop
  // camera fills the frame and trips a guard meant for a whole gallery; the
  // installation then looks identical to an empty room.
  const findings = diagnoseSensing(snapshot({
    changedPercent: 47,
    coveragePercent: 93,
    rejectedFraction: 0.9,
    activeCells: 0,
    candidateCells: 0,
    blobCount: 0,
    visibleTracks: 0,
  }));
  const blocked = blockingStage(findings);
  assert.ok(blocked);
  assert.equal(blocked.stage, 'pixels');
  assert.match(blocked.headline, /scene change/i);
  // It must say what to actually do, with both numbers in hand.
  assert.match(blocked.fix, /93%/);
  assert.match(blocked.fix, /85%/);
  assert.match(blocked.fix, /scene-change limit|auto-exposing/i);
});

void test('the first broken stage is the one reported, not the last', () => {
  // With no camera, everything downstream is starved. Reporting "no tracks"
  // would be true and useless.
  const findings = diagnoseSensing(snapshot({
    cameraState: 'failed',
    videoWidth: 0,
    videoHeight: 0,
    videoReadyState: 0,
    changedPercent: 0,
    candidateCells: 0,
    activeCells: 0,
    blobCount: 0,
    visibleTracks: 0,
  }));
  assert.equal(findings.length, 1, 'downstream noise should not be reported');
  assert.equal(findings[0].stage, 'camera');
});

void test('each stalled stage is named distinctly', () => {
  const cases: Array<[SensingSnapshot, string]> = [
    [snapshot({ cameraState: 'failed' }), 'camera'],
    [snapshot({ videoWidth: 0, videoHeight: 0 }), 'frames'],
    [snapshot({ videoReadyState: 0 }), 'frames'],
    [snapshot({ analysisHz: 0 }), 'frames'],
    [snapshot({ changedPercent: 0.01, candidateCells: 0, activeCells: 0, blobCount: 0, visibleTracks: 0 }), 'pixels'],
    [snapshot({ candidateCells: 0, activeCells: 0, blobCount: 0, visibleTracks: 0 }), 'cells'],
    [snapshot({ activeCells: 0, blobCount: 0, visibleTracks: 0 }), 'cells'],
    [snapshot({ blobCount: 0, visibleTracks: 0 }), 'blobs'],
    [snapshot({ visibleTracks: 0 }), 'tracks'],
  ];
  for (const [input, expected] of cases) {
    const blocked = blockingStage(diagnoseSensing(input));
    assert.ok(blocked, `expected a blockage for ${expected}`);
    assert.equal(blocked.stage, expected);
  }
});

void test('warming up is explained rather than reported as a fault', () => {
  const findings = diagnoseSensing(snapshot({ warmingUp: true, activeCells: 0, blobCount: 0, visibleTracks: 0 }));
  assert.equal(blockingStage(findings), null);
  assert.equal(findings[0].severity, 'warn');
  assert.match(findings[0].fix, /out of frame/i);
});

void test('occluded-only tracking is a warning, not a blockage', () => {
  const findings = diagnoseSensing(snapshot({ visibleTracks: 0, occludedTracks: 2 }));
  assert.equal(blockingStage(findings), null);
  assert.equal(findings[0].stage, 'tracks');
  assert.equal(findings[0].severity, 'warn');
});

void test('demo and simulation keep working when the camera does not', () => {
  // An operator running on demo motion should not be told the room is dead.
  for (const patch of [{ demoMode: true }, { simulationRate: 60 }]) {
    const findings = diagnoseSensing(snapshot({ cameraState: 'failed', ...patch }));
    assert.equal(findings[0].severity, 'warn', 'a synthetic source should downgrade the camera fault');
    assert.ok(findings.length > 1, 'diagnosis should continue past the camera');
  }
});

void test('every finding tells the operator what to do', () => {
  const inputs = [
    healthy,
    snapshot({ cameraState: 'failed' }),
    snapshot({ rejectedFraction: 0.9, changedPercent: 47 }),
    snapshot({ changedPercent: 0.01 }),
    snapshot({ candidateCells: 0, activeCells: 0, blobCount: 0, visibleTracks: 0 }),
    snapshot({ visibleTracks: 0 }),
  ];
  for (const input of inputs) {
    for (const finding of diagnoseSensing(input)) {
      assert.ok(finding.fix.length > 30, `"${finding.headline}" has no actionable fix`);
      assert.ok(finding.headline.length <= 70, `"${finding.headline}" is too long to scan`);
    }
  }
});

void test('an advisory never outranks an actual blockage', () => {
  // A slow loop is worth saying; it must not become the headline when the
  // camera is also failing to produce anything usable.
  const findings = diagnoseSensing(snapshot({
    analysisHz: 9.3,
    coveragePercent: 93,
    rejectedFraction: 0.9,
    activeCells: 0,
    blobCount: 0,
    visibleTracks: 0,
  }));
  assert.equal(findings[0].severity, 'blocked');
  assert.equal(findings[0].stage, 'pixels');
  assert.ok(findings.some((finding) => /9.3 Hz/.test(finding.headline)), 'the advisory should survive');
});

void test('a settling background is reported as settling, not as a fault', () => {
  // Anything already standing in the room when sensing starts is still being
  // learned in, so the changed area is larger than it will be. The room reacts
  // normally and stays silent; an operator seeing a warning here would start
  // adjusting a camera that is working.
  const findings = diagnoseSensing(snapshot({ settling: true }));
  const settling = findings.find((finding) => finding.headline.includes('Settling'));
  assert.ok(settling, 'settling must be reported at all');
  assert.equal(settling.severity, 'warn', 'a warning, never a blockage');
  assert.equal(settling.stage, 'pixels');
  assert.match(settling.fix, /will not say anything/);
});

void test('a camera that has not answered yet is told apart from one that refused', () => {
  // The two need different advice and the operator cannot tell them apart from
  // the wall: both render an empty gallery. "Grant camera access" is wrong and
  // wastes the visit when the browser is simply still holding the prompt.
  const refused = diagnoseSensing(snapshot({ cameraState: 'failed' }))[0];
  assert.match(refused.fix, /Grant camera access/);
  for (const state of ['idle', 'starting'] as const) {
    const waiting = diagnoseSensing(snapshot({ cameraState: state }))[0];
    assert.equal(waiting.stage, 'camera');
    assert.equal(waiting.severity, 'blocked');
    assert.match(waiting.headline, new RegExp(state));
    assert.doesNotMatch(waiting.fix, /Grant camera access/, 'nothing has been refused yet');
    assert.match(waiting.fix, /permission prompt/);
    assert.equal(blockingStage(diagnoseSensing(snapshot({ cameraState: state })))?.stage, 'camera');
  }
});
