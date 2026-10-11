'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { OperatorConsole } from '@/components/operator-console';
import { type DiagnosticTrack, SensingDiagnostics } from '@/components/sensing-diagnostics';
import { MemoryCollisions } from '@/lib/memory-disturbance';
import { SensingLog, sensingSample } from '@/lib/room-telemetry';
import { rememberDepartures } from '@/lib/room-capture';
import { createRuntimeStatus } from '@/lib/room-status';
import { composeRoomBodies } from '@/lib/room-bodies';
import { PointerPresence } from '@/lib/pointer-presence';
import { AnalysisClock } from '@/lib/analysis-clock';
import { AudioMemoryEngine } from '@/lib/audio-memory';
import {
  choosePersonality,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  memoryDensity,
  rememberWhisper as mutateWhisper,
  trimExpired,
} from '@/lib/memory-engine';
import { chooseWhisperRecall, type WhisperRefusal } from '@/lib/whisper-recall';
import { CALIBRATION_TARGETS, mapCameraPoint, mapRoomPoint } from '@/lib/room-projection';
import { makeGrain } from '@/lib/room-canvas';
import {
  FramePacer,
  paintGround,
  paintOverlays,
  paintTraceFrame,
  resetContext,
} from '@/lib/room-frame';
import { projectionStyle, surfaceSize } from '@/lib/projection-surface';
import { RoomEmergence } from '@/lib/room-emergence';
import {
  OPENING_DURATION_MS,
  closeDay as closingRecall,
  fallsToAfterHours,
  openDay as openingDay,
} from '@/lib/room-lifecycle';
import { UPKEEP_INTERVAL_MS, WHISPERS_MAX, remember, upkeep } from '@/lib/room-upkeep';
import { DebugRecorder, DebugReplay } from '@/lib/debug-recorder';
import { describeSources, gatherBlobs } from '@/lib/sensor-inputs';
import { CountedRate, RateMeter, RenderLoad } from '@/lib/rate-meter';
import { pointerBlob, roomCommand, toggleMute } from '@/lib/room-keys';
import {
  DEVICE_RETRY_MS,
  MICROPHONE_CAPTURE,
  cameraConstraints,
  cameraFailure,
  videoInputs,
} from '@/lib/media-devices';
import { isRememberable, normalizeGhost, normalizeWhisper } from '@/lib/memory-records';
import {
  debugEventsPayload, exportFilename, parseDebugEvents, sensingLogPayload,
} from '@/lib/session-export';
import { downloadJson } from '@/lib/browser-download';
import { advanceCalibration } from '@/lib/calibration-flow';
import { paletteFor, PERSONALITY_RENDER } from '@/lib/palette';
import { MotionTracker, selectObservedTracks } from '@/lib/motion-tracker';
import type { RoomRenderer } from '@/lib/room-renderer';
import { mountRoomRenderer } from '@/lib/renderer-mount';
import { SWARM_BUDGET } from '@/lib/swarm';
import { RoomVoice, type Utterance, UTTERANCE_LIFETIME_MS, type VoiceKind } from '@/lib/room-voice';
import { RoomSpeech, browserSpeechHost } from '@/lib/room-speech';
import {
  RenderedVoice,
  elementVoicePlayer,
  loadVoiceManifest,
  webAudioVoicePlayer,
} from '@/lib/rendered-speech';
import { browserBeatPost, sendSupervisorBeat, supervisorBeat } from '@/lib/supervisor-beat';
import { stereoPanFor } from '@/lib/spatial-audio';
import { RendererHealth } from '@/lib/renderer-health';
import { RoomRng, sessionSeed } from '@/lib/room-rng';
import {
  type AttentionRuntime, type BehaviorRuntime, type RoomInterest, type TrackingRuntime,
  FieldRuntime, mountEngines } from '@/lib/engine-mounts';
import { HEARTBEAT_INTERVAL_MS, type Heartbeat } from '@/lib/liveness';
import { clearRoom, loadConfig, loadRoom, readSavedConfig, saveConfig, saveRoom } from '@/lib/persistence';
import { chooseHardwareProfile, probeMachine } from '@/lib/hardware-profile';
import { GallerySimulation, HARDWARE_PROFILES } from '@/lib/simulation';
import {
  type ActiveGhost,
  type Ghost,
  DEFAULT_CONFIG,
  type RoomConfig,
  type RoomPersonality,
  type RoomLifecycle,
  type RuntimeStatus,
  type VisitorTrack,
  type WhisperMemory,
} from '@/lib/room-types';

