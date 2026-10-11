/**
 * The room's voice, pre-rendered.
 *
 * Every line the room can say is known ahead of time, so all of them are
 * synthesised offline by scripts/render-voice.ts and committed as audio. Three
 * things follow from that, in order of how much they matter:
 *
 *  1. **The runtime stays offline.** room-speech.ts refuses non-local platform
 *     voices rather than reaching for the network; playing a finished file
 *     honours that rule instead of working around it.
 *  2. **The microphone closes for exactly as long as the room speaks.**
 *     `estimateSpeechMs` must over-estimate, because under-estimating means the
 *     room records its own sentence and replays it later as a visitor who was
 *     never there. Measured against the rendered files it overshoots by 1587 ms
 *     per line on average and 2760 ms at worst — time the room spends deaf. A
 *     rendered line's length is known, so the guess is not needed.
 *  3. Synthesis latency leaves moments that are timed to the frame.
 *
 * A line with no rendered file falls back to the platform voice, so adding one
 * to VOICE_LINES without re-rendering leaves the room able to say it.
 */

export type RenderedLine = {
  id: string;
  text: string;
  file: string;
  durationMs: number;
};

export type VoiceManifest = {
  voice: string;
  sampleRate: number;
  lines: readonly RenderedLine[];
};

/**
 * Plays one finished file at a time, at a place in the room.
 *
 * `pan` is a stereo position from `stereoPanFor`, not a room coordinate: the
 * mapping is shared with remembered whispers so a memory and a sentence about
 * the same spot cannot drift apart.
 */
export type VoicePlayer = {
  play(url: string, volume: number, pan: number, onEnd: () => void): void;
  cancel(): void;
};

/**
 * Audio begins a moment after playback is asked for. The microphone is closed
 * for the line's exact length plus this, rather than for a guess; it stays far
 * below the 1587 ms the estimate was overshooting by.
 */
export const PLAYBACK_LEAD_MS = 250;

function isRenderedLine(value: unknown): value is RenderedLine {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Partial<RenderedLine>;
  return typeof line.id === 'string'
    && typeof line.text === 'string' && line.text.length > 0
    && typeof line.file === 'string' && line.file.length > 0
    // A zero or negative duration would close the microphone for no time at
    // all, which is the failure this module exists to prevent.
    && typeof line.durationMs === 'number' && Number.isFinite(line.durationMs) && line.durationMs > 0;
}

/** Reject a malformed manifest rather than half-trusting it. */
export function parseManifest(value: unknown): VoiceManifest | null {
  if (typeof value !== 'object' || value === null) return null;
  const manifest = value as Partial<VoiceManifest>;
  if (typeof manifest.voice !== 'string' || !Array.isArray(manifest.lines)) return null;
  if (!manifest.lines.length || !manifest.lines.every(isRenderedLine)) return null;
  const sampleRate = typeof manifest.sampleRate === 'number' ? manifest.sampleRate : 0;
  return { voice: manifest.voice, sampleRate, lines: manifest.lines };
}

export class RenderedVoice {
  private readonly byText: Map<string, RenderedLine>;
  private readonly baseUrl: string;
  private readonly player: VoicePlayer;
  readonly voiceName: string;

  constructor(manifest: VoiceManifest, baseUrl: string, player: VoicePlayer) {
    this.byText = new Map(manifest.lines.map((line) => [line.text, line]));
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.player = player;
    this.voiceName = manifest.voice;
  }

  /** Exact playback length, or null when this line was never rendered. */
  durationMs(text: string): number | null {
    return this.byText.get(text)?.durationMs ?? null;
  }

  /** False when the line is unrendered and the caller must fall back. */
  speak(text: string, volume: number, pan: number, onEnd: () => void): boolean {
    const line = this.byText.get(text);
    if (!line) return false;
    this.player.play(
      `${this.baseUrl}${line.file}`,
      Math.max(0, Math.min(1, volume)),
      pan,
      onEnd,
    );
    return true;
  }

  cancel() {
    this.player.cancel();
  }
}

/**
 * The fallback player: one element, reused, so a line always replaces the last.
 *
 * An HTMLAudioElement takes a volume and knows nothing about position, so this
 * cannot place a line in the room — the room speaks from wherever the speakers
 * are. Kept for the case where there is no AudioContext to play through, which
 * is a room that can still speak rather than a room that cannot.
 */
