/**
 * A whole installation, running, with nothing real attached to it.
 *
 * `installation-rendering.test.ts` mounts the component to prove it draws.
 * This mounts it to prove it *runs*: the camera opens, the analysis loop turns
 * real frames into tracks, the operator's keys do what the wall says they do,
 * and the room closes down without leaving a stream, a listener or a frame
 * callback behind.
 *
 * Every device is a double. No camera, microphone, GPU, storage or clock here
 * belongs to the machine the tests run on, and nothing below can reach one.
 */
import type { ReactNode } from 'react';
import { act, dom, mount } from './dom.ts';
import { overrideGlobals, FakeIndexedDb } from './browser.ts';
import { fakeWebGl } from './webgl.ts';
import { AudioContextDouble, WorkletNodeDouble } from './web-audio.ts';
import { saveConfig, saveRoom, type PersistedRoom } from '../persistence.ts';
import type { RoomConfig } from '../room-types.ts';

/** A luminance scene: what the camera is looking at, at a moment. */
export type Scene = (x: number, y: number) => number;

/** One video track, which can be made to drop the way a USB camera does. */
class TrackDouble {
  stopped = false;
  private listeners: Array<() => void> = [];
  constructor(readonly kind: 'video' | 'audio') {}
  stop() { this.stopped = true; }
  addEventListener(event: string, handler: () => void) {
    if (event === 'ended') this.listeners.push(handler);
  }
  removeEventListener(_event: string, handler: () => void) {
    this.listeners = this.listeners.filter((listener) => listener !== handler);
  }
  /** Pull the cable. */
  end() { for (const handler of this.listeners.splice(0)) handler(); }
}

class StreamDouble {
  constructor(readonly tracks: TrackDouble[]) {}
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
}

export type InstallationHarness = Awaited<ReturnType<typeof mountInstallation>>;

