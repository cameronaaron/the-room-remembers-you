import { whisperTone } from './whisper-tone.ts';
import { SessionAudio } from './session-audio.ts';
import { stereoPanFor } from './spatial-audio.ts';
import type { RoomPersonality, WhisperMemory } from './room-types';

type WhisperCallback = (memory: WhisperMemory) => void;

/**
 * The room tone and the whisper analyser are kept in disjoint frequency bands.
 *
 * A continuous drone would otherwise be heard by the microphone as a permanent
 * raised noise floor: it would either mask real whispers or manufacture false
 * ones, and suppressing the microphone whenever the speakers were active would
 * mean suppressing it always. Separating the bands removes the coupling
 * physically instead of scheduling around it, so no suppression window is
 * needed for the tone at all.
 *
 * `palette.test.ts`'s equivalent for sound is `audio-memory.test.ts`, which
 * fails if these bands ever overlap.
 */
export const TONE_BAND = { minHz: 40, maxHz: 150 } as const;

/**
 * Level a replayed whisper reaches, before the bandpass.
 *
 * The buffer used to be pre-scaled to 0.12 *and* passed through a gain of
 * 0.1, so a recalled whisper arrived at about -44 dBFS: audible only in
 * silence with an ear at the speaker, and nothing at all on a television. The
 * sample data is now written at full scale and the gain node does all the
 * level setting, which is the only place it should ever have lived.
 */
/**
 * Band a sound must fall inside to be captured as a whisper.
 *
 * The upper bound exists so a shout is not recorded as a confidence. It was a
 * flat 0.22, which a person speaking normally close to a laptop microphone
 * clears easily — so the loudest, most deliberate attempts to make the room
 * hear something were exactly the ones it discarded. It is now relative to the
 * threshold and far more generous, and `AudioDiagnostics.tooLoud` reports when
 * a sound is being rejected for being too loud rather than too quiet.
 */
/**
 * Where the whisper threshold actually sits, given what the room sounds like.
 *
 * A fixed absolute threshold cannot work: it has to sit above whatever this
 * room's noise floor happens to be, and rooms differ by orders of magnitude.
 * Measured on a real session, the floor was 0.0001 and speech peaked at 0.042 —
 * a 400x range — while the threshold sat at 0.035, which is 84% of the loudest
 * moment. Two samples out of 307 crossed it, and 161 seconds of talking
 * produced a single whisper.
 *
 * The configured value is a floor, not the answer. The room gets a say.
 */
export const NOISE_MARGIN = 8;

export function effectiveWhisperThreshold(configured: number, noiseFloor: number): number {
  return Math.max(configured, noiseFloor * NOISE_MARGIN);
}

export function whisperBand(threshold: number): { min: number; max: number } {
  return { min: threshold, max: Math.max(0.45, threshold * 12) };
}

/**
 * Read the envelope smoothly.
 *
 * A whisper is stored as at most 32 points. Indexing them with nearest
 * neighbour stepped the amplitude in audible blocks, which added a granular
 * edge on top of the noise. Interpolating recovers the syllabic shape the
 * envelope was recorded to preserve.
 */
export function interpolateEnvelope(envelope: readonly number[], progress: number): number {
  if (!envelope.length) return 0;
  if (envelope.length === 1) return envelope[0];
  const position = Math.max(0, Math.min(1, progress)) * (envelope.length - 1);
  const low = Math.floor(position);
  const high = Math.min(envelope.length - 1, low + 1);
  return envelope[low] + (envelope[high] - envelope[low]) * (position - low);
}

export function whisperReplayGain(volume: number): number {
  return Math.max(0, Math.min(0.45, volume * 0.9));
}