export function elementVoicePlayer(): VoicePlayer | null {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return null;
  let current: HTMLAudioElement | null = null;
  const release = () => {
    if (!current) return;
    current.onended = null;
    current.pause();
    current = null;
  };
  return {
    play(url, volume, _pan, onEnd) {
      release();
      const element = new Audio(url);
      element.volume = volume;
      element.onended = () => { release(); onEnd(); };
      current = element;
      // A blocked or missing file must not leave the microphone closed.
      void element.play().catch(() => {
        if (current !== element) return;
        release();
        onEnd();
      });
    },
    cancel: release,
  };
}

/**
 * The real player: the room's voice through Web Audio, placed in the room.
 *
 * The context is fetched at play time rather than held, because it belongs to
 * the AudioMemoryEngine and does not exist until the microphone has started —
 * while RoomSpeech is built before that and rebuilt on every microphone retry.
 * Routing through that same context is also what puts the spoken line and a
 * remembered whisper in one mix, at one sample rate, under one master volume.
 *
 * Falls back when there is no context to play through, so losing the microphone
 * costs the room its placement, not its voice.
 */
export function webAudioVoicePlayer(
  getContext: () => AudioContext | null,
  fallback: VoicePlayer | null = null,
): VoicePlayer | null {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return null;
  // Decoded once each. The vocabulary is 34 lines and 47.9 s of audio, so this
  // is bounded by the work itself rather than by anything a visitor does.
  const decoded = new Map<string, AudioBuffer>();
  const decoding = new Map<string, Promise<AudioBuffer | null>>();
  let current: AudioBufferSourceNode | null = null;
  let generation = 0;

  const release = () => {
    if (!current) return;
    current.onended = null;
    try {
      current.stop();
    } catch {
      // Already finished; there is nothing to unwind.
    }
    current.disconnect();
    current = null;
  };

  const load = (context: AudioContext, url: string) => {
    const cached = decoded.get(url);
    if (cached) return Promise.resolve(cached);
    let pending = decoding.get(url);
    if (!pending) {
      pending = fetch(url)
        .then((response) => (response.ok ? response.arrayBuffer() : null))
        .then((bytes) => (bytes ? context.decodeAudioData(bytes) : null))
        .then((buffer) => {
          if (buffer) decoded.set(url, buffer);
          return buffer;
        })
        .catch(() => null)
        .finally(() => decoding.delete(url));
      decoding.set(url, pending);
    }
    return pending;
  };

  return {
    play(url, volume, pan, onEnd) {
      release();
      fallback?.cancel();
      const mine = ++generation;
      const context = getContext();
      if (!context) {
        fallback?.play(url, volume, pan, onEnd);
        return;
      }
      void load(context, url).then((buffer) => {
        // A cancel, or a newer line, arrived while this was being decoded.
        if (mine !== generation) return;
        if (!buffer) {
          // A missing or undecodable file must not leave the microphone closed.
          if (fallback) fallback.play(url, volume, pan, onEnd);
          else onEnd();
          return;
        }
        if (context.state === 'suspended') void context.resume();
        const source = context.createBufferSource();
        const gain = context.createGain();
        const panner = context.createStereoPanner();
        source.buffer = buffer;
        gain.gain.value = Math.max(0, Math.min(1, volume));
        panner.pan.value = pan;
        source.connect(gain).connect(panner).connect(context.destination);
        // `release` detaches this handler before it clears `current`, so a
        // source can only reach here while it is still the current one. The
        // branch that handled the other case could not run, and an unreachable
        // fallback is a claim about safety with nothing behind it.
        source.onended = () => {
          release();
          onEnd();
        };
        current = source;
        source.start();
      });
    },
    cancel() {
      // Bump the generation so a line still decoding cannot start afterwards.
      generation += 1;
      release();
      fallback?.cancel();
    },
  };
}

/**
 * Load the manifest once per page. The microphone path that builds RoomSpeech
 * is re-entered on a 2.5 s retry whenever a device drops, so fetching per
 * construction would re-request this all day.
 */
let pending: Promise<VoiceManifest | null> | null = null;

export function loadVoiceManifest(
  fetchImpl: typeof fetch = fetch,
  url = '/voice/manifest.json',
): Promise<VoiceManifest | null> {
  pending ??= fetchImpl(url)
    .then((response) => (response.ok ? response.json() : null))
    .then(parseManifest)
    .catch(() => null);
  return pending;
}

/** Only for tests: forget the cached manifest. */
export function resetVoiceManifest() {
  pending = null;
}
