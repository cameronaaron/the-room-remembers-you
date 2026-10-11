/**
 * The room, out loud.
 *
 * Text on the wall is read by whoever is looking at the wall. A voice is heard
 * by whoever is in the room, including the person it is about, including from
 * behind. That is the whole reason to add it.
 *
 * Two constraints shape everything here:
 *
 *  1. **Speech sits inside the microphone's analysis band.** The room tone was
 *     deliberately kept below 150 Hz so it could never be mistaken for a
 *     whisper; a voice cannot be. So unlike the drone, speaking *must* extend
 *     the microphone suppression window, or the room hears itself, records its
 *     own sentence as a visitor's whisper, and replays it later as a memory of
 *     someone who was never there.
 *  2. **The runtime is offline.** Some platform voices are synthesised on a
 *     server. Only `localService` voices are used, and if none exist the room
 *     stays silent rather than reaching for the network.
 */

import type { RenderedVoice } from './rendered-speech.ts';
import { PLAYBACK_LEAD_MS } from './rendered-speech.ts';

export type SpeechVoice = {
  name: string;
  lang: string;
  localService: boolean;
};

/**
 * Voices that suit a room speaking quietly about what it noticed: unhurried,
 * low, not brightly conversational. Matched loosely by name, in order.
 */
const PREFERRED = ['daniel', 'serena', 'oliver', 'alva', 'fiona', 'karen', 'moira', 'tessa'];

/**
 * Pick a voice. Local-only, English if possible, preferring the calmer
 * platform voices over the default assistant-sounding one.
 */
export function chooseVoice(voices: readonly SpeechVoice[], language = 'en'): SpeechVoice | null {
  const local = voices.filter((voice) => voice.localService);
  if (!local.length) return null;
  const spoken = local.filter((voice) => voice.lang.toLowerCase().startsWith(language));
  const pool = spoken.length ? spoken : local;
  for (const wanted of PREFERRED) {
    const match = pool.find((voice) => voice.name.toLowerCase().includes(wanted));
    if (match) return match;
  }
  return pool[0];
}

/**
 * Generous upper bound on how long a line will take to say, used to hold the
 * microphone closed. Deliberately over-estimates: suppressing a moment too long
 * costs one missed whisper, while under-estimating means the room records
 * itself.
 */
export function estimateSpeechMs(text: string, rate: number): number {
  const words = Math.max(1, text.trim().split(/\s+/).length);
  const perWord = 420 / Math.max(0.3, rate);
  return Math.round(words * perWord + 900);
}

export const SPEECH_RATE = 0.82;
export const SPEECH_PITCH = 0.85;

/** Extra silence held after a line finishes, for room reverberation. */
export const SPEECH_TAIL_MS = 600;

export type SpeechRequest = {
  text: string;
  voiceName: string;
  rate: number;
  pitch: number;
  volume: number;
  onEnd: () => void;
};

/**
 * The speech platform, behind an interface.
 *
 * `onVoicesChanged` returns its own unsubscribe rather than taking a
 * remove-listener call later. The previous version added a `voiceschanged`
 * listener and never removed it, and because `RoomSpeech` is rebuilt every time
 * the microphone reconnects — which it does on a 2.5 s retry whenever a device
 * drops — an unattended gallery run accumulated one dead listener and one
 * unreachable instance per reconnect. Handing back the unsubscribe makes
 * forgetting it a type error rather than a slow leak.
 */
export type SpeechHost = {
  getVoices(): SpeechVoice[];
  onVoicesChanged(handler: () => void): () => void;
  speak(request: SpeechRequest): void;
  cancel(): void;
};

/** The real platform, or null where speech synthesis is unavailable. */
export function browserSpeechHost(): SpeechHost | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const synthesis = window.speechSynthesis;
  return {
    getVoices: () => synthesis.getVoices().map((voice) => ({
      name: voice.name,
      lang: voice.lang,
      localService: voice.localService,
    })),
    onVoicesChanged: (handler) => {
      synthesis.addEventListener('voiceschanged', handler);
      return () => synthesis.removeEventListener('voiceschanged', handler);
    },
    speak: (request) => {
      const utterance = new SpeechSynthesisUtterance(request.text);
      const match = synthesis.getVoices().find((voice) => voice.name === request.voiceName);
      if (match) utterance.voice = match;
      utterance.rate = request.rate;
      utterance.pitch = request.pitch;
      utterance.volume = request.volume;
      utterance.addEventListener('end', request.onEnd);
      // A queued backlog would have the room talking over itself minutes later.
      synthesis.cancel();
      synthesis.speak(utterance);
    },
    cancel: () => synthesis.cancel(),
  };
}

export class RoomSpeech {
  static available(): boolean {
    return browserSpeechHost() !== null;
  }

  private readonly host: SpeechHost | null;
  private readonly suppress: (ms: number) => void;
  private unsubscribe: (() => void) | null = null;
  private voice: SpeechVoice | null = null;
  private readonly rendered: RenderedVoice | null;
  private stopped = false;

  /** `suppress` closes the microphone for the given duration. */
  constructor(
    suppress: (ms: number) => void,
    host: SpeechHost | null = browserSpeechHost(),
    rendered: RenderedVoice | null = null,
  ) {
    this.suppress = suppress;
    this.host = host;
    this.rendered = rendered;
    if (!host) return;
    const load = () => {
      if (this.stopped) return;
      this.voice = chooseVoice(host.getVoices());
    };
    load();
    this.unsubscribe = host.onVoicesChanged(load);
  }

  /** Whether a usable offline voice was found. */
  get ready(): boolean {
    if (this.stopped) return false;
    return this.rendered !== null || this.voice !== null;
  }

  get voiceName(): string {
    return this.rendered?.voiceName ?? this.voice?.name ?? 'none';
  }

  /**
   * Say one line, from where its subject is standing.
   *
   * Suppresses the microphone before speaking rather than on the utterance's
   * own start event, which can arrive after audio has begun.
   *
   * `pan` is a stereo position from `stereoPanFor`, shared with remembered
   * whispers. The platform-voice fallback cannot take one: `speechSynthesis`
   * offers volume, rate and pitch and no position at all, which is one more
   * reason the rendered files are the real voice and the platform one is only
   * a way of still saying something.
   */
  say(text: string, volume: number, pan = 0) {
    if (this.stopped) return;
    // A rendered line's length is known, so the microphone closes for exactly
    // as long as the room speaks instead of for a deliberate over-estimate.
    const exact = this.rendered?.durationMs(text) ?? null;
    if (exact !== null) {
      this.suppress(exact + PLAYBACK_LEAD_MS);
      const spoken = this.rendered!.speak(
        text,
        Math.max(0, Math.min(1, volume)),
        pan,
        () => this.suppress(SPEECH_TAIL_MS),
      );
      if (spoken) return;
    }
    if (!this.host || !this.voice) return;
    this.suppress(estimateSpeechMs(text, SPEECH_RATE));
    this.host.speak({
      text,
      voiceName: this.voice.name,
      rate: SPEECH_RATE,
      pitch: SPEECH_PITCH,
      volume: Math.max(0, Math.min(1, volume)),
      onEnd: () => this.suppress(SPEECH_TAIL_MS),
    });
  }

  /** Silence the room and release the platform listener. Not reusable after. */
  stop() {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.host?.cancel();
    // Rendered audio outlives speechSynthesis.cancel(), and this path is
    // re-entered on every microphone retry.
    this.rendered?.cancel();
  }
}
