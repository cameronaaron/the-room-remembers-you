import type { RuntimeStatus } from '../room-types.ts';
/** Entirely synthetic aggregates, independent of any local devices or visitors. */
export function healthyStatus(): RuntimeStatus {
  return {
    camera: 'ready', microphone: 'ready', projector: 'ready', people: 1, density: 0.2,
    fps: 60, renderLoad: 20, renderer: 'synthetic', analysisHz: 24, cameraResolution: '640×360',
    sensingSamples: 10, storageBytes: 512, personality: 'curious', emptySeconds: 0,
    installationAge: 100, lastEvent: 'synthetic', lifecycle: 'active', debugEvents: 0,
    currentDay: 1, ghostCount: 0, whisperCount: 0,
    motion: { width: 3, height: 1, mask: [0,1,2], changedPercent: 5, candidateCells: 2,
      activeCells: 1, sceneChangeLimitPercent: 85, coveragePercent: 20, rejectedFraction: 0,
      blobCount: 1, meanLightShift: 0, cellsPerBody: 7, state: 'tracking', source: 'synthetic',
      visibleTracks: 1, occludedTracks: 0 },
    audio: { running: true, level: 0.01, threshold: 0.02, noiseFloor: 0.001, suppressed: false,
      contextState: 'running', capturing: false, tooLoud: false, captured: 1, replayed: 0, held: 1,
      recall: null },
  };
}
