import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RenderedVoice,
  type VoiceManifest,
  elementVoicePlayer,
  webAudioVoicePlayer,
} from './rendered-speech.ts';
import { RoomSpeech, SPEECH_PITCH, SPEECH_RATE, browserSpeechHost } from './room-speech.ts';
import { stereoPanFor } from './spatial-audio.ts';
import {
  type PannerDouble,
  installAudioGlobals,
} from './test-doubles/web-audio.ts';
import {
  fakeFetch,
  installElementAudio,
  installSpeechGlobals,
} from './test-doubles/browser.ts';

/**
 * The two ways the room's voice actually reaches a speaker, and the platform
 * voice behind them both.
 *
 * These are the objects that made the room speak from the middle of the
 * speakers while its text sat beside a visitor. A test that only checked
 * `play` was called would have been green throughout, so these follow the
 * sound to the destination and ask what it passed through.
 */

const LINE = {
  id: 'return-1',
  text: 'you came back.',
  file: 'return-1.wav',
  durationMs: 1410,
};
const manifest: VoiceManifest = { voice: 'af_heart', sampleRate: 24_000, lines: [LINE] };

/** Let queued microtasks and the decode promise run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

void test('the Web Audio player places a line and lets it reach the speakers', async () => {
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  const fetcher = fakeFetch({ '/voice/return-1.wav': 'pretend-audio' });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetcher.impl;
  try {
    const context = new (globalThis as unknown as { AudioContext: new () => never }).AudioContext();
    const player = webAudioVoicePlayer(() => context as unknown as AudioContext)!;
    let ended = false;
    player.play('/voice/return-1.wav', 0.5, stereoPanFor(0.88), () => { ended = true; });
    await settle();

    const ctx = audio.context!;
    const source = ctx.sources.at(-1)!;
    assert.ok(source.started, 'a line that never starts is silence');
    assert.ok(source.reaches('panner'), 'the room must speak from somewhere, not from everywhere');
    assert.ok(source.reaches('destination'));
    const panner = ctx.nodesOfKind('panner').at(-1) as PannerDouble;
    assert.equal(panner.pan.value, stereoPanFor(0.88));
    assert.equal(fetcher.requested.length, 1);

    // The microphone reopens only when the line has finished.
    assert.equal(ended, false);
    source.finish();
    assert.equal(ended, true);
  } finally {
    globalThis.fetch = previousFetch;
    audio.restore();
  }
});

void test('a line is fetched once however often the room says it', async () => {
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  const fetcher = fakeFetch({ '/voice/return-1.wav': 'pretend-audio' });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetcher.impl;
  try {
    const context = new (globalThis as unknown as { AudioContext: new () => never }).AudioContext();
    const player = webAudioVoicePlayer(() => context as unknown as AudioContext)!;
    for (let say = 0; say < 4; say += 1) {
      player.play('/voice/return-1.wav', 0.5, 0, () => {});
      await settle();
    }
    assert.equal(fetcher.requested.length, 1, 'a gallery day would otherwise refetch all day');
  } finally {
    globalThis.fetch = previousFetch;
    audio.restore();
  }
});

void test('a missing file releases the microphone instead of holding it closed', async () => {
  const audio = installAudioGlobals();
  const fetcher = fakeFetch({});
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetcher.impl;
  try {
    const context = new (globalThis as unknown as { AudioContext: new () => never }).AudioContext();
    const player = webAudioVoicePlayer(() => context as unknown as AudioContext)!;
    let ended = false;
    player.play('/voice/absent.wav', 0.5, 0, () => { ended = true; });
    await settle();
    assert.equal(ended, true, 'a room that cannot speak must still be able to listen');
  } finally {
    globalThis.fetch = previousFetch;
    audio.restore();
  }
});

void test('a cancelled line never starts, even if it was still decoding', async () => {
  // stop() is called on every microphone retry. A line that starts after being
  // cancelled accumulates voices for as long as the installation runs.
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  const fetcher = fakeFetch({ '/voice/return-1.wav': 'pretend-audio' });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetcher.impl;
  try {
    const context = new (globalThis as unknown as { AudioContext: new () => never }).AudioContext();
    const player = webAudioVoicePlayer(() => context as unknown as AudioContext)!;
    player.play('/voice/return-1.wav', 0.5, 0, () => {});
    player.cancel();
    await settle();
    assert.equal(audio.context!.sources.length, 0, 'a cancelled line must stay silent');
  } finally {
    globalThis.fetch = previousFetch;
    audio.restore();
  }
});

void test('a newer line replaces one that is still decoding', async () => {
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  const fetcher = fakeFetch({ '/voice/a.wav': 'one', '/voice/b.wav': 'two' });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetcher.impl;
  try {
    const context = new (globalThis as unknown as { AudioContext: new () => never }).AudioContext();
    const player = webAudioVoicePlayer(() => context as unknown as AudioContext)!;
    player.play('/voice/a.wav', 0.5, -0.5, () => {});
    player.play('/voice/b.wav', 0.5, 0.5, () => {});
    await settle();
    assert.equal(audio.context!.sources.length, 1, 'the room must never talk over itself');
    const panner = audio.context!.nodesOfKind('panner').at(-1) as PannerDouble;
    assert.equal(panner.pan.value, 0.5, 'and the surviving line is the newer one');
  } finally {
    globalThis.fetch = previousFetch;
    audio.restore();
  }
});

void test('with no AudioContext the room still speaks, from no particular place', async () => {
  // Losing the microphone costs the room its placement, not its voice.
  const audio = installAudioGlobals();
  const elements = installElementAudio();
  try {
    const player = webAudioVoicePlayer(() => null, elementVoicePlayer())!;
    let ended = false;
    player.play('/voice/return-1.wav', 0.4, 0.7, () => { ended = true; });
    assert.equal(elements.created.length, 1, 'the fallback must actually play');
    assert.equal(elements.created[0].volume, 0.4);
    elements.created[0].finish();
    assert.equal(ended, true);
  } finally {
    elements.restore();
    audio.restore();
  }
});

void test('the element player replaces its last line rather than stacking them', () => {
  const elements = installElementAudio();
  try {
    const player = elementVoicePlayer()!;
    player.play('/voice/a.wav', 0.5, 0, () => {});
    player.play('/voice/b.wav', 0.5, 0, () => {});
    assert.equal(elements.created.length, 2);
    assert.equal(elements.created[0].paused, true, 'the first line must be stopped');
    player.cancel();
    assert.equal(elements.created[1].paused, true);
  } finally {
    elements.restore();
  }
});

void test('a blocked element playback still releases the microphone', async () => {
  const elements = installElementAudio();
  try {
    elements.failPlay = true;
    const player = elementVoicePlayer()!;
    let ended = false;
    player.play('/voice/a.wav', 0.5, 0, () => { ended = true; });
    await settle();
    assert.equal(ended, true);
  } finally {
    elements.restore();
  }
});

void test('a rendered line is spoken from its place, end to end through RoomSpeech', async () => {
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  const fetcher = fakeFetch({ '/voice/return-1.wav': 'pretend-audio' });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetcher.impl;
  try {
    const context = new (globalThis as unknown as { AudioContext: new () => never }).AudioContext();
    const player = webAudioVoicePlayer(() => context as unknown as AudioContext)!;
    const suppressions: number[] = [];
    const speech = new RoomSpeech(
      (ms) => suppressions.push(ms),
      null,
      new RenderedVoice(manifest, '/voice/', player),
    );
    speech.say(LINE.text, 0.6, stereoPanFor(0.12));
    await settle();

    const panner = audio.context!.nodesOfKind('panner').at(-1) as PannerDouble;
    assert.equal(panner.pan.value, stereoPanFor(0.12));
    assert.ok(suppressions[0] >= LINE.durationMs, 'the microphone closes for the real length');
  } finally {
    globalThis.fetch = previousFetch;
    audio.restore();
  }
});

// ---------------------------------------------------------------------------
// The platform voice behind the rendered one
// ---------------------------------------------------------------------------

void test('the platform host speaks with the settings the room asks for', () => {
  const speech = installSpeechGlobals();
  try {
    const host = browserSpeechHost()!;
    assert.ok(host, 'a browser with speech synthesis must expose a host');
    host.speak({
      text: 'you stopped.',
      voiceName: 'Daniel',
      rate: SPEECH_RATE,
      pitch: SPEECH_PITCH,
      volume: 0.5,
      onEnd: () => {},
    });
    const spoken = speech.synthesis.spoken.at(-1)!;
    assert.equal(spoken.text, 'you stopped.');
    assert.equal(spoken.voice, 'Daniel');
    assert.equal(spoken.rate, SPEECH_RATE);
    assert.equal(spoken.pitch, SPEECH_PITCH);
    // A queued backlog would have the room talking over itself minutes later.
    assert.ok(speech.synthesis.cancels >= 1, 'anything pending is cancelled first');
  } finally {
    speech.restore();
  }
});

void test('the voices-changed listener is released rather than accumulating', () => {
  // RoomSpeech is rebuilt every time the microphone reconnects, which it does
  // on a 2.5 s retry whenever a device drops. One dead listener and one
  // unreachable instance per reconnect is a slow leak across a gallery day.
  const speech = installSpeechGlobals();
  try {
    const host = browserSpeechHost()!;
    const unsubscribe = host.onVoicesChanged(() => {});
    assert.equal(speech.synthesis.listenerCount, 1);
    unsubscribe();
    assert.equal(speech.synthesis.listenerCount, 0);
  } finally {
    speech.restore();
  }
});

void test('a voice that arrives late is still picked up', () => {
  // Platform voices load asynchronously; the list is often empty on first ask.
  const speech = installSpeechGlobals();
  try {
    speech.synthesis.voices = [];
    const room = new RoomSpeech(() => {}, browserSpeechHost());
    assert.equal(room.ready, false, 'nothing to speak with yet');
    speech.synthesis.announceVoices([{ name: 'Daniel', lang: 'en-GB', localService: true }]);
    assert.equal(room.ready, true);
    assert.equal(room.voiceName, 'Daniel');
    room.stop();
  } finally {
    speech.restore();
  }
});

void test('a browser without speech synthesis leaves the room silent, not broken', () => {
  const speech = installSpeechGlobals(false);
  try {
    assert.equal(browserSpeechHost(), null);
    assert.equal(RoomSpeech.available(), false);
    const room = new RoomSpeech(() => {}, browserSpeechHost());
    assert.equal(room.ready, false);
    assert.equal(room.voiceName, 'none');
    // And saying something is a no-op rather than a throw inside the sensing loop.
    room.say('you came back.', 0.5);
    room.stop();
  } finally {
    speech.restore();
  }
});

void test('a stopped room stays stopped, even on a platform voice', () => {
  const speech = installSpeechGlobals();
  try {
    const room = new RoomSpeech(() => {}, browserSpeechHost());
    room.say('you came back.', 0.5);
    const said = speech.synthesis.spoken.length;
    room.stop();
    room.say('you came back.', 0.5);
    assert.equal(speech.synthesis.spoken.length, said, 'a stopped room must stay silent');
    assert.equal(speech.synthesis.listenerCount, 0, 'and must let go of the platform');
  } finally {
    speech.restore();
  }
});

void test('a replaced line is cancelled outright rather than left to finish', async () => {
  // The room must never be saying two things at once. Replacing a line detaches
  // its end handler and stops it, so the older line reports nothing and the
  // newer one is left alone to speak.
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  const fetcher = fakeFetch({ '/voice/a.wav': 'one', '/voice/b.wav': 'two' });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetcher.impl;
  try {
    const context = new (globalThis as unknown as { AudioContext: new () => never }).AudioContext();
    const player = webAudioVoicePlayer(() => context as unknown as AudioContext)!;
    let firstEnded = false;
    player.play('/voice/a.wav', 0.5, 0, () => { firstEnded = true; });
    await settle();
    const first = audio.context!.sources.at(-1)!;

    player.play('/voice/b.wav', 0.5, 0, () => {});
    await settle();
    const second = audio.context!.sources.at(-1)!;
    assert.notEqual(first, second);
    assert.ok(first.stopped, 'the older line is stopped, not left playing underneath');

    first.finish();
    assert.equal(firstEnded, false, 'a cancelled line does not report finishing');
    assert.equal(second.stopped, false, 'and the line now speaking is untouched');

    // The line that is actually playing still reports its own end, which is
    // what reopens the microphone.
    let secondEnded = false;
    second.onended = () => { secondEnded = true; };
    second.finish();
    assert.equal(secondEnded, true);
  } finally {
    globalThis.fetch = previousFetch;
    audio.restore();
  }
});

void test('cancelling a line that has already finished is harmless', async () => {
  // stop() runs on every microphone retry, whether or not anything is playing,
  // and a source that has ended throws when stopped again.
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  const fetcher = fakeFetch({ '/voice/a.wav': 'one' });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetcher.impl;
  try {
    const context = new (globalThis as unknown as { AudioContext: new () => never }).AudioContext();
    const player = webAudioVoicePlayer(() => context as unknown as AudioContext)!;
    player.play('/voice/a.wav', 0.5, 0, () => {});
    await settle();
    const source = audio.context!.sources.at(-1)!;
    source.stop();
    // Whatever state the source is in, cancelling must not throw into the retry.
    player.cancel();
    player.cancel();
  } finally {
    globalThis.fetch = previousFetch;
    audio.restore();
  }
});

void test('a suspended context is resumed before a line is played into it', async () => {
  // A suspended context accepts every sound and plays none of them, without
  // erroring, which is indistinguishable from a room that has nothing to say.
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  const fetcher = fakeFetch({ '/voice/a.wav': 'one' });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetcher.impl;
  try {
    const context = new (globalThis as unknown as { AudioContext: new () => never }).AudioContext();
    (context as unknown as { state: string }).state = 'suspended';
    const player = webAudioVoicePlayer(() => context as unknown as AudioContext)!;
    player.play('/voice/a.wav', 0.5, 0, () => {});
    await settle();
    assert.equal(audio.context!.state, 'running', 'the room must be audible when it speaks');
  } finally {
    globalThis.fetch = previousFetch;
    audio.restore();
  }
});

void test('with neither a context nor a fallback the line is skipped, not swallowed', () => {
  const audio = installAudioGlobals();
  try {
    const player = webAudioVoicePlayer(() => null)!;
    let ended = false;
    player.play('/voice/a.wav', 0.5, 0, () => { ended = true; });
    assert.equal(ended, false, 'nothing was scheduled, so nothing has ended yet');
    player.cancel();
  } finally {
    audio.restore();
  }
});

void test('cancelling a voice whose context has already closed does not throw', () => {
  // A real sequence: losing the microphone stops the audio engine, which closes
  // its context, and RoomSpeech.stop() then cancels the voice playing through
  // it. Browsers throw when a node of a closed context is stopped, and this
  // path is re-entered by the 2.5 s retry that is trying to bring the
  // microphone back — so a throw here would take the retry with it.
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  const fetcher = fakeFetch({ '/voice/a.wav': 'one' });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetcher.impl;
  try {
    const context = new (globalThis as unknown as { AudioContext: new () => never }).AudioContext();
    const player = webAudioVoicePlayer(() => context as unknown as AudioContext)!;
    player.play('/voice/a.wav', 0.5, 0, () => {});
    return settle().then(() => {
      const source = audio.context!.sources.at(-1)!;
      source.contextClosed = true;
      player.cancel();
      assert.ok(source.disconnected, 'the node is still released');
      globalThis.fetch = previousFetch;
      audio.restore();
    });
  } catch (error) {
    globalThis.fetch = previousFetch;
    audio.restore();
    throw error;
  }
});

void test('cancelling Web Audio also stops a line playing through its element fallback', () => {
  const audio = installAudioGlobals();
  const elements = installElementAudio();
  try {
    const player = webAudioVoicePlayer(() => null, elementVoicePlayer())!;
    player.play('/voice/a.wav', 0.5, 0, () => {});
    player.cancel();
    assert.equal(elements.created[0].paused, true);
  } finally { elements.restore(); audio.restore(); }
});

void test('a rejected older element play cannot cancel a newer line', async () => {
  const elements = installElementAudio();
  try {
    elements.failPlay = true;
    const player = elementVoicePlayer()!;
    let staleEnds = 0;
    player.play('/voice/a.wav', 0.5, 0, () => { staleEnds += 1; });
    elements.failPlay = false;
    player.play('/voice/b.wav', 0.5, 0, () => {});
    await settle();
    assert.equal(elements.created[1].paused, false);
    assert.equal(staleEnds, 0);
    player.cancel();
  } finally { elements.restore(); }
});

void test('losing the context supersedes a pending decode with fallback playback', async () => {
  const audio = installAudioGlobals();
  const elements = installElementAudio();
  const previousFetch = globalThis.fetch;
  const fetcher = fakeFetch({ '/voice/a.wav': 'one' });
  globalThis.fetch = fetcher.impl;
  try {
    let context: AudioContext | null = new (globalThis as unknown as { AudioContext: new () => AudioContext }).AudioContext();
    const player = webAudioVoicePlayer(() => context, elementVoicePlayer())!;
    player.play('/voice/a.wav', 0.5, 0, () => {});
    context = null;
    player.play('/voice/b.wav', 0.5, 0, () => {});
    await settle();
    assert.equal(audio.context!.sources.length, 0);
    assert.equal(elements.created.length, 1);
    assert.equal(elements.created[0].paused, false);
    player.cancel();
  } finally { globalThis.fetch = previousFetch; elements.restore(); audio.restore(); }
});

void test('a failed fetch uses fallback and a repeated pending request is fetched once', async () => {
  const audio = installAudioGlobals();
  const elements = installElementAudio();
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('offline'); };
  try {
    const context = new (globalThis as unknown as { AudioContext: new () => AudioContext }).AudioContext();
    const player = webAudioVoicePlayer(() => context, elementVoicePlayer())!;
    player.play('/voice/a.wav', 0.5, 0, () => {});
    player.play('/voice/a.wav', 0.5, 0, () => {});
    await settle();
    assert.equal(requests, 1);
    assert.equal(elements.created.length, 1);
    player.cancel();
    assert.equal(elements.created[0].paused, true);
  } finally { globalThis.fetch = previousFetch; elements.restore(); audio.restore(); }
});