/** What the microphone side is doing, for the sensing instrument. */
export type AudioDiagnostics = {
  running: boolean;
  /** Smoothed level in the voice band, comparable with the threshold. */
  level: number;
  /** The threshold actually in force, after the room's noise floor is applied. */
  threshold: number;
  /** What this room sounds like when nobody is speaking. */
  noiseFloor: number;
  /** Whether the microphone is currently held closed by playback. */
  suppressed: boolean;
  /**
   * AudioContext state. A suspended context accepts every sound and plays
   * none of them, without erroring, which is indistinguishable from a bug
   * anywhere else in the chain.
   */
  contextState: string;
  /** A whisper is part-way through being captured. */
  capturing: boolean;
  /** Sound is arriving, but above the band — rejected for loudness, not silence. */
  tooLoud: boolean;
  /** Whispers captured since the room started. */
  captured: number;
  /** Whispers played back since the room started. */
  replayed: number;
};
export const ANALYSIS_BAND = { minHz: 180, maxHz: 5000 } as const;

/** How each room personality sounds, in the same spirit as PERSONALITY_RENDER. */
export const PERSONALITY_TONE = {
  dormant: { gain: 0.1, detuneCents: 3, cutoffHz: 70, beatHz: 0.03 },
  curious: { gain: 0.3, detuneCents: 9, cutoffHz: 95, beatHz: 0.08 },
  attentive: { gain: 0.42, detuneCents: 6, cutoffHz: 110, beatHz: 0.06 },
  crowded: { gain: 0.6, detuneCents: 17, cutoffHz: 130, beatHz: 0.17 },
  overwhelmed: { gain: 0.72, detuneCents: 34, cutoffHz: 150, beatHz: 0.34 },
  lonely: { gain: 0.22, detuneCents: 4, cutoffHz: 78, beatHz: 0.04 },
  remembering: { gain: 0.5, detuneCents: 11, cutoffHz: 120, beatHz: 0.05 },
  forgetting: { gain: 0.14, detuneCents: 2, cutoffHz: 62, beatHz: 0.02 },
} as const satisfies Record<RoomPersonality, {
  gain: number;
  detuneCents: number;
  cutoffHz: number;
  beatHz: number;
}>;

export class AudioMemoryEngine {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private samples = new Float32Array(256);
  private spectrum = new Uint8Array(128);
  private envelope: number[] = [];
  private whisperStartedAt = 0;
  private cooldownUntil = 0;
  private timer = 0;
  private onWhisper: WhisperCallback;
  private threshold = 0.035;
  private suppressUntil = 0;
  private level = 0;
  private noiseFloor = 0;
  private tooLoud = false;
  private captured = 0;
  private replayed = 0;
  private toneGain: GainNode | null = null;
  private toneFilter: BiquadFilterNode | null = null;
  private toneOscillators: OscillatorNode[] = [];
  private masterVolume = 0.24;
  private recordings: SessionAudio | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private lastVoiceAt = 0;
  private auditionTimers: number[] = [];
  private playing = new Set<AudioBufferSourceNode>();
  private playbackUntil = 0;

  /**
   * Where a whisper sits on the wall, drawn from the room's stream.
   *
   * This was the last `Math.random()` left in the room's authoritative
   * behaviour, and it was the one that mattered most: the position is written
   * into `WhisperMemory`, so it is a durable fact about a memory rather than a
   * rendering choice, and a session could not be replayed without it. The
   * default keeps a caller that has no room — a test, a device probe — working.
   */
  private readonly random: () => number;

  constructor(onWhisper: WhisperCallback, random: () => number = Math.random) {
    this.onWhisper = onWhisper;
    this.random = random;
  }

