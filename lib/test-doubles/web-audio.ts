/**
 * A Web Audio graph that can be inspected instead of heard.
 *
 * Test support, not installation code — it is excluded from the coverage
 * report, and nothing under `lib/` outside the tests may import it.
 *
 * The point is to assert the *graph*, not the calls. The defect this project
 * actually shipped was a room that drew a line beside a visitor and spoke it
 * from the middle of the speakers, because the voice went through an element
 * with a volume and no position. A double that only recorded "play was called"
 * would have been perfectly green while that was true. This one records what is
 * connected to what, and with which parameter values, so a test can ask whether
 * a sound reaches the destination through a panner at all.
 */

export type ParamRecord = { value: number; automation: string[] };

function param(initial = 0): AudioParamDouble {
  return new AudioParamDouble(initial);
}

export class AudioParamDouble {
  value: number;
  readonly automation: string[] = [];

  constructor(initial: number) {
    this.value = initial;
  }

  setValueAtTime(value: number, at: number) {
    this.value = value;
    this.automation.push(`setValueAtTime(${value},${at})`);
    return this;
  }

  linearRampToValueAtTime(value: number, at: number) {
    this.value = value;
    this.automation.push(`linearRamp(${value},${at})`);
    return this;
  }

  setTargetAtTime(value: number, at: number, constant: number) {
    this.value = value;
    this.automation.push(`setTarget(${value},${at},${constant})`);
    return this;
  }

  cancelScheduledValues(at: number) {
    this.automation.push(`cancel(${at})`);
    return this;
  }
}

export class NodeDouble {
  readonly kind: string;
  readonly outputs: NodeDouble[] = [];
  disconnected = false;

  constructor(kind: string) {
    this.kind = kind;
  }

  connect<T extends NodeDouble>(target: T): T {
    this.outputs.push(target);
    return target;
  }

  disconnect() {
    this.disconnected = true;
  }

  /** Every node reachable from here, for asserting a signal path. */
  chain(): string[] {
    const path: string[] = [this.kind];
    for (const output of this.outputs) path.push(...output.chain());
    return path;
  }

  /** Whether a sound starting here passes through `kind` on its way out. */
  reaches(kind: string): boolean {
    return this.chain().includes(kind);
  }
}

export class GainDouble extends NodeDouble {
  readonly gain = param(1);
  constructor() {
    super('gain');
  }
}

export class PannerDouble extends NodeDouble {
  readonly pan = param(0);
  constructor() {
    super('panner');
  }
}

export class FilterDouble extends NodeDouble {
  type = 'lowpass';
  readonly frequency = param(350);
  readonly Q = param(1);
  constructor() {
    super('filter');
  }
}

export class OscillatorDouble extends NodeDouble {
  type = 'sine';
  readonly frequency = param(440);
  readonly detune = param(0);
  started = false;
  stopped = false;
  constructor() {
    super('oscillator');
  }

  start() {
    this.started = true;
  }

  stop() {
    if (this.stopped) throw new Error('already stopped');
    this.stopped = true;
  }
}

export class AnalyserDouble extends NodeDouble {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  /** What the microphone is currently "hearing". Tests set this. */
  samples: Float32Array | null = null;
  spectrum: Uint8Array | null = null;

  constructor() {
    super('analyser');
  }

  getFloatTimeDomainData(target: Float32Array) {
    target.set(this.samples?.subarray(0, target.length) ?? new Float32Array(target.length));
  }

  getByteFrequencyData(target: Uint8Array) {
    target.set(this.spectrum?.subarray(0, target.length) ?? new Uint8Array(target.length));
  }
}

export class BufferSourceDouble extends NodeDouble {
  buffer: AudioBufferDouble | null = null;
  readonly playbackRate = param(1);
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  /**
   * Set when the owning context has closed. Browsers throw InvalidStateError
   * when a node belonging to a closed context is stopped, which the room
   * reaches for real: the microphone engine closes its context and RoomSpeech
   * cancels the voice immediately afterwards.
   */
  contextClosed = false;

  constructor() {
    super('bufferSource');
  }

  start() {
    this.started = true;
  }

  stop() {
    if (this.contextClosed) throw new Error('InvalidStateError: context is closed');
    this.stopped = true;
  }

  /** Let a test run the source to its end, as the browser would. */
  finish() {
    this.onended?.();
  }
}

export class AudioBufferDouble {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly channels: Float32Array[];

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }

  get duration() {
    return this.length / this.sampleRate;
  }

  getChannelData(index: number) {
    return this.channels[index];
  }
}

