import type { ProjectionMode } from './palette';
import type { RecallKind } from './swarm';

export type Point = { x: number; y: number; t: number };

export type MotionBlob = {
  x: number;
  y: number;
  width: number;
  height: number;
  energy: number;
};

export type MotionDiagnostics = {
  width: number;
  height: number;
  // Ephemeral coarse motion cells: 0 quiet, 1 candidate, 2 accepted.
  mask: number[];
  changedPercent: number;
  /** Cells with enough changed pixels this frame, before the two-frame rule. */
  candidateCells: number;
  /** Cells that survived the two-frame rule and can form blobs. */
  activeCells: number;
  /** The coverage threshold in force, so diagnostics can explain a rejection. */
  sceneChangeLimitPercent: number;
  /** Share of the grid currently lit. This is what the guard actually tests. */
  coveragePercent: number;
  /** Share of recent frames thrown away as scene changes. */
  rejectedFraction: number;
  blobCount: number;
  meanLightShift: number;
  /**
   * Cells one body occupies in this camera's view, measured from the scene, or
   * null while there is not yet evidence for it.
   *
   * Visible because it decides how many people the room is willing to believe
   * in. It was a constant of 55, measured at desk range and wrong by a factor
   * of eight across a gallery, and nothing in the installation reported the
   * number it was dividing by.
   */
  cellsPerBody: number | null;
  /** `settling` means the background is still learning the room in: detections
   *  are good enough to react to, not solid enough to make claims about. */
  state: 'idle' | 'warming' | 'settling' | 'tracking' | 'scene-change';
  source: string;
  visibleTracks: number;
  occludedTracks: number;
};

export type VisitorTrack = {
  id: string;
  bornAt: number;
  lastSeen: number;
  position: Point;
  previous: Point;
  velocity: { x: number; y: number };
  speed: number;
  stillFor: number;
  dwellSeconds: number;
  path: Point[];
  active: boolean;
  occluded: boolean;
  confidence: number;
  /** Frames this track has actually been seen. Below the confirmation
   *  threshold it is a candidate, not a person, and never reaches the artwork. */
  sightings: number;
  /**
   * Size of the detected region, in room units. Carried because a stationary
   * body whose extent is changing is doing something with its arms, which the
   * centroid alone cannot show.
   */
  extent: { width: number; height: number };
};

export type Ghost = {
  id: string;
  createdAt: number;
  lastReplayedAt: number;
  path: Point[];
  dwellSeconds: number;
  intensity: number;
  strength: number;
  fidelity: number;
  recallCount: number;
  lineage: string[];
  falseMemory: boolean;
  day: number;
};

export type WhisperMemory = {
  id: string;
  createdAt: number;
  lastReplayedAt: number;
  duration: number;
  envelope: number[];
  brightness: number;
  position: { x: number; y: number };
  strength: number;
  fidelity: number;
  recallCount: number;
  lineage: string[];
  day: number;
};

export type SpatialCalibration = {
  source: Array<{ x: number; y: number }>;
  target: Array<{ x: number; y: number }>;
  calibratedAt: number;
};

export type HardwareProfile = 'CHEAP' | 'STANDARD' | 'FULL';

/**
 * `swarm` is the GPU particle field. `traces` is the original line renderer,
 * kept as the fallback for machines without WebGL2 float targets and as the
 * only engine that can drive the `paper` projection mode.
 */
export type VisualEngine = 'swarm' | 'traces';

/**
 * Which GPU API drives the particle field.
 *
 * A separate axis from `VisualEngine`, which chooses between the field and the
 * line renderer. `auto` is the shipped value and deliberately never selects
 * WebGPU: the two backends are at measured visual parity, and parity is one of
 * five gates. See `chooseRendererBackend` and `docs/ARCHITECTURE.md`.
 */
export type RendererPreference = 'auto' | 'webgpu' | 'webgl';
export type RoomLifecycle = 'opening' | 'active' | 'closing' | 'after-hours';