export async function mountInstallation(node: ReactNode, options: {
  /** What the camera sees. Replace at any time to move a visitor. */
  scene?: Scene;
  /** Refuse the camera, the microphone, or both, as a browser does. */
  deny?: { camera?: boolean; microphone?: boolean };
  /** A machine with no WebGL2 float targets. */
  gpu?: boolean;
  /** Video inputs enumerateDevices reports once permission is granted. */
  devices?: Array<{ deviceId: string; kind: string; label: string }>;
  /** What the operator had already saved when the page opened. */
  config?: RoomConfig;
  /** What the room already remembered when the page opened. */
  remembered?: PersistedRoom;
} = {}) {
  // The shared fixture's window, not one of its own: React DOM and Base UI
  // bind to the first document they see, so a second jsdom renders a component
  // tree into nothing at all and portals silently never attach.
  const w = dom.window;
  const gpuAvailable = options.gpu ?? true;
  const gl = fakeWebGl();
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Set<NodeJS.Timeout>();
  const painted: Array<{ canvas: HTMLCanvasElement; method: string; args: unknown[] }> = [];
  const cameraStreams: StreamDouble[] = [];
  const microphoneStreams: StreamDouble[] = [];
  const constraints: Array<Record<string, unknown>> = [];
  /** Every request the room made, with what it sent. */
  const fetched: Array<{ url: string; body: string }> = [];
  let scene: Scene = options.scene ?? (() => 40);
  let sequence = 0;
  let now = 1_000;

  /** The video element reads its frame through the 2D canvas, as the tracker does. */
  const context2D = (canvas: HTMLCanvasElement) => {
    let mirrored = false;
    const stack: boolean[] = [];
    return new Proxy({ canvas } as Record<string, unknown>, {
      get(target, key) {
        if (key in target) return Reflect.get(target, key);
        if (key === 'createImageData') {
          return (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) });
        }
        if (key === 'getImageData') {
          return (_x: number, _y: number, width: number, height: number) => {
            const data = new Uint8ClampedArray(width * height * 4);
            for (let y = 0; y < height; y += 1) {
              for (let x = 0; x < width; x += 1) {
                const from = mirrored ? width - 1 - x : x;
                const level = Math.max(0, Math.min(255, scene(from / width, y / height)));
                const at = (y * width + x) * 4;
                data[at] = level; data[at + 1] = level; data[at + 2] = level; data[at + 3] = 255;
              }
            }
            return { data };
          };
        }
        // The trace renderer paints bodies with gradients. A recorder that
        // returns nothing for these throws inside the draw loop rather than
        // failing a test, which is how a fallback surface goes untested.
        if (key === 'createRadialGradient' || key === 'createLinearGradient') {
          return (...args: unknown[]) => {
            const stops: Array<[number, string]> = [];
            painted.push({ canvas, method: String(key), args });
            return { addColorStop: (at: number, colour: string) => { stops.push([at, colour]); }, stops };
          };
        }
        if (key === 'measureText') return (text: string) => ({ width: String(text).length * 6 });
        if (key === 'save') return () => { stack.push(mirrored); };
        if (key === 'restore') return () => { mirrored = stack.pop() ?? false; };
        if (key === 'scale') return (x: number) => { if (x < 0) mirrored = !mirrored; };
        return (...args: unknown[]) => { painted.push({ canvas, method: String(key), args }); };
      },
      set(target, key, value) { Reflect.set(target, key, value); return true; },
    });
  };

  const nativeGetContext = Object.getOwnPropertyDescriptor(w.HTMLCanvasElement.prototype, 'getContext')!;
  Object.defineProperty(w.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value(this: HTMLCanvasElement, kind: string) {
      if (kind === 'webgl2') {
        if (!gpuAvailable) return null;
        Object.assign(gl.gl, { canvas: this });
        return gl.gl;
      }
      return context2D(this);
    },
  });
  // A video element in jsdom has no picture; the tracker only needs it to say
  // it is ready and how large its frame is.
  for (const [property, value] of [['readyState', 4], ['videoWidth', 640], ['videoHeight', 360]] as const) {
    Object.defineProperty(w.HTMLVideoElement.prototype, property, { configurable: true, get: () => value });
  }
  Object.defineProperty(w.HTMLVideoElement.prototype, 'play', { configurable: true, value: async () => {} });
  Object.defineProperty(w.HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: async () => {} });

  const mediaDevices = {
    async getUserMedia(request: { video?: unknown; audio?: unknown }) {
      constraints.push(request as Record<string, unknown>);
      if (request.video) {
        if (options.deny?.camera) throw new Error('NotAllowedError');
        const stream = new StreamDouble([new TrackDouble('video')]);
        cameraStreams.push(stream);
        return stream;
      }
      if (options.deny?.microphone) throw new Error('NotAllowedError');
      const stream = new StreamDouble([new TrackDouble('audio')]);
      microphoneStreams.push(stream);
      return stream;
    },
    async enumerateDevices() {
      return options.devices ?? [{ deviceId: 'default', kind: 'videoinput', label: 'Ceiling camera' }];
    },
  };

  const store = new FakeIndexedDb();
  // Only the devices are replaced; the DOM globals are the fixture's own.
  const restore = overrideGlobals({
    // jsdom's Navigator exposes everything through getters that must be
    // invoked on the real Navigator, so the doubles go in front of it through
    // a proxy. An Object.create with it as the prototype reads `userAgent` with
    // the wrong `this`, which is enough to stop Base UI rendering at all.
    navigator: new Proxy(w.navigator, {
      get(target, key) {
        if (key === 'mediaDevices') return mediaDevices;
        if (key === 'hardwareConcurrency') return 8;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    localStorage: w.localStorage, indexedDB: store,
    AudioContext: class extends AudioContextDouble {},
    AudioWorkletNode: class extends WorkletNodeDouble {
      constructor(context: AudioContextDouble) { super(); context.worklet = this; }
    },
    // Only `now` is replaced. React's development build reaches for
    // `performance.mark` and friends, so a bare object with one method breaks
    // rendering before any test can run — and those methods must still be
    // invoked on the real Performance, which rejects a stand-in `this`.
    performance: new Proxy(performance, {
      get(target, key) {
        if (key === 'now') return () => now;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++sequence, fn); return sequence; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    fetch: async (url: string, init?: { body?: string }) => {
      fetched.push({ url: String(url), body: String(init?.body ?? '') });
      return { ok: false, status: 404 };
    },
    URL: Object.assign(w.URL, { createObjectURL: () => 'blob:room', revokeObjectURL: () => {} }),
  });
  // The component reaches for window.setTimeout; keep every one so a test can
  // be sure nothing is left ticking after unmount.
  // The frame clock goes on the window as well as on globalThis: the
  // installation's draw loop reads the global, while anything that renders
  // through the element's own window — a portal opening, a focus trap — reads
  // it from there, and the two must be the same clock or half the page waits
  // for a frame that never comes.
  const nativeFrames = {
    request: Object.getOwnPropertyDescriptor(w, 'requestAnimationFrame')!,
    cancel: Object.getOwnPropertyDescriptor(w, 'cancelAnimationFrame')!,
  };
  Object.defineProperty(w, 'requestAnimationFrame', {
    configurable: true,
    value: (fn: FrameRequestCallback) => { frames.set(++sequence, fn); return sequence; },
  });
  Object.defineProperty(w, 'cancelAnimationFrame', {
    configurable: true,
    value: (id: number) => { frames.delete(id); },
  });

  const nativeSetTimeout = setTimeout;
  const nativeTimeout = Object.getOwnPropertyDescriptor(w, 'setTimeout')!;
  Object.defineProperty(w, 'setTimeout', {
    configurable: true,
    value: (handler: () => void, ms?: number) => {
      const timer = nativeSetTimeout(handler, ms);
      timers.add(timer);
      return timer;
    },
  });

  /**
   * Intervals are held rather than run.
   *
   * The room publishes what it knows on a one-second interval — the status the
   * console and the instrument read, and the heartbeat the launcher reads. A
   * test that waited for the real second would spend most of its time asleep,
   * and one that spent less would be reading a status from before the thing it
   * just did. `tick` runs them on demand instead.
   */
  const intervals = new Map<number, () => void>();
  let intervalId = 0;
  const nativeInterval = {
    set: Object.getOwnPropertyDescriptor(w, 'setInterval')!,
    clear: Object.getOwnPropertyDescriptor(w, 'clearInterval')!,
  };
  Object.defineProperty(w, 'setInterval', {
    configurable: true,
    value: (handler: () => void) => { intervals.set(++intervalId, handler); return intervalId; },
  });
  Object.defineProperty(w, 'clearInterval', {
    configurable: true,
    value: (id: number) => { intervals.delete(id); },
  });

  // Written after the globals are in place and before anything is mounted:
  // the component reads the saved config while it is constructing its state,
  // and asks the store for what it remembered on its first effect.
  if (options.config) saveConfig(options.config);
  if (options.remembered) await saveRoom(options.remembered);

  const view = await mount(node);

  return {
    window: w,
    gl,
    painted,
    store,
    constraints,
    fetched,
    cameraStreams,
    microphoneStreams,
    /** Frame callbacks still scheduled — zero after a clean unmount. */
    get pendingFrames() { return frames.size; },
    /** What the camera is looking at. */
    look(next: Scene) { scene = next; },
    /**
     * Run whatever is waiting on a frame, without moving the clock.
     *
     * The harness owns requestAnimationFrame so the draw loop can be stepped
     * deliberately, and everything else that waits for a frame — a portal
     * opening, a focus trap taking hold — waits behind it. A browser paints
     * after an interaction; so does this.
     */
    async paint(rounds = 2) {
      for (let round = 0; round < rounds; round += 1) {
        const pending = [...frames.values()];
        frames.clear();
        await act(async () => { for (const callback of pending) callback(now); });
      }
    },
    /**
     * Advance the clock by one step of the room's two loops.
     *
     * The room draws on a frame and senses on a 12 ms interval, and they fail
     * independently — which is the whole reason the instrument reports them
     * separately. A step runs both, because a browser does.
     */
    async advance(ms: number, steps = 1) {
      for (let step = 0; step < steps; step += 1) {
        now += ms;
        const pending = [...frames.values()];
        frames.clear();
        const handlers = Array.from(intervals.values());
        await act(async () => {
          for (const callback of pending) callback(now);
          for (const handler of handlers) handler();
        });
      }
    },
    /** Run every held interval once, publishing what the room currently knows. */
    async tick(rounds = 1) {
      for (let round = 0; round < rounds; round += 1) {
        // Snapshotted: a handler may clear its own interval while running.
        const handlers = Array.from(intervals.values());
        await act(async () => { for (const handler of handlers) handler(); });
      }
    },
    /** Intervals still registered — zero after a clean unmount. */
    get pendingIntervals() { return intervals.size; },
    /** Let pending promises and timers settle. */
    async settle(ms = 0) {
      await act(async () => { await new Promise((resolve) => nativeSetTimeout(resolve, ms)); });
    },
    async key(key: string, init: KeyboardEventInit = {}) {
      await act(async () => { w.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, ...init })); });
      await this.paint();
    },
    async pointer(x: number, y: number) {
      await act(async () => {
        w.dispatchEvent(Object.assign(new w.Event('pointermove'), { clientX: x, clientY: y }));
      });
    },
    /** Tell a field its value changed, the way a file picker or a select does. */
    async change(element: Element | null) {
      if (!(element instanceof w.HTMLElement)) throw new Error('Expected a field');
      await act(async () => { element.dispatchEvent(new w.Event('change', { bubbles: true })); });
      await this.paint();
    },
    async click(element: Element | null) {
      if (!(element instanceof w.HTMLElement)) throw new Error('Expected a clickable element');
      await act(async () => { element.click(); });
      await this.paint();
    },
    text: () => w.document.body.textContent ?? '',
    query: (selector: string) => w.document.querySelector(selector),
    queryAll: (selector: string) => [...w.document.querySelectorAll(selector)],
    button: (match: RegExp) => [...w.document.querySelectorAll('button')].find((node) => match.test(node.textContent ?? '')) ?? null,
    async close() {
      await view.close();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      Object.defineProperty(w, 'requestAnimationFrame', nativeFrames.request);
      Object.defineProperty(w, 'cancelAnimationFrame', nativeFrames.cancel);
      Object.defineProperty(w, 'setTimeout', nativeTimeout);
      Object.defineProperty(w, 'setInterval', nativeInterval.set);
      Object.defineProperty(w, 'clearInterval', nativeInterval.clear);
      Object.defineProperty(w.HTMLCanvasElement.prototype, 'getContext', nativeGetContext);
      restore();
    },
  };
}

/**
 * A bright figure on a dark wall, centred at `x` and `y`.
 *
 * The default size is a body at the geometry the work prescribes — a camera
 * mounted high, looking across a gallery — where a visitor covers about seven
 * cells of the 40x23 motion grid. A desk-range figure filling a third of the
 * frame is a different scene, and measuring against one is how a constant that
 * encoded one camera distance came to be applied as a property of people.
 */
export function figure(x: number, y = 0.5, width = 0.07, height = 0.16): Scene {
  return (px, py) => (Math.abs(px - x) < width / 2 && Math.abs(py - y) < height / 2 ? 210 : 40);
}

/** Two or more figures at gallery scale, for the behaviours that need company. */
export function figures(...positions: number[]): Scene {
  const parts = positions.map((x) => figure(x));
  return (x, y) => Math.max(...parts.map((part) => part(x, y)));
}
