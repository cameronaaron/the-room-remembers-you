/**
 * The browser surfaces the installation reaches for, small enough to reason
 * about and controllable enough to fail on purpose.
 *
 * Test support, not installation code — excluded from the coverage report, and
 * nothing outside the tests may import it.
 *
 * Each double exists because the real thing fails in ways the installation has
 * to survive unattended: a camera element that is not ready yet, a store that
 * refuses to open, a machine with no WebGL at all. Those paths are the whole
 * reason the code branches, and none of them could be reached from a test.
 */

/**
 * Replace a global, even one Node exposes through a getter only.
 *
 * `navigator` and `crypto` are accessor properties on globalThis, so a plain
 * assignment throws rather than overriding them. Returns a restore function.
 */
export function overrideGlobals(values: Record<string, unknown>) {
  const scope = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(scope, key));
    Object.defineProperty(scope, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(scope, key, descriptor);
      else delete scope[key];
    }
  };
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

type Request<T> = {
  result: T;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
};

/** Fires callbacks on a later turn, as the real database does. */
function settle(request: Request<unknown>, ok: boolean) {
  queueMicrotask(() => (ok ? request.onsuccess?.() : request.onerror?.()));
}

export class FakeIndexedDb {
  private readonly stores = new Map<string, Map<string, unknown>>();
  /** Set to make the next open fail, as a browser in private mode can. */
  failOpen = false;
  /** Set to make reads and writes fail after a successful open. */
  failRequests = false;
  opens = 0;
  closes = 0;