export type AnonymousSensorEvent = {
  t: number;
  // Compact, privacy-safe tuple: id, x, y, vx, vy, speed, occluded.
  people: Array<[string, number, number, number, number, number, 0 | 1]>;
};

/**
 * One sample of the sensing pipeline, for offline analysis.
 *
 * Aggregate counts only — no coordinates, no imagery, nothing that could
 * describe a particular person. That is what makes it safe to record
 * continuously rather than behind the opt-in used for anonymous event capture.
 */
export type SensingSample = {
  /** Milliseconds since recording began. */
  t: number;
  hz: number;
  changedPercent: number;
  /** Share of the motion grid lit. What the scene-change guard tests. */
  coveragePercent: number;
  rejectedFraction: number;
  /** Microphone level, so a silent room can be told from a deaf one. */
  micLevel: number;
  micThreshold: number;
  whispersHeld: number;
  whispersCaptured: number;
  whispersReplayed: number;
  /** AudioContext state; 'suspended' means nothing can be heard at all. */
  audioContext: string;
  candidateCells: number;
  activeCells: number;
  blobs: number;
  /** Confirmed and currently observed. */
  live: number;
  /** Confirmed but predicted through an occlusion. */
  hidden: number;
  /** Cumulative recent-outline fragment recoveries; no geometry retained in logs. */
  fragmentRecoveries?: number;
  /**
   * Cells one body occupies in this camera's view, as measured at the time.
   * A single aggregate number, no geometry. Present so a session log can show
   * what scale the plausibility bound was working at — without it, a room
   * under-counting people leaves a log indistinguishable from a quiet gallery.
   */
  cellsPerBody?: number | null;
  /** Seen too few times to count as a person yet. */
  candidates: number;
  state: MotionDiagnostics['state'];
  source: string;
};

export type RoomPersonality =
  | 'dormant'
  | 'curious'
  | 'attentive'
  | 'crowded'
  | 'overwhelmed'
  | 'lonely'
  | 'remembering'
  | 'forgetting';

export type RoomConfig = {
  motionSensitivity: number;
  memoryMinutes: number;
  visualIntensity: number;
  ghostFrequency: number;
  whisperFrequency: number;
  forgettingMinutes: number;
  microphoneThreshold: number;
  masterVolume: number;
  privacyMode: boolean;
  blackout: boolean;
  demoMode: boolean;
  mirrorCamera: boolean;
  cameraRotation: 0 | 90 | 180 | 270;
  crop: number;
  keystoneX: number;
  keystoneY: number;
  rotation: number;
  persistenceDays: number;
  spatialCalibration: SpatialCalibration;
  hardwareProfile: HardwareProfile;
  simulationRate: 0 | 60 | 720;
  recordDebugEvents: boolean;
  projectionMode: ProjectionMode;
  visualEngine: VisualEngine;
  /**
   * Which GPU API drives the particle field. `auto` means WebGL2, until WebGPU
   * has passed the recovery, memory, pacing and soak gates as well as parity.
   */
  rendererBackend: RendererPreference;
  /**
   * Share of the motion grid that may light up before a frame is discarded.
   *
   * Renamed from `sceneChangeLimit`, which counted changed *pixels*. Keeping
   * the old key would have let a saved 0.32 — perfectly reasonable as a pixel
   * fraction — be reapplied as a 32% coverage threshold, which rejects a third
   * of all frames. That is exactly what happened on a real installation.
   */
  sceneChangeCoverage: number;
  /** Empty means the browser's default camera. */
  cameraDeviceId: string;
  /** Whether the room says its lines aloud as well as showing them. */
  speech: boolean;
};

/**
 * Why the room did not surface a whisper on its own, named rather than left as
 * an absence. Ordered as `chooseWhisperRecall` applies the checks.
 */