  async start(stream: MediaStream, threshold: number) {
    this.threshold = threshold;
    this.context = new AudioContext({ latencyHint: 'interactive', sampleRate: 24000 });
    await this.context.resume();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.55;
    this.source = this.context.createMediaStreamSource(stream);
    // Restrict analysis to the voice band. This is what keeps the room tone out
    // of the whisper detector, and it also rejects HVAC rumble and footfall
    // that previously reached the threshold as if they were speech.
    const highpass = this.context.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = ANALYSIS_BAND.minHz;
    highpass.Q.value = 0.7;
    const lowpass = this.context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = ANALYSIS_BAND.maxHz;
    lowpass.Q.value = 0.7;
    this.source.connect(highpass).connect(lowpass).connect(this.analyser);
    const context = this.context;
    await context.audioWorklet.addModule('/audio/capture-worklet.js');
    if (this.context !== context) return;
    this.recordings = new SessionAudio(context.sampleRate);
    this.captureNode = new AudioWorkletNode(context, 'room-capture');
    this.captureNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (performance.now() < this.suppressUntil) {
        this.recordings?.clearRing();
        return;
      }
      this.recordings?.push(event.data);
    };
    // Worklet emits silence; connecting its output keeps capture processing live.
    this.source.connect(this.captureNode).connect(context.destination);
    this.startRoomTone();
    this.poll();
  }

  /**
   * A low drone the room holds continuously. Between rare whispers the
   * installation was otherwise silent, so the room's state was inaudible; this
   * gives density and personality a body in sound.
   */
  private startRoomTone() {
    const context = this.context;
    if (!context || this.toneGain) return;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 90;
    filter.Q.value = 0.6;
    const gain = context.createGain();
    gain.gain.value = 0;
    // Two near-unison voices plus the fifth above: the beating between them is
    // slow enough to read as the room breathing rather than as a chord.
    for (const frequency of [TONE_BAND.minHz + 15, TONE_BAND.minHz + 15.4, (TONE_BAND.minHz + 15) * 1.5]) {
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = Math.min(TONE_BAND.maxHz, frequency);
      oscillator.connect(filter);
      oscillator.start();
      this.toneOscillators.push(oscillator);
    }
    filter.connect(gain).connect(context.destination);
    this.toneGain = gain;
    this.toneFilter = filter;
  }

  /**
   * Move the room tone toward the current state. Always ramped: a stepped gain
   * change is audible as a click in a quiet gallery.
   */
  setRoomState(personality: RoomPersonality, density: number, volume: number) {
    this.masterVolume = volume;
    const context = this.context;
    const gain = this.toneGain;
    const filter = this.toneFilter;
    if (!context || !gain || !filter) return;
    const tone = PERSONALITY_TONE[personality] ?? PERSONALITY_TONE.dormant;
    const presence = Math.min(1, 0.35 + density * 90);
    const target = Math.min(0.09, volume * tone.gain * presence * 0.5);
    const now = context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setTargetAtTime(target, now, 2.5);
    filter.frequency.cancelScheduledValues(now);
    filter.frequency.setTargetAtTime(Math.min(TONE_BAND.maxHz, tone.cutoffHz), now, 4);
    this.toneOscillators.forEach((oscillator, index) => {
      oscillator.detune.cancelScheduledValues(now);
      oscillator.detune.setTargetAtTime(index === 0 ? 0 : tone.detuneCents * (index === 1 ? 1 : -1), now, 5);
    });
  }

  /**
   * Hold the microphone closed. Speech, unlike the room tone, lands inside the
   * analysis band, so the installation would otherwise record its own sentence
   * as a visitor's whisper and replay it later as a memory of someone who was
   * never there.
   */
  suppressFor(milliseconds: number) {
    this.suppressUntil = Math.max(this.suppressUntil, performance.now() + Math.max(0, milliseconds));
  }

  /** Everything the instrument needs to show whether whispers can happen. */
  getDiagnostics(): AudioDiagnostics {
    return {
      running: this.analyser !== null,
      level: Math.round(this.level * 10_000) / 10_000,
      threshold: effectiveWhisperThreshold(this.threshold, this.noiseFloor),
      noiseFloor: Math.round(this.noiseFloor * 100_000) / 100_000,
      suppressed: performance.now() < this.suppressUntil,
      contextState: this.context?.state ?? 'none',
      capturing: this.whisperStartedAt > 0,
      tooLoud: this.tooLoud,
      captured: this.captured,
      replayed: this.replayed,
    };
  }

  setThreshold(threshold: number) {
    this.threshold = threshold;
  }


  private poll = () => {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.samples);
    this.analyser.getByteFrequencyData(this.spectrum);
    const rms = Math.sqrt(this.samples.reduce((sum, sample) => sum + sample * sample, 0) / this.samples.length);
    this.level = this.level * 0.6 + rms * 0.4;
    // Asymmetric tracker: follow a quieter room quickly, a louder one slowly,
    // so a person talking cannot drag the floor up behind them.
    this.noiseFloor = this.noiseFloor === 0
      ? rms
      : rms < this.noiseFloor
        ? this.noiseFloor * 0.9 + rms * 0.1
        : this.noiseFloor * 0.9995 + rms * 0.0005;
    const now = performance.now();
    if (now < this.suppressUntil) {
      this.whisperStartedAt = 0;
      this.envelope = [];
      this.timer = window.setTimeout(this.poll, 85);
      return;
    }
    const band = whisperBand(effectiveWhisperThreshold(this.threshold, this.noiseFloor));
    const whisperLike = rms > band.min && rms < band.max;
    this.tooLoud = rms >= band.max;
    if (whisperLike && now > this.cooldownUntil) {
      if (!this.whisperStartedAt) this.whisperStartedAt = now;
      this.lastVoiceAt = now;
      this.envelope.push(Math.min(1, rms / 0.18));
      if (now - this.whisperStartedAt >= 6000) this.finishWhisper(now);
    } else if (this.whisperStartedAt && now - this.lastVoiceAt >= 400) {
      this.finishWhisper(now);
    } else if (!whisperLike && !this.whisperStartedAt) {
      this.whisperStartedAt = 0;
      this.envelope = [];
    }
    this.timer = window.setTimeout(this.poll, 85);
  };

  private finishWhisper(now: number) {
    if (!this.envelope.length || !this.analyser) return;
    let weighted = 0;
    let total = 0;
    for (let index = 0; index < this.spectrum.length; index += 1) {
      weighted += index * this.spectrum[index];
      total += this.spectrum[index];
    }
    const brightness = total ? weighted / total / this.spectrum.length : 0.3;
    // Normalise to the loudest moment of this whisper. The envelope records the
    // *shape* of a sound; how loud it comes back is the gain node's business.
    // This used to divide by a hardcoded 0.18, chosen when the capture
    // threshold was 0.035. Once quiet speech could be captured, every whisper
    // was stored at a fraction of full scale and replayed 10-15 dB too quietly.
    const loudest = Math.max(...this.envelope, 1e-6);
    const source = this.envelope.map((value) => value / loudest);
    const transformed = Array.from({ length: Math.min(32, source.length) }, (_, index) => {
      const at = Math.floor(((source.length - 1) * index) / Math.max(1, Math.min(31, source.length - 1)));
      // `at` runs 0..length-1, so the mirrored index does too: in range by
      // construction, and a fallback for it was a value nothing could produce.
      const reversed = source[source.length - at - 1];
      return Math.round(Math.sqrt(reversed) * 1000) / 1000;
    });
    const id = crypto.randomUUID();
    const duration = Math.min(6.5, (now - this.whisperStartedAt) / 1000 + 0.25);
    this.recordings?.capture(id, duration);
    this.captured += 1;
    this.onWhisper({
      id,
      createdAt: Date.now(),
      lastReplayedAt: 0,
      duration,
      envelope: transformed,
      brightness,
      position: { x: this.random(), y: 0.2 + this.random() * 0.6 },
      strength: 0.38,
      fidelity: 1,
      recallCount: 0,
      lineage: [],
      day: 0,
    });
    // PCM remains only in the private session store, never in WhisperMemory.
    this.envelope = [];
    this.samples.fill(0);
    this.spectrum.fill(0);
    this.whisperStartedAt = 0;
    this.cooldownUntil = now + 9000;
  }

  /**
   * Play back everything the room is holding, spaced out, for commissioning.
   *
   * Not part of the artwork: a whisper is supposed to surface rarely and
   * unbidden. But an operator needs to be able to answer "is there anything in
   * there at all", and no amount of waiting tells you that.
   */
  audition(memories: readonly WhisperMemory[], volume: number, spacingMs = 1_400) {
    const context = this.context;
    if (!context || !memories.length) return 0;
    const playable = memories.filter((memory) => this.recordings?.get(memory.id));
    let delay = 0;
    for (const memory of playable) {
      this.auditionTimers.push(window.setTimeout(() => this.replay(memory, volume), delay));
      const duration = this.recordings!.get(memory.id)!.length / context.sampleRate;
      delay += Math.max(spacingMs, duration * 1000 + 700);
    }
    if (playable.length) this.suppressFor(delay + 700);
    return playable.length;
  }

  hasRecording(id: string) { return Boolean(this.recordings?.get(id)); }

  /**
   * The context the room's voice plays through.
   *
   * Shared rather than given its own: one context means one sample rate, one
   * master path, and a spoken line and a remembered whisper mixed together
   * instead of racing each other through separate audio stacks. It does not
   * exist until `start` has run, which is why callers fetch it at play time.
   */
  get audioContext(): AudioContext | null {
    return this.context;
  }

  replay(memory: WhisperMemory, volume: number, loss = 0) {
    const context = this.context;
    const pcm = this.recordings?.get(memory.id);
    if (!context || !pcm?.length || volume <= 0 || context.currentTime < this.playbackUntil) return;
    if (context.state === 'suspended') void context.resume();
    const degradation = Math.max(0, Math.min(1, loss));
    const fragment = pcm.subarray(0, Math.max(1, Math.floor(pcm.length * (1 - degradation * 0.55))));
    const buffer = context.createBuffer(1, fragment.length, context.sampleRate);
    buffer.getChannelData(0).set(whisperTone(fragment, context.sampleRate, degradation));
    const source = context.createBufferSource();
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    source.buffer = buffer;
    source.playbackRate.value = 1;
    const now = context.currentTime;
    const duration = buffer.duration;
    // The prepared voice has a bounded level; this gain follows the master.
    const peak = whisperReplayGain(volume);
    const fade = Math.min(0.01 + degradation * 0.3, duration / 4);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + fade);
    gain.gain.setValueAtTime(peak, now + duration - fade);
    gain.gain.linearRampToValueAtTime(0, now + duration);
    panner.pan.value = stereoPanFor(memory.position.x);
    source.connect(gain).connect(panner).connect(context.destination);
    source.onended = () => { this.playing.delete(source); source.disconnect(); gain.disconnect(); panner.disconnect(); };
    this.playing.add(source);
    this.suppressFor(duration * 1000 + 700);
    source.start();
    this.replayed += 1;
    this.playbackUntil = now + duration;
  }

  clearRecordings() {
    this.auditionTimers.forEach((timer) => window.clearTimeout(timer));
    this.auditionTimers = [];
    for (const source of this.playing) { source.stop(); source.disconnect(); }
    this.playing.clear();
    this.recordings?.clear();
    this.envelope = [];
    this.whisperStartedAt = 0;
    this.playbackUntil = 0;
  }

  stop() {
    window.clearTimeout(this.timer);
    this.clearRecordings();
    if (this.captureNode) this.captureNode.port.onmessage = null;
    this.captureNode?.disconnect();
    this.captureNode = null;
    this.recordings = null;
    for (const oscillator of this.toneOscillators) {
      try {
        oscillator.stop();
      } catch {
        // Already stopped with the context; nothing to unwind.
      }
      oscillator.disconnect();
    }
    this.toneOscillators = [];
    this.toneGain?.disconnect();
    this.toneFilter?.disconnect();
    this.toneGain = null;
    this.toneFilter = null;
    this.source?.disconnect();
    void this.context?.close();
    this.context = null;
    this.analyser = null;
    this.samples.fill(0);
    this.spectrum.fill(0);
  }
}