export function RoomInstallation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const swarmHostRef = useRef<HTMLDivElement>(null);
  const swarmRef = useRef<RoomRenderer | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fieldRef = useRef(new FieldRuntime());
  const tracksRef = useRef<VisitorTrack[]>([]);
  const ghostsRef = useRef<Ghost[]>([]);
  const whispersRef = useRef<WhisperMemory[]>([]);
  const trackerRef = useRef<MotionTracker | null>(null);
  const trackManagerRef = useRef<TrackingRuntime | null>(null);
  const audioRef = useRef<AudioMemoryEngine | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const activeGhostsRef = useRef<ActiveGhost[]>([]);
  const collisionsRef = useRef(new MemoryCollisions());
  const pointerRef = useRef(new PointerPresence());
  const simulationRef = useRef(new GallerySimulation());
  const debugRef = useRef(new DebugRecorder());
  const replayRef = useRef<DebugReplay | null>(null);
  const lifecycleRef = useRef<RoomLifecycle>('opening');
  const dayRef = useRef(1);
  const closingStartedRef = useRef(0);
  const preMuteVolumeRef = useRef(DEFAULT_CONFIG.masterVolume);
  const [config, setConfig] = useState<RoomConfig>(() => {
    if (typeof window === 'undefined') return DEFAULT_CONFIG;
    const loaded = loadConfig(DEFAULT_CONFIG);
    // Size the installation to the machine, but never argue with an operator
    // who has already chosen. A hardcoded default is a guess; the machine can
    // simply be asked.
    if (readSavedConfig().hardwareProfile) return loaded;
    return { ...loaded, hardwareProfile: chooseHardwareProfile(probeMachine()) };
  });
  const configRef = useRef(config);
  // Restart the camera when the operator picks a different device.
  const cameraDeviceId = config.cameraDeviceId;
  const personalityRef = useRef<RoomPersonality>('dormant');
  const emptySinceRef = useRef(0);
  const installationStartedRef = useRef(0);
  const emergenceRef = useRef(new RoomEmergence());
  /** Every probabilistic decision the room makes. See `room-rng.ts`. */
  const rngRef = useRef<RoomRng | null>(null);
  rngRef.current ??= new RoomRng(sessionSeed()); // lazy: rendered on the server too
  const analysisRateRef = useRef(new RateMeter(30));
  const sensingLogRef = useRef(new SensingLog());
  const lastAnalysisStampRef = useRef(0);
  const voiceRef = useRef(new RoomVoice());
  const speechRef = useRef<RoomSpeech | null>(null);
  const renderedVoiceRef = useRef<RenderedVoice | null>(null);
  /** What the room can notice people doing. Anonymous motion, never written. */
  const behaviorsRef = useRef<BehaviorRuntime | null>(null);
  /**
   * The room's one preference. Anonymous, bounded, and never written: it holds
   * a track id for as long as that track lives and nothing else.
   */
  const attentionRef = useRef<AttentionRuntime | null>(null);
  const lastFrameRef = useRef(0);
  const fpsRef = useRef(new RateMeter(45));
  /**
   * Frames actually presented, counted monotonically.
   *
   * The heartbeat cannot use `status.fps`: that average is written *by* the
   * draw loop, so a loop that has stopped leaves its last healthy value sitting
   * there to be reported forever, and the one failure the heartbeat exists to
   * catch is the one it would have missed. Counting frames and dividing by the
   * watcher's own elapsed time makes a dead loop read as zero.
   */
  const frameCountRef = useRef(0);
  /**
   * World-model steps and camera frames actually analysed, counted separately.
   *
   * The supervisor reads counters rather than rates because a rate can be
   * reported by a loop that has stopped, and because the two answers differ: an
   * engine that stopped advancing means restart the browser, while sensing that
   * stopped means say so and leave the artwork running. See
   * `supervisor-beat.ts`.
   */
  const engineTickRef = useRef(0);
  const sensorFrameRef = useRef(0);
  /**
   * `entered` for the heartbeat, without the heartbeat restarting when it
   * changes. Restarting resets the frame window, so the first beat after a
   * visitor stepped in measured no elapsed time, reported zero frames a second
   * and had the launcher relaunch Chrome in front of them.
   */
  const enteredRef = useRef(false);
  const renderLoadRef = useRef(new RenderLoad());
  const statusRef = useRef(createRuntimeStatus());
  // Survives every rebuild of the renderer, because counting losses is the
  // whole point: one is a display waking, several a minute is a GPU to stop
  // following.
  const rendererHealthRef = useRef(new RendererHealth());
  const [rendererGeneration, setRendererGeneration] = useState(0);
  const [entered, setEntered] = useState(false);
  const [operatorOpen, setOperatorOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  // Read by the draw loop every frame, so nothing needs to re-render for it.
  const trackingOverlayRef = useRef(false);
  const [diagnosticTracks, setDiagnosticTracks] = useState<DiagnosticTrack[]>([]);
  const [cameras, setCameras] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [calibrationStep, setCalibrationStep] = useState<number | null>(null);
  const calibrationSourceRef = useRef<Array<{ x: number; y: number }>>([]);
  const [status, setStatus] = useState(createRuntimeStatus);
  const [permissionMessage, setPermissionMessage] = useState('');
  const [utterance, setUtterance] = useState<Utterance | null>(null);

  useEffect(() => {
    enteredRef.current = entered;
  }, [entered]);

  const updateStatus = useCallback((patch: Partial<RuntimeStatus>) => {
    statusRef.current = { ...statusRef.current, ...patch };
  }, []);

  useEffect(() => {
    const now = Date.now();
    emptySinceRef.current = now;
    installationStartedRef.current = now;
    lastFrameRef.current = performance.now();
    void loadRoom()
      .then((room) => {
        if (!room) return;
        fieldRef.current.restore(room.field);
        ghostsRef.current = trimExpired(
          room.ghosts.map(normalizeGhost).filter(isRememberable),
          now,
          configRef.current.persistenceDays,
        );
        whispersRef.current = trimExpired(room.whispers.map(normalizeWhisper), now, configRef.current.persistenceDays);
        // The recorder stamps events with the animation clock, so it is handed
        // the animation clock here too. Seeding it from `now` — a wall clock —
        // put the first event recorded after a restore about fifty years in the
        // past, which the exporter then wrote out as fact.
        const restored = debugRef.current.adopt(room.debugEvents ?? [], performance.now());
        dayRef.current = room.day ?? 1;
        lifecycleRef.current = room.lifecycle ?? 'after-hours';
        installationStartedRef.current = room.installationStartedAt || now;
        updateStatus({
          lastEvent: 'older memory restored',
          lifecycle: lifecycleRef.current,
          debugEvents: restored,
          currentDay: dayRef.current,
          ghostCount: ghostsRef.current.length,
          whisperCount: whispersRef.current.length,
        });
      })
      .catch(() => updateStatus({ lastEvent: 'memory store unavailable' }));
  }, [updateStatus]);

  /**
   * Offer the room an occasion to speak. It usually declines: speech is the
   * rarest thing it does, and `RoomVoice` owns that decision so no caller can
   * talk it into becoming a narrator.
   */
  const speak = useCallback((
    kind: VoiceKind,
    at: { x: number; y: number },
    /** Whose occasion this is, when the room knows. Ephemeral, never an identity. */
    subject?: string,
  ) => {
    // Nothing is claimed until the background model has stopped moving. The
    // seconds after warmup produce detections worth reacting to and not worth
    // announcing, and a single wrong announcement costs a visitor's belief in
    // every later one.
    const sensing = statusRef.current.motion.state;
    if (sensing === 'warming' || sensing === 'settling') return;
    // An occasion concerning someone the room is interested in is more likely
    // to be taken. The minimum gap is untouched, so this cannot make the room
    // speak more often — only make its one line more likely to be about them.
    const interest = attentionRef.current?.favours(subject) ?? 0;
    const said = voiceRef.current.offer(kind, Date.now(), at, interest);
    if (!said) return;
    setUtterance(said);
    if (configRef.current.speech && configRef.current.masterVolume > 0) {
      // The line is drawn beside whoever caused it; it is now spoken from
      // there too. Same mapping as a remembered whisper, so a memory and a
      // sentence about the same spot come from the same place.
      speechRef.current?.say(
        said.text,
        Math.min(1, configRef.current.masterVolume * 2.2),
        stereoPanFor(said.x),
      );
    }
    window.setTimeout(
      () => setUtterance((current) => (current?.spokenAt === said.spokenAt ? null : current)),
      UTTERANCE_LIFETIME_MS,
    );
  }, []);

  const rememberWhisper = useCallback((memory: WhisperMemory) => {
    const observed = selectObservedTracks(tracksRef.current);
    // One microphone cannot localize a speaker among multiple people.
    memory.position = observed.length === 1
      ? mapRoomPoint(observed[0].position, configRef.current)
      : { x: 0.5, y: 0.5 };
    memory.day = dayRef.current;
    memory.lineage = [memory.id];
    remember(whispersRef.current, memory, WHISPERS_MAX);
    fieldRef.current.deposit(memory.position, 0.025, 2.5);
    updateStatus({ lastEvent: 'a voice was remembered for this session' });
  }, [updateStatus]);

  useEffect(() => {
    if (!entered) return;
    let disposed = false;
    trackerRef.current = new MotionTracker();
    const stopEngines = mountEngines(window.location.search, {
      tracking: (runtime) => { trackManagerRef.current = runtime; },
      interest: (runtime) => { attentionRef.current = runtime; },
      behaviour: (runtime) => { behaviorsRef.current = runtime; },
      field: fieldRef.current });

    const startCamera = async () => {
      updateStatus({ camera: 'starting' });
      try {
        const stream = await navigator.mediaDevices.getUserMedia(
          cameraConstraints(configRef.current.cameraDeviceId),
        );
        if (disposed) return stream.getTracks().forEach((track) => track.stop());
        cameraStreamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        stream.getVideoTracks()[0]?.addEventListener('ended', () => {
          updateStatus({ camera: 'failed', lastEvent: 'camera disconnected — retrying' });
          window.setTimeout(() => { if (!disposed) void startCamera(); }, DEVICE_RETRY_MS);
        }, { once: true });
        // Labels are only populated once permission has been granted, so the
        // list is worth nothing until we are past getUserMedia.
        void navigator.mediaDevices.enumerateDevices().then((devices) => {
          if (disposed) return;
          setCameras(videoInputs(devices));
        }).catch(() => undefined);
        updateStatus({ camera: 'ready', lastEvent: 'the room noticed movement' });
      } catch {
        const failure = cameraFailure(configRef.current.cameraDeviceId);
        updateStatus({ camera: 'failed', lastEvent: failure.lastEvent });
        setPermissionMessage(failure.prompt);
      }
    };

    const startMicrophone = async () => {
      updateStatus({ microphone: 'starting' });
      try {
        const stream = await navigator.mediaDevices.getUserMedia(MICROPHONE_CAPTURE);
        if (disposed) return stream.getTracks().forEach((track) => track.stop());
        microphoneStreamRef.current = stream;
        // Retire whatever is already running before replacing it. This path is
        // re-entered on a 2.5 s retry whenever the device drops, so anything
        // left behind here accumulates for as long as the installation runs.
        audioRef.current?.stop();
        speechRef.current?.stop();
        audioRef.current = new AudioMemoryEngine(rememberWhisper, rngRef.current?.draw);
        // Speech must be able to close the microphone: a spoken line sits
        // inside the analysis band that whispers are detected in.
        // Pre-rendered lines, loaded once: the manifest fetch is cached, and
        // this path re-runs on every microphone retry. Falls back to the
        // platform voice when the files are absent, so the room still speaks.
        if (!renderedVoiceRef.current) {
          const manifest = await loadVoiceManifest();
          // Through the engine's own AudioContext, so the line can be placed in
          // the room. The context is read at play time because it does not
          // exist until `start` below has run. The element player remains as
          // the fallback: losing the context costs the room its placement, not
          // its voice.
          const player = webAudioVoicePlayer(
            () => audioRef.current?.audioContext ?? null,
            elementVoicePlayer(),
          );
          if (manifest && player) renderedVoiceRef.current = new RenderedVoice(manifest, '/voice/', player);
        }
        if (disposed) return;
        speechRef.current = new RoomSpeech(
          (ms) => audioRef.current?.suppressFor(ms),
          browserSpeechHost(),
          renderedVoiceRef.current,
        );
        await audioRef.current.start(stream, configRef.current.microphoneThreshold);
        stream.getAudioTracks()[0]?.addEventListener('ended', () => {
          updateStatus({ microphone: 'failed', lastEvent: 'microphone disconnected — retrying' });
          audioRef.current?.stop();
          speechRef.current?.stop();
          // Release the dead stream here, not at unmount. `microphoneStreamRef`
          // holds one stream, and the retry below overwrites it, so every
          // device drop otherwise abandons a stream whose tracks are never
          // stopped — and a gallery day is long enough for a USB microphone to
          // drop many times. The track that fired this is already ended;
          // stopping it again is harmless, and its siblings are not.
          for (const track of stream.getTracks()) track.stop();
          window.setTimeout(() => { if (!disposed) void startMicrophone(); }, DEVICE_RETRY_MS);
        }, { once: true });
        updateStatus({ microphone: 'ready' });
      } catch {
        updateStatus({ microphone: 'failed', lastEvent: 'microphone unavailable — visual memory continues' });
      }
    };

    void startCamera();
    void startMicrophone();
    return () => {
      disposed = true;
      stopEngines();
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
      audioRef.current?.stop();
      speechRef.current?.stop();
      speechRef.current = null;
    };
  }, [cameraDeviceId, entered, rememberWhisper, updateStatus]);

  /**
   * Sound memory, rolled on its own clock.
   *
   * This used to sit at the bottom of `detectEmergentEvents`, below four early
   * returns — including the cap on concurrent visual recalls. A room busy
   * remembering things to look at was therefore silent, which is exactly
   * backwards: the two kinds of memory are independent and should surface
   * independently.
   */
  const lastWhisperRollRef = useRef(0);
  /**
   * Why the room last declined to surface a whisper.
   *
   * Held so the instrument can answer the question the console otherwise
   * cannot: whispers are in there, the audition button plays them, and the room
   * never says one by itself. `null` once one has actually been recalled.
   */
  const whisperRefusalRef = useRef<WhisperRefusal | null>(null);
  const recallWhisper = useCallback((now: number) => {
    // Advance the clock before any early return, for the same reason
    // `detectEmergentEvents` does: a roll that banks its elapsed time fires a
    // burst the moment whatever was blocking it clears.
    const since = lastWhisperRollRef.current ? (now - lastWhisperRollRef.current) / 1000 : 0;
    lastWhisperRollRef.current = now;
    // Why the room stays quiet is decided in `whisper-recall.ts`, where it can
    // be tested; this reports the refusal so the instrument can show it.
    const decision = chooseWhisperRecall({
      held: whispersRef.current,
      sinceLastRollSeconds: since,
      frequency: configRef.current.whisperFrequency,
      hasRecording: (id) => Boolean(audioRef.current?.hasRecording(id)),
      now: Date.now(),
    });
    whisperRefusalRef.current = decision.because;
    if (!decision.whisper) return;
    const whisper = decision.whisper;
    const held = whispersRef.current;
    const remembered = mutateWhisper(whisper);
    const index = held.findIndex((item) => item.id === whisper.id);
    if (index >= 0) held[index] = remembered;
    audioRef.current?.replay(remembered, configRef.current.masterVolume);
    updateStatus({ lastEvent: 'an imperfect whisper returned elsewhere' });
  }, [updateStatus]);

  /**
   * Offer the room's own behaviours an occasion to happen.
   *
   * Every decision here is in `room-emergence.ts`; what is left is the part
   * that genuinely needs the component — the refs the loop holds, and turning
   * the outcome into speech and a status line.
   */
  const detectEmergentEvents = useCallback((
    tracks: VisitorTrack[],
    emptySeconds: number,
    now: number,
    interest: RoomInterest,
  ) => {
    const outcome = emergenceRef.current.detect({
      tracks,
      ghosts: ghostsRef.current,
      whispers: whispersRef.current,
      active: activeGhostsRef.current,
      config: configRef.current,
      day: dayRef.current,
      lifecycle: lifecycleRef.current,
      emptySeconds,
      now,
      wall: Date.now(),
      attention: interest,
      collisions: collisionsRef.current,
      audio: audioRef.current,
      random: rngRef.current?.draw,
    });
    for (const said of outcome.utterances) speak(said.kind, said.at, said.subject);
    if (outcome.event) updateStatus({ lastEvent: outcome.event });
  }, [speak, updateStatus]);

  useEffect(() => {
    if (!entered) return;
    let timer = 0;
    const analysisClock = new AnalysisClock();
    lastAnalysisStampRef.current = 0;
    analysisRateRef.current.reset();
    const analyze = () => {
      const now = performance.now();
      const profile = HARDWARE_PROFILES[configRef.current.hardwareProfile];
      if (!analysisClock.due(now, profile.analysisIntervalMs)) return;
      // Measure the sensing loop separately from the render loop: they fail
      // independently, and a stalled sensing loop looks exactly like an empty
      // room from the outside.
      if (lastAnalysisStampRef.current) analysisRateRef.current.add(now - lastAnalysisStampRef.current);
      lastAnalysisStampRef.current = now;
      const tracker = trackerRef.current;
      const manager = trackManagerRef.current;
      const interest = attentionRef.current;
      const behaviors = behaviorsRef.current;
      if (!tracker || !manager || !interest || !behaviors) return;
      // Past the clock gate and holding a tracker: the world model is about to
      // advance, whether or not a camera is contributing to it.
      engineTickRef.current += 1;
      const camera = statusRef.current.camera === 'ready' && videoRef.current
        ? tracker.analyze(
          videoRef.current,
          configRef.current.motionSensitivity,
          configRef.current.mirrorCamera,
          configRef.current.sceneChangeCoverage,
        )
        : null;
      if (camera) sensorFrameRef.current += 1;
      const replayed = replayRef.current?.at(now) ?? null;
      if (replayRef.current && !replayed) {
        replayRef.current = null;
        updateStatus({ lastEvent: 'anonymous replay complete' });
      }
      const { blobs, sources } = gatherBlobs({
        camera,
        demo: {
          on: configRef.current.demoMode,
          pointer: configRef.current.demoMode ? pointerRef.current.sample(now) : null,
        },
        simulation: {
          rate: configRef.current.simulationRate,
          blobs: simulationRef.current.sample(now, configRef.current.simulationRate, configRef.current.hardwareProfile),
        },
        replay: replayed,
        maxBodies: profile.maxBodies,
      });
      const { active, ended } = manager.update(blobs, now);
      tracksRef.current = active;
      // Their trace lingers a little longer than anyone else's, for under a
      // minute, a few times a day. Nothing says so.
      fieldRef.current.depositObserved(
        active,
        (point) => mapRoomPoint(point, configRef.current),
        (track) => interest.depositScale(track.id),
      );
      if (configRef.current.recordDebugEvents) debugRef.current.record(active, now);
      for (const merged of rememberDepartures(ended, {
        ghosts: ghostsRef.current, active: activeGhostsRef.current, day: dayRef.current,
        config: configRef.current, wall: Date.now(), now: performance.now(),
        random: rngRef.current?.draw })) {
        speak('convergence', merged.at);
        updateStatus({ lastEvent: merged.event });
      }
      const visibleTracks = selectObservedTracks(active);
      const trackerDiagnostics = tracker.getDiagnostics();
      if (visibleTracks.length) emptySinceRef.current = Date.now();
      const emptySeconds = (Date.now() - emptySinceRef.current) / 1000;
      const density = memoryDensity(fieldRef.current.values);
      if (fallsToAfterHours(lifecycleRef.current, visibleTracks.length, emptySeconds)) {
        lifecycleRef.current = 'after-hours';
      }
      const engine = audioRef.current;
      updateStatus({
        audio: engine
          ? { ...engine.getDiagnostics(), held: whispersRef.current.length, recall: whisperRefusalRef.current }
          : { ...statusRef.current.audio, running: false, held: whispersRef.current.length, recall: whisperRefusalRef.current },
      });
      const sensingState = tracker.getDiagnostics().state;
      const settled = sensingState === 'tracking';
      for (const behavior of behaviors.update(visibleTracks, now, settled)) {
        // Returning to somewhere they left is the strongest reason the room has
        // to find a presence interesting: unlike crossing an old path, which is
        // the room's coincidence, it is something the visitor actually did.
        if (behavior.kind === 'revisit') {
          for (const subject of behavior.subjects) interest.observe('revisit', subject, now);
        }
        speak(behavior.kind, behavior.at, behavior.subjects[0]);
      }
      // Dwelling and stopping are read from the tracks by the engine's own
      // gate, which is where the twenty-second spacing lives. The room decides
      // once, here, and everything downstream reads what it decided.
      interest.update(visibleTracks, now);
      const previousPersonality = personalityRef.current;
      const video = videoRef.current;
      updateStatus({
        analysisHz: analysisRateRef.current.hz,
        tracking: manager.label,
        interest: interest.label,
        memory: fieldRef.current.label,
        behaviour: behaviors.label,
        seed: rngRef.current?.seed,
        lastAnalysisAt: Date.now(),
        cameraResolution: video?.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '—',
      });
      if (sensingLogRef.current.due(now)) {
        const elapsed = sensingLogRef.current.mark(now);
        sensingLogRef.current.push(sensingSample(
          elapsed, statusRef.current.analysisHz, tracker.getDiagnostics(),
          statusRef.current.audio, active, manager.getFragmentRecoveries(),
          whispersRef.current.length, describeSources(sources, '+'),
        ));
        updateStatus({ sensingSamples: sensingLogRef.current.size });
      }
      const nextPersonality = choosePersonality(visibleTracks, emptySeconds, density, previousPersonality);
      personalityRef.current = nextPersonality;
      audioRef.current?.setRoomState(nextPersonality, density, configRef.current.masterVolume);
      // Only on the transition. Compare against the value from before the
      // assignment above, or the condition can never be true.
      if (nextPersonality === 'overwhelmed' && previousPersonality !== 'overwhelmed') {
        speak('crowd', { x: 0.5, y: 0.42 });
      }
      updateStatus({
        people: visibleTracks.length,
        density,
        personality: nextPersonality,
        emptySeconds,
        debugEvents: debugRef.current.size,
        lifecycle: lifecycleRef.current,
        ghostCount: ghostsRef.current.length,
        whisperCount: whispersRef.current.length,
        currentDay: dayRef.current,
        motion: {
          ...trackerDiagnostics,
          blobCount: blobs.length,
          source: describeSources(sources),
          visibleTracks: visibleTracks.length,
          occludedTracks: active.length - visibleTracks.length,
        },
      });
      recallWhisper(now);
      detectEmergentEvents(visibleTracks, emptySeconds, now, interest);
      // Last, so recalls and voices ride the same batch as the visitors.
      fieldRef.current.flush();
    };
    analyze();
    // Tick faster than any profile and let the elapsed check inside `analyze`
    // be the only rate limiter, retaining the deadline remainder. A 42 ms interval gated by a >=42 ms test loses
    // a tick to timer jitter roughly half the time, so FULL delivered about
    // 16 Hz against the 24 Hz it advertises. The instrument caught this.
    timer = window.setInterval(analyze, 12);
    return () => window.clearInterval(timer);
  }, [detectEmergentEvents, entered, recallWhisper, speak, updateStatus]);

  // Forgetting and saving, every fifteen seconds. All the arithmetic is in
  // `room-upkeep.ts`, which is what lets the burn-in run a virtual gallery day
  // of it in a second.
  useEffect(() => {
    if (!entered) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      const result = upkeep({
        field: fieldRef.current.values,
        ghosts: ghostsRef.current,
        whispers: whispersRef.current,
        lifecycle: lifecycleRef.current,
        day: dayRef.current,
        closingStartedAt: closingStartedRef.current,
        emptySeconds: (now - emptySinceRef.current) / 1000,
        installationStartedAt: installationStartedRef.current,
        debugEvents: debugRef.current.all,
      }, configRef.current, now);
      fieldRef.current.decayed(result.decays);
      ghostsRef.current = result.ghosts;
      whispersRef.current = result.whispers;
      lifecycleRef.current = result.lifecycle;
      if (result.event) updateStatus({ lifecycle: result.lifecycle, lastEvent: result.event });
      void saveRoom(result.snapshot).catch(() => updateStatus({ lastEvent: 'memory save failed — artwork continues' }));
      updateStatus({
        storageBytes: result.storageBytes,
        installationAge: (now - installationStartedRef.current) / 1000,
      });
    }, UPKEEP_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [entered, updateStatus]);

  /**
   * Report a pulse to the launcher.
   *
   * Nothing outside the browser could previously tell a running room from a
   * frozen one. The launcher watched the static file server — which has no
   * dependencies, holds no state, and is the least likely thing here to fail —
   * and never watched the page holding the camera, the microphone and twelve
   * hours of accumulated memory.
   *
   * Frame rate is the number that matters: a crashed tab at least shows
   * Chrome's own error page, while a stalled render loop keeps presenting its
   * last frame, which on a dark gallery wall is indistinguishable from a room
   * with nothing to remember.
   *
   * Aggregate counts only, to the local server, exactly like the sensing
   * telemetry: no coordinates, no imagery, nothing written to disk.
   */
  useEffect(() => {
    const presented = new CountedRate(frameCountRef.current, performance.now());
    const send = () => {
      const status = statusRef.current;
      const at = performance.now();
      // Measured against this watcher's own clock, so a stopped draw loop
      // reports zero rather than whatever it last managed.
      const fps = presented.sample(frameCountRef.current, at);
      const beat: Heartbeat = {
        at: Date.now(),
        uptimeMs: at,
        fps,
        sensingHz: Number.isFinite(status.analysisHz) ? status.analysisHz : 0,
        tracks: status.people,
        entered: enteredRef.current,
        engine: status.renderer,
      };
      // keepalive so a beat in flight survives the page being torn down, and a
      // swallowed failure because the exhibit also runs without the launcher.
      void fetch('/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(beat),
        keepalive: true,
      }).catch(() => {});
      // And the counters, for the native supervisor. A second, smaller report
      // rather than a field added to the one above: the launcher reads rates
      // and `roomd` reads forward progress, and `roomd` refuses any payload it
      // does not recognise exactly.
      sendSupervisorBeat(
        window.location.hostname,
        supervisorBeat(enteredRef.current, engineTickRef.current, frameCountRef.current, sensorFrameRef.current),
        browserBeatPost,
      );
    };
    send();
    const interval = window.setInterval(send, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    // The instrument needs to keep up with the sensing loop to be usable; the
    // rest of the time a second is plenty and costs nothing.
    const period = diagnosticsOpen ? 120 : 1000;
    const interval = window.setInterval(() => setStatus({ ...statusRef.current }), period);
    return () => window.clearInterval(interval);
  }, [diagnosticsOpen]);

  // Tracks live in a ref so the render loop can read them without re-rendering.
  // Sample them into state only while the instrument is open.
  useEffect(() => {
    if (!diagnosticsOpen) return;
    const interval = window.setInterval(() => {
      setDiagnosticTracks(tracksRef.current.map((track) => {
        const mapped = mapRoomPoint(track.position, configRef.current);
        return {
          id: track.id,
          sx: track.position.x,
          sy: track.position.y,
          x: mapped.x,
          y: mapped.y,
          occluded: track.occluded,
        };
      }));
    }, 120);
    return () => {
      window.clearInterval(interval);
      setDiagnosticTracks([]);
    };
  }, [diagnosticsOpen]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return;
    const memoryCanvas = document.createElement('canvas');
    memoryCanvas.width = FIELD_WIDTH;
    memoryCanvas.height = FIELD_HEIGHT;
    const memoryContext = memoryCanvas.getContext('2d')!;
    // The retina holds light the room has already emitted. Marks are drawn into
    // it and it is faded, never cleared, so a trace persists in the projected
    // image itself rather than being rebuilt from the data model every frame.
    const retinaCanvas = document.createElement('canvas');
    const retinaContext = retinaCanvas.getContext('2d')!;
    const grain = makeGrain();
    const pacer = new FramePacer();
    let animationFrame = 0;

    const draw = (now: number) => {
      const started = performance.now();
      const config = configRef.current;
      const palette = paletteFor(config.projectionMode);
      const personality = PERSONALITY_RENDER[personalityRef.current];
      const surface = surfaceSize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
      const { width, height } = surface;
      if (pacer.resized(surface.key)) {
        canvas.width = width;
        canvas.height = height;
        retinaCanvas.width = surface.retinaWidth;
        retinaCanvas.height = surface.retinaHeight;
        updateStatus({ projector: 'resized' });
        window.setTimeout(() => updateStatus({ projector: 'ready' }), 1200);
      }

      const swarm = swarmRef.current;
      const useSwarm = Boolean(swarm) && config.visualEngine === 'swarm';

      resetContext(context);
      paintGround(context, {
        width,
        height,
        palette,
        blackout: config.blackout,
        overlayOnly: useSwarm,
      });

      if (useSwarm && swarm) {
        const deltaSeconds = pacer.swarmDelta(now);
        swarm.resize(width, height);
        if (config.blackout) {
          swarm.render({
            deltaSeconds, intensity: 0, drift: 0, unrest: 0, presence: 0, bodies: [],
          });
        } else {
          if (pacer.memoryDue(now)) swarm.setMemoryField(fieldRef.current.values, FIELD_WIDTH, FIELD_HEIGHT);
          const diagnostics = statusRef.current.motion;
          swarm.setPresenceMask(diagnostics.mask, diagnostics.width, diagnostics.height);

          const composition = composeRoomBodies(tracksRef.current, activeGhostsRef.current, config, now);
          const bodies = composition.bodies;
          activeGhostsRef.current = composition.recalls;

          swarm.render({
            deltaSeconds,
            projectionMode: palette.mode,
            intensity: config.visualIntensity,
            drift: personality.drift,
            unrest: personality.unrest,
            presence: personality.presence,
            bodies,
          });
        }
      }

      if (!config.blackout && !useSwarm) {
        paintTraceFrame(
          {
            context,
            retina: retinaContext,
            retinaCanvas,
            memory: memoryContext,
            memoryCanvas,
            grain,
          },
          {
            width,
            height,
            now,
            wall: Date.now(),
            config,
            palette,
            personality,
            field: fieldRef.current.values,
            tracks: tracksRef.current,
            ghosts: ghostsRef.current,
            active: activeGhostsRef,
            retinaDeltaSeconds: pacer.retinaDelta(now),
            repaintMemory: pacer.memoryDue(now),
            closingElapsed: lifecycleRef.current === 'closing'
              ? Date.now() - closingStartedRef.current
              : 0,
            day: dayRef.current,
          },
        );
      }

      paintOverlays(context, {
        width,
        height,
        now,
        config,
        palette,
        tracks: tracksRef.current,
        trackingOverlay: trackingOverlayRef.current,
        calibrationStep,
      });
      // Cancelling webglcontextlost only asks for a restore. A driver that has
      // given up sends no event at all, so the timeout is the only thing that
      // can report it; nothing else in the room would ever say so.
      if (rendererHealthRef.current.poll(now) === 'fallback') {
        updateStatus({
          renderer: 'Canvas 2D traces',
          lastEvent: rendererHealthRef.current.describe(),
        });
      }

      frameCountRef.current += 1;
      if (lastFrameRef.current) fpsRef.current.add(now - lastFrameRef.current);
      lastFrameRef.current = now;
      updateStatus({
        fps: fpsRef.current.hz,
        lastRenderAt: Date.now(),
        renderLoad: renderLoadRef.current.add(performance.now() - started),
      });
      animationFrame = requestAnimationFrame(draw);
    };
    animationFrame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animationFrame);
  }, [calibrationStep, updateStatus]);

  const changeConfig = useCallback((patch: Partial<RoomConfig>) => {
    const next = { ...configRef.current, ...patch };
    configRef.current = next;
    setConfig(next);
    saveConfig(next);
    audioRef.current?.setThreshold(next.microphoneThreshold);
    if (patch.simulationRate !== undefined) simulationRef.current.reset(performance.now());
  }, []);

  const resetMemory = useCallback(async () => {
    fieldRef.current.reset();
    ghostsRef.current = [];
    activeGhostsRef.current = [];
    collisionsRef.current.clear();
    // Interest is part of the room's state even though none of it is written.
    // A reset that left the room attending somebody would not do what the
    // console says; behaviour cooldowns do survive — see `BehaviorRuntime.reset`.
    attentionRef.current?.reset();
    whispersRef.current = [];
    audioRef.current?.clearRecordings();
    debugRef.current.clear();
    emergenceRef.current.reset();
    trackManagerRef.current?.clear();
    installationStartedRef.current = Date.now();
    await clearRoom().catch(() => undefined);
    updateStatus({ density: 0, storageBytes: 0, debugEvents: 0, ghostCount: 0, whisperCount: 0, lastEvent: 'all room memory erased' });
  }, [updateStatus]);

  const relearnEmptyRoom = useCallback(() => {
    trackerRef.current?.reset();
    trackManagerRef.current?.clear();
    tracksRef.current = [];
    emptySinceRef.current = Date.now();
    updateStatus({
      people: 0,
      lastEvent: 'motion background reset — keep the room empty briefly',
      motion: { ...createRuntimeStatus().motion, state: 'warming', source: statusRef.current.camera === 'ready' ? 'camera' : 'none' },
    });
  }, [updateStatus]);

  const startCalibration = () => {
    calibrationSourceRef.current = [];
    setCalibrationStep(0);
    updateStatus({ lastEvent: 'spatial calibration waiting at marker 1' });
  };

  const captureCalibrationPoint = useCallback(() => {
    const track = tracksRef.current.find((candidate) => !candidate.occluded);
    const action = advanceCalibration(calibrationStep, Boolean(track));
    if (!action) return;
    if (action.kind === 'needs-body') {
      updateStatus({ lastEvent: action.message });
      return;
    }
    calibrationSourceRef.current.push(mapCameraPoint(track!.position, configRef.current.cameraRotation));
    if (action.kind === 'advance') {
      setCalibrationStep(action.step);
      updateStatus({ lastEvent: action.message });
      return;
    }
    changeConfig({
      spatialCalibration: {
        source: calibrationSourceRef.current,
        target: CALIBRATION_TARGETS,
        calibratedAt: Date.now(),
      },
    });
    setCalibrationStep(null);
    updateStatus({ lastEvent: action.message });
  }, [calibrationStep, changeConfig, updateStatus]);

  const openDay = () => {
    const opening = openingDay(lifecycleRef.current, dayRef.current);
    dayRef.current = opening.day;
    lifecycleRef.current = opening.lifecycle;
    fieldRef.current.scale(opening.fieldScale);
    activeGhostsRef.current = [];
    tracksRef.current = [];
    updateStatus({ lifecycle: 'opening', currentDay: opening.day, lastEvent: opening.event });
    window.setTimeout(() => {
      if (lifecycleRef.current === 'opening') {
        lifecycleRef.current = 'active';
        updateStatus({ lifecycle: 'active', lastEvent: 'the room is awake' });
      }
    }, OPENING_DURATION_MS);
  };

  const closeDay = () => {
    lifecycleRef.current = 'closing';
    closingStartedRef.current = Date.now();
    const surfacing = closingRecall(ghostsRef.current, dayRef.current, performance.now());
    if (surfacing) activeGhostsRef.current.push(surfacing);
    updateStatus({ lifecycle: 'closing', lastEvent: 'closing ritual — the day is surfacing' });
  };

  const auditionWhispers = useCallback(() => {
    const played = audioRef.current?.audition(whispersRef.current, configRef.current.masterVolume) ?? 0;
    updateStatus({
      lastEvent: played
        ? `auditioning ${played} remembered whisper${played === 1 ? '' : 's'}`
        : 'no voice recordings in this session yet',
    });
  }, [updateStatus]);

  const exportSensingLog = useCallback(() => {
    downloadJson(
      exportFilename('sensing-log'),
      sensingLogPayload({
        config: configRef.current,
        status: statusRef.current,
        samples: sensingLogRef.current.all,
        userAgent: navigator.userAgent,
      }),
    );
    updateStatus({ lastEvent: `sensing log exported (${sensingLogRef.current.size} samples)` });
  }, [updateStatus]);

  const exportDebug = () => {
    downloadJson(exportFilename('room-events'), debugEventsPayload(debugRef.current.all));
    updateStatus({ lastEvent: 'anonymous event recording exported' });
  };

  const replayDebug = () => {
    if (!debugRef.current.size) return;
    trackManagerRef.current?.clear();
    replayRef.current = new DebugReplay(debugRef.current.all, performance.now());
    updateStatus({ lastEvent: 'replaying anonymous sensor events' });
  };

  const importDebug = async (file: File) => {
    // Parsed here, judged in `session-export.ts`. A file a person chose is the
    // only untrusted input this installation has.
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      parsed = null;
    }
    const safe = parseDebugEvents(parsed);
    if (!safe) {
      updateStatus({ lastEvent: 'replay rejected — invalid anonymous event file' });
      return;
    }
    const adopted = debugRef.current.adopt(safe, performance.now());
    updateStatus({ debugEvents: adopted, lastEvent: 'anonymous event recording imported' });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = roomCommand(event, calibrationStep !== null);
      if (!action) return;
      if (action.preventDefault) event.preventDefault();
      switch (action.command) {
        case 'operator': return setOperatorOpen((open) => !open);
        // Sensing instrument. Deliberately its own key: when the room is not
        // seeing anyone the operator needs this without hunting through a console.
        case 'diagnostics': return setDiagnosticsOpen((open) => !open);
        // Tracking overlay. The instrument answers "is the room seeing me" at
        // the laptop; this answers it while you are standing in front of the
        // wall, which is where the question actually gets asked.
        case 'tracking-overlay':
          trackingOverlayRef.current = !trackingOverlayRef.current;
          return;
        case 'fullscreen':
          void document.documentElement.requestFullscreen?.();
          return;
        case 'blackout': return changeConfig({ blackout: !configRef.current.blackout });
        case 'mute': {
          const muted = toggleMute(configRef.current.masterVolume, preMuteVolumeRef.current);
          preMuteVolumeRef.current = muted.held;
          return changeConfig({ masterVolume: muted.masterVolume });
        }
        case 'reset':
          void resetMemory();
          return;
        case 'capture-calibration': return captureCalibrationPoint();
        case 'cancel-calibration': return setCalibrationStep(null);
      }
    };
    const onPointer = (event: PointerEvent) => {
      pointerRef.current.move(
        pointerBlob(event.clientX, event.clientY, window.innerWidth, window.innerHeight),
        performance.now(),
      );
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointermove', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointermove', onPointer);
    };
  }, [calibrationStep, captureCalibrationPoint, changeConfig, resetMemory]);

  // The particle field is a separate GPU surface: a canvas cannot hold both a
  // 2D and a GPU context, and the trace renderer stays available as the
  // fallback for machines without one. Which backend drives it — WebGL2 or
  // WebGPU — is `renderer-startup.ts`'s decision, not this component's.
  /**
   * A lost context is not an error the room can ignore. Every GPU resource is
   * gone, and because this room is dark by design and lit only by the field, a
   * renderer that stops drawing looks exactly like ground nobody has walked on.
   * The draw loop falls through to the trace engine the moment `swarmRef` is
   * cleared, so the room keeps showing something while it waits. What to do
   * about it is `renderer-mount.ts`; this supplies the refs and the surface.
   */
  useEffect(() => {
    const host = swarmHostRef.current;
    if (!host) return;
    return mountRoomRenderer(host, {
      preference: config.rendererBackend,
      budget: SWARM_BUDGET[config.hardwareProfile],
      health: rendererHealthRef.current,
      now: () => performance.now(),
      onRenderer: (renderer) => { swarmRef.current = renderer; },
      onStatus: (renderer, lastEvent) => updateStatus({ renderer, lastEvent }),
      onRebuild: () => setRendererGeneration((generation) => generation + 1),
    });
  }, [config.hardwareProfile, config.rendererBackend, rendererGeneration, updateStatus]);

  // The console and threshold are drawn on the projection surface too. In a
  // dark room a paper-toned panel is a floodlight on the gallery wall and a
  // light source the camera then has to reject, so the chrome follows the
  // projection mode. Set on the document so portalled UI is covered as well.
  useEffect(() => {
    document.documentElement.dataset.projection = config.projectionMode;
    return () => {
      delete document.documentElement.dataset.projection;
    };
  }, [config.projectionMode]);

  const enter = () => {
    setPermissionMessage('Allow the camera and microphone when your browser asks.');
    setEntered(true);
    window.setTimeout(() => setPermissionMessage(''), 6500);
  };

  return (
    <main className="installation-shell">
      <div className="projection-stage" style={projectionStyle(config)}>
        <div ref={swarmHostRef} className="projection projection-swarm" aria-hidden="true" />
        <canvas ref={canvasRef} className="projection projection-traces" aria-hidden="true" />
        {utterance && !config.blackout && (
          <p
            key={utterance.spokenAt}
            className="room-utterance"
            style={{ left: `${utterance.x * 100}%`, top: `${utterance.y * 100}%` }}
            aria-live="polite"
          >
            {utterance.text}
          </p>
        )}
      </div>
      <video ref={videoRef} className="sensor-video" muted playsInline aria-hidden="true" />
      {!entered && (
        <section className="threshold" aria-labelledby="installation-title">
          <p className="eyebrow">An installation in one room</p>
          <h1 id="installation-title">The room remembers you.</h1>
          <p className="privacy-note">
            This room senses movement and listens, entirely on this computer.
            No video is kept — the camera is reduced to anonymous motion, and there is no facial recognition.
            No microphone audio is kept either — a voice is reduced to a loudness shape, without words, the instant it is heard.
            Those anonymous shapes are what the room remembers, on this computer only, across visits — so it may reflect people who were never in it with you. No image, audio, or face is ever saved or sent anywhere.
          </p>
          <button type="button" onClick={enter}>Enter the room</button>
          <p className="operator-hint">Operator: press O · Fullscreen: press F</p>
        </section>
      )}
      {entered && permissionMessage && <output className="sensor-pending">{permissionMessage}</output>}
      <SensingDiagnostics
        open={diagnosticsOpen}
        status={status}
        config={config}
        tracks={diagnosticTracks}
        onExportLog={exportSensingLog}
      />
      <OperatorConsole
        open={operatorOpen}
        onOpenChange={setOperatorOpen}
        config={config}
        status={status}
        onConfig={changeConfig}
        onReset={() => void resetMemory()}
        onRelearnMotion={relearnEmptyRoom}
        calibrationStep={calibrationStep}
        onStartCalibration={startCalibration}
        onOpenDay={openDay}
        onCloseDay={closeDay}
        onAuditionWhispers={auditionWhispers}
        onExportDebug={exportDebug}
        onReplayDebug={replayDebug}
        onImportDebug={(file) => void importDebug(file)}
        cameras={cameras}
      />
    </main>
  );
}