export class WorkletNodeDouble extends NodeDouble {
  readonly port: { onmessage: ((event: { data: Float32Array }) => void) | null } = { onmessage: null };
  constructor() {
    super('worklet');
  }

  /** Deliver a block of captured audio, as the real worklet does. */
  emit(block: Float32Array) {
    this.port.onmessage?.({ data: block });
  }
}

export class AudioContextDouble {
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;
  readonly sampleRate: number;
  readonly destination = new NodeDouble('destination');
  readonly created: NodeDouble[] = [];
  readonly modules: string[] = [];
  closed = false;
  /** The most recent node of each kind, for tests that need to drive one. */
  analyser: AnalyserDouble | null = null;
  worklet: WorkletNodeDouble | null = null;
  readonly oscillators: OscillatorDouble[] = [];
  readonly sources: BufferSourceDouble[] = [];

  constructor(options: { sampleRate?: number } = {}) {
    this.sampleRate = options.sampleRate ?? 48_000;
  }

  private track<T extends NodeDouble>(node: T): T {
    this.created.push(node);
    return node;
  }

  createAnalyser() {
    this.analyser = this.track(new AnalyserDouble());
    return this.analyser;
  }

  createGain() {
    return this.track(new GainDouble());
  }

  createStereoPanner() {
    return this.track(new PannerDouble());
  }

  createBiquadFilter() {
    return this.track(new FilterDouble());
  }

  createOscillator() {
    const oscillator = this.track(new OscillatorDouble());
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createMediaStreamSource() {
    return this.track(new NodeDouble('mediaStreamSource'));
  }

  createBuffer(channels: number, length: number, sampleRate: number) {
    return new AudioBufferDouble(channels, length, sampleRate);
  }

  createBufferSource() {
    const source = this.track(new BufferSourceDouble());
    this.sources.push(source);
    return source;
  }

  decodeAudioData(bytes: ArrayBuffer) {
    // Length is carried in the fake payload so a test can assert durations.
    const length = Math.max(1, new Uint8Array(bytes).length);
    return Promise.resolve(new AudioBufferDouble(1, length, this.sampleRate));
  }

  readonly audioWorklet = {
    addModule: (url: string) => {
      this.modules.push(url);
      return Promise.resolve();
    },
  };

  /** How often the code under test resumed this context. */
  resumes = 0;

  resume() {
    this.resumes += 1;
    this.state = 'running';
    return Promise.resolve();
  }

  close() {
    this.state = 'closed';
    this.closed = true;
    return Promise.resolve();
  }

  /** Nodes of one kind that were built in this context. */
  nodesOfKind(kind: string) {
    return this.created.filter((node) => node.kind === kind);
  }
}

/**
 * Install the globals the audio code reaches for, and hand back a restore
 * function. Timers are real but driven by the test's own clock where possible;
 * `window.setTimeout` exists only so the poll loop can schedule itself.
 */
export function installAudioGlobals(options: { sampleRate?: number } = {}) {
  const scope = globalThis as Record<string, unknown>;
  const previous = new Map<string, unknown>();
  const contexts: AudioContextDouble[] = [];
  const timers = new Set<NodeJS.Timeout>();

  const remember = (key: string, value: unknown) => {
    previous.set(key, scope[key]);
    scope[key] = value;
  };

  remember('AudioContext', class extends AudioContextDouble {
    constructor(settings: { sampleRate?: number } = {}) {
      super({ ...options, ...settings });
      contexts.push(this);
    }
  });
  remember('AudioWorkletNode', class extends WorkletNodeDouble {
    constructor(context: AudioContextDouble) {
      super();
      context.worklet = this;
    }
  });
  remember('window', {
    setTimeout: (handler: () => void, ms?: number) => {
      const timer = setTimeout(handler, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer: NodeJS.Timeout) => {
      timers.delete(timer);
      clearTimeout(timer);
    },
  });

  return {
    contexts,
    /** The context most recently constructed by the code under test. */
    get context() {
      return contexts.at(-1) ?? null;
    },
    restore() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const [key, value] of previous) {
        if (value === undefined) delete scope[key];
        else scope[key] = value;
      }
    },
  };
}

/**
 * A block of audio whose RMS is exactly `level`.
 *
 * Alternating rather than sinusoidal on purpose: the code under test measures
 * RMS, and a test that has to divide by root two to work out which side of a
 * threshold it is on is a test about trigonometry.
 */
export function tone(level: number, length = 256): Float32Array {
  return Float32Array.from({ length }, (_, index) => (index % 2 ? -level : level));
}

/** A spectrum with its energy at one place in the band. */
export function spectrumAt(bin: number, length = 128): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index === bin ? 255 : 0));
}