export type WhisperRefusal =
  /** Nothing has been captured yet, or everything has expired. */
  | 'nothing held'
  /** `whisperFrequency` is 0: organic recall is off, not merely rare. */
  | 'frequency is zero'
  /** The roll did not come up. The overwhelmingly common answer. */
  | 'not this time'
  /** Held, but too young to return as memory, or its audio is not in this session. */
  | 'nothing ripe yet';

/**
 * A recall currently being presented on the wall: which memory, when it began,
 * what kind of event it is, and — when the room is forgetting it as it shows it
 * — how that disturbance is progressing.
 */
export type ActiveGhost = {
  ghost: Ghost;
  startedAt: number;
  kind: RecallKind;
  disturbance?: { loss: number; at: { x: number; y: number }; voicePlayed: boolean; admitted: boolean };
};

/** The microphone side, for the instrument and the session log. */
export type AudioSnapshot = {
  running: boolean;
  level: number;
  threshold: number;
  noiseFloor: number;
  suppressed: boolean;
  contextState: string;
  capturing: boolean;
  tooLoud: boolean;
  captured: number;
  replayed: number;
  held: number;
  /**
   * Why the room last declined to surface a whisper by itself, or null once one
   * has been. Capture and replay both working while the piece stays silent is
   * otherwise indistinguishable from a room with nothing to say.
   */
  recall: WhisperRefusal | null;
};

export type RuntimeStatus = {
  /** Epoch timestamps of completed work; preflight must not trust cached FPS. */
  lastRenderAt?: number;
  lastAnalysisAt?: number;
  camera: 'idle' | 'starting' | 'ready' | 'failed';
  microphone: 'idle' | 'starting' | 'ready' | 'failed';
  projector: 'ready' | 'resized';
  people: number;
  density: number;
  fps: number;
  renderLoad: number;
  renderer: string;
  tracking?: string;
  /** Which engine decided the room's interest, and why if it is not the one asked for. */
  interest?: string;
  /** Which engine holds the memory field, and why if it is not the one asked for. */
  memory?: string;
  /** Which engine notices behaviours, and why if it is not the one asked for. */
  behaviour?: string;
  /**
   * The seed this session's randomness runs on.
   *
   * On the console because a seed nobody can read is a seed nobody can replay,
   * which is the entire reason the room has one. `?seed=<n>` pins it.
   */
  seed?: number;
  /** Measured rate of the sensing loop, not the render loop. */
  analysisHz: number;
  cameraResolution: string;
  sensingSamples: number;
  storageBytes: number;
  personality: RoomPersonality;
  emptySeconds: number;
  installationAge: number;
  lastEvent: string;
  lifecycle: RoomLifecycle;
  debugEvents: number;
  currentDay: number;
  ghostCount: number;
  whisperCount: number;
  motion: MotionDiagnostics;
  audio: AudioSnapshot;
};

/**
 * Bumped whenever a saved setting changes meaning rather than merely changing
 * value. A stored config from an older schema is discarded rather than
 * reinterpreted, because a number that is still valid under new semantics is
 * the one kind of stale data that cannot be detected by validating it.
 */
export const CONFIG_SCHEMA = 2;

export const DEFAULT_CONFIG: RoomConfig = {
  motionSensitivity: 24,
  memoryMinutes: 120,
  visualIntensity: 0.85,
  ghostFrequency: 0.55,
  whisperFrequency: 0.4,
  forgettingMinutes: 40,
  microphoneThreshold: 0.004,
  masterVolume: 0.32,
  privacyMode: false,
  blackout: false,
  demoMode: false,
  mirrorCamera: true,
  cameraRotation: 0,
  crop: 0,
  keystoneX: 0,
  keystoneY: 0,
  rotation: 0,
  persistenceDays: 7,
  spatialCalibration: {
    source: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    target: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    calibratedAt: 0,
  },
  hardwareProfile: 'CHEAP',
  simulationRate: 0,
  recordDebugEvents: false,
  projectionMode: 'room',
  visualEngine: 'swarm',
  rendererBackend: 'auto',
  sceneChangeCoverage: 0.85,
  cameraDeviceId: '',
  speech: true,
};