  open(_name: string, _version: number) {
    this.opens += 1;
    const database = this.database();
    const request: Request<typeof database> = {
      result: database,
      error: this.failOpen ? new Error('store unavailable') : null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };
    queueMicrotask(() => {
      if (this.failOpen) {
        request.onerror?.();
        return;
      }
      request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }

  /** What a store holds, for asserting exactly what reached disk. */
  contents(store: string) {
    return this.stores.get(store) ?? new Map<string, unknown>();
  }

  private database() {
    // Arrow functions throughout, so the store reads `this` from the enclosing
    // FakeIndexedDb rather than from whichever object the caller invoked.
    return {
      objectStoreNames: {
        contains: (name: string) => this.stores.has(name),
      },
      createObjectStore: (name: string) => {
        this.stores.set(name, new Map());
      },
      close: () => {
        this.closes += 1;
      },
      transaction: (storeName: string) => {
        const store = this.stores.get(storeName) ?? new Map<string, unknown>();
        this.stores.set(storeName, store);
        const transaction = {
          error: this.failRequests ? new Error('transaction failed') : null,
          oncomplete: null as (() => void) | null,
          onerror: null as (() => void) | null,
          objectStore: (_name: string) => {
            const make = <T>(result: T): Request<T> => {
              const request: Request<T> = {
                result,
                error: this.failRequests ? new Error('operation failed') : null,
                onsuccess: null,
                onerror: null,
              };
              settle(request as Request<unknown>, !this.failRequests);
              return request;
            };
            return {
              get: (key: string) => make(store.get(key)),
              put: (value: unknown, key: string) => {
                if (!this.failRequests) store.set(key, value);
                return make(undefined);
              },
              delete: (key: string) => {
                if (!this.failRequests) store.delete(key);
                return make(undefined);
              },
            };
          },
        };
        // A real transaction completes a turn after its requests are issued.
        queueMicrotask(() => queueMicrotask(() => {
          if (this.failRequests) transaction.onerror?.();
          else transaction.oncomplete?.();
        }));
        return transaction;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// localStorage
// ---------------------------------------------------------------------------

export class FakeStorage {
  private readonly entries = new Map<string, string>();
  /** A browser with site data blocked throws on every access. */
  throwOnAccess = false;

  getItem(key: string) {
    if (this.throwOnAccess) throw new Error('storage is not available');
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    if (this.throwOnAccess) throw new Error('storage is not available');
    this.entries.set(key, value);
  }

  removeItem(key: string) {
    if (this.throwOnAccess) throw new Error('storage is not available');
    this.entries.delete(key);
  }

  /** What is actually stored, for asserting what was written. */
  raw(key: string) {
    return this.entries.get(key) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Canvas, WebGL and video
// ---------------------------------------------------------------------------

export type WebGlDescription = {
  floatTargets: boolean;
  /**
   * What the driver answers when asked what it is.
   *
   * `null` is a real answer: some drivers return null for the renderer string
   * rather than an empty one, and the profile chooser reads it as text.
   */
  renderer: string | null;
  /** Whether the machine exposes the unmasked renderer string at all. */
  debugInfo?: boolean;
};

/**
 * A 2D canvas that draws a video's frame.
 *
 * `drawImage` copies whatever the fake video is showing, honouring the mirror
 * transform, so a test can assert that a mirrored camera really is mirrored
 * rather than that `scale(-1, 1)` was called.
 */
class FakeContext2D {
  private readonly width: number;
  private readonly height: number;
  private pixels: Uint8ClampedArray;
  private mirrored = false;
  private stack: boolean[] = [];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }

  save() {
    this.stack.push(this.mirrored);
  }

  restore() {
    this.mirrored = this.stack.pop() ?? false;
  }

  translate() {
    /* recorded through scale */
  }

  scale(x: number) {
    if (x < 0) this.mirrored = !this.mirrored;
  }

  drawImage(video: FakeVideo) {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const from = this.mirrored ? this.width - 1 - x : x;
        const level = video.levelAt(from / this.width, y / this.height);
        const at = (y * this.width + x) * 4;
        this.pixels[at] = level;
        this.pixels[at + 1] = level;
        this.pixels[at + 2] = level;
        this.pixels[at + 3] = 255;
      }
    }
  }

  getImageData() {
    return { data: this.pixels };
  }
}

/** A camera showing a scene described as a luminance function. */
export class FakeVideo {
  readyState = 4;
  videoWidth = 640;
  videoHeight = 360;
  scene: (x: number, y: number) => number = () => 80;

  levelAt(x: number, y: number) {
    return Math.max(0, Math.min(255, this.scene(x, y)));
  }
}

/**
 * Install `document`, `navigator` and friends. `webgl` describes what the
 * machine can do, or null for a machine with no WebGL2 at all.
 */
export function installDomGlobals(options: {
  cores?: number;
  webgl?: WebGlDescription | null;
  canvas2d?: boolean;
  throwOnCreate?: boolean;
} = {}) {
  const { webgl = { floatTargets: true, renderer: 'Apple M3 Max' }, canvas2d = true } = options;
  let lostContexts = 0;

  const restore = overrideGlobals({
    navigator: { hardwareConcurrency: options.cores ?? 8 },
    document: {
    createElement(tag: string) {
      if (options.throwOnCreate) throw new Error('document is not available');
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext(kind: string) {
          if (kind === '2d') {
            return canvas2d ? new FakeContext2D(this.width || 160, this.height || 90) : null;
          }
          if (kind !== 'webgl2' || !webgl) return null;
          // Per context, not per canvas: `SwarmRenderer.probe` acquires a
          // context purely to read an extension and then loses it on purpose,
          // and in a browser that is a different context from the one the
          // renderer goes on to use. A flag shared between them would have the
          // probe reporting the renderer dead before it had drawn anything.
          let lost = false;
          return {
            RENDERER: 0x1f01,
            getExtension(name: string) {
              if (name === 'EXT_color_buffer_float') return webgl.floatTargets ? {} : null;
              if (name === 'WEBGL_debug_renderer_info') {
                return webgl.debugInfo === false ? null : { UNMASKED_RENDERER_WEBGL: 0x9246 };
              }
              if (name === 'WEBGL_lose_context') {
                return { loseContext: () => { lostContexts += 1; lost = true; } };
              }
              return null;
            },
            // A real WebGL2 context always answers this, and `SwarmRenderer`
            // reads it for `alive`. A double that omits it makes a renderer
            // throw where a real one reports a state.
            isContextLost: () => lost,
            getParameter: () => webgl.renderer,
          };
        },
      };
      },
    },
  });

  return {
    get lostContexts() {
      return lostContexts;
    },
    restore,
  };
}

// ---------------------------------------------------------------------------
// Speech synthesis
// ---------------------------------------------------------------------------

export type SpokenUtterance = {
  text: string;
  voice: string | null;
  rate: number;
  pitch: number;
  volume: number;
};

export class FakeSpeechSynthesis {
  readonly spoken: SpokenUtterance[] = [];
  cancels = 0;
  voices: Array<{ name: string; lang: string; localService: boolean }> = [
    { name: 'Daniel', lang: 'en-GB', localService: true },
  ];
  private listeners: Array<() => void> = [];

  getVoices() {
    return this.voices;
  }

  addEventListener(_event: string, handler: () => void) {
    this.listeners.push(handler);
  }

  removeEventListener(_event: string, handler: () => void) {
    this.listeners = this.listeners.filter((listener) => listener !== handler);
  }

  /** How many listeners are still attached — a leak shows up here. */
  get listenerCount() {
    return this.listeners.length;
  }

  /** Voices arrive asynchronously in real browsers. */
  announceVoices(voices: FakeSpeechSynthesis['voices']) {
    this.voices = voices;
    // Snapshot: a listener may unsubscribe itself while being notified, which
    // is exactly what RoomSpeech does when it stops.
    const notifying = Array.from(this.listeners);
    for (const listener of notifying) listener();
  }

  speak(utterance: FakeUtterance) {
    this.spoken.push({
      text: utterance.text,
      voice: utterance.voice?.name ?? null,
      rate: utterance.rate,
      pitch: utterance.pitch,
      volume: utterance.volume,
    });
    utterance.fire('end');
  }

  cancel() {
    this.cancels += 1;
  }
}

export class FakeUtterance {
  voice: { name: string } | null = null;
  rate = 1;
  pitch = 1;
  volume = 1;
  private handlers = new Map<string, Array<() => void>>();

  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  addEventListener(event: string, handler: () => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  fire(event: string) {
    for (const handler of this.handlers.get(event) ?? []) handler();
  }
}

export function installSpeechGlobals(available = true) {
  const synthesis = new FakeSpeechSynthesis();
  const restore = overrideGlobals({
    window: available ? { speechSynthesis: synthesis } : {},
    speechSynthesis: available ? synthesis : undefined,
    SpeechSynthesisUtterance: FakeUtterance,
  });
  return { synthesis, restore };
}

// ---------------------------------------------------------------------------
// Audio elements and fetch
// ---------------------------------------------------------------------------

export class FakeAudioElement {
  static readonly created: FakeAudioElement[] = [];
  volume = 1;
  onended: (() => void) | null = null;
  paused = false;
  playCalls = 0;
  /** Set to reject, as an autoplay-blocked or missing file does. */
  static failPlay = false;

  readonly src: string;

  constructor(src: string) {
    this.src = src;
    FakeAudioElement.created.push(this);
  }

  play() {
    this.playCalls += 1;
    return FakeAudioElement.failPlay
      ? Promise.reject(new Error('blocked'))
      : Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  finish() {
    this.onended?.();
  }
}

export function installElementAudio() {
  const scope = globalThis as Record<string, unknown>;
  const previousAudio = scope.Audio;
  const previousWindow = scope.window;
  FakeAudioElement.created.length = 0;
  FakeAudioElement.failPlay = false;
  scope.Audio = FakeAudioElement;
  // elementVoicePlayer only checks that a window exists before using Audio.
  scope.window = { ...(previousWindow as object) };
  return {
    created: FakeAudioElement.created,
    set failPlay(value: boolean) {
      FakeAudioElement.failPlay = value;
    },
    restore() {
      if (previousAudio === undefined) delete scope.Audio;
      else scope.Audio = previousAudio;
      if (previousWindow === undefined) delete scope.window;
      else scope.window = previousWindow;
    },
  };
}

/** A fetch that serves fixed bodies, and 404s anything else. */
export function fakeFetch(files: Record<string, ArrayBuffer | string>) {
  const requested: string[] = [];
  const impl = (async (url: string) => {
    requested.push(url);
    const body = files[url];
    if (body === undefined) return { ok: false, status: 404 } as Response;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body).buffer : body),
      json: async () => JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, requested };
}
