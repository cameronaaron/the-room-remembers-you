import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLAYBACK_LEAD_MS,
  RenderedVoice,
  type VoiceManifest,
  type VoicePlayer,
  loadVoiceManifest,
  parseManifest,
  resetVoiceManifest,
} from './rendered-speech.ts';
import { RoomSpeech, SPEECH_TAIL_MS, estimateSpeechMs, SPEECH_RATE } from './room-speech.ts';
import type { SpeechHost } from './room-speech.ts';

const LINE = { id: 'forgetting-0', text: 'i am no longer certain this happened.', file: 'forgetting-0.wav', durationMs: 2509 };
const manifest: VoiceManifest = { voice: 'bm_george', sampleRate: 24000, lines: [LINE] };

function recordingPlayer() {
  const played: { url: string; volume: number; pan: number }[] = [];
  let cancels = 0;
  let finish: (() => void) | null = null;
  const player: VoicePlayer = {
    play(url, volume, pan, onEnd) { played.push({ url, volume, pan }); finish = onEnd; },
    cancel() { cancels += 1; },
  };
  return { player, played, end: () => finish?.(), get cancels() { return cancels; } };
}

function fakeHost() {
  const spoken: string[] = [];
  const host: SpeechHost = {
    getVoices: () => [{ name: 'Daniel', lang: 'en-GB', localService: true }],
    onVoicesChanged: () => () => {},
    speak: (request) => { spoken.push(request.text); },
    cancel: () => {},
  };
  return { host, spoken };
}

void test('a rendered line closes the microphone for its real length, not a guess', () => {
  const { player, played, end } = recordingPlayer();
  const suppressions: number[] = [];
  const { host, spoken } = fakeHost();
  const speech = new RoomSpeech((ms) => suppressions.push(ms), host, new RenderedVoice(manifest, '/voice/', player));

  speech.say(LINE.text, 0.5);
  assert.deepEqual(played, [{ url: '/voice/forgetting-0.wav', volume: 0.5, pan: 0 }]);
  assert.equal(spoken.length, 0, 'the platform voice must not also say the line');
  assert.deepEqual(suppressions, [LINE.durationMs + PLAYBACK_LEAD_MS]);
  // The guess this replaces was far longer, and that surplus is time the room
  // cannot hear anything said to it.
  assert.ok(estimateSpeechMs(LINE.text, SPEECH_RATE) > LINE.durationMs + PLAYBACK_LEAD_MS + 1000);
  end();
  assert.deepEqual(suppressions, [LINE.durationMs + PLAYBACK_LEAD_MS, SPEECH_TAIL_MS]);
});

void test('an unrendered line still gets spoken by the platform voice', () => {
  const { player, played } = recordingPlayer();
  const { host, spoken } = fakeHost();
  const suppressions: number[] = [];
  const speech = new RoomSpeech((ms) => suppressions.push(ms), host, new RenderedVoice(manifest, '/voice/', player));

  speech.say('a line nobody rendered yet.', 0.5);
  assert.equal(played.length, 0);
  assert.deepEqual(spoken, ['a line nobody rendered yet.']);
  assert.deepEqual(suppressions, [estimateSpeechMs('a line nobody rendered yet.', SPEECH_RATE)]);
});

void test('silencing the room stops rendered audio, which outlives speechSynthesis', () => {
  const recorder = recordingPlayer();
  const { host } = fakeHost();
  const speech = new RoomSpeech(() => {}, host, new RenderedVoice(manifest, '/voice/', recorder.player));
  speech.say(LINE.text, 0.5);
  speech.stop();
  assert.equal(recorder.cancels, 1);
  speech.say(LINE.text, 0.5);
  assert.equal(recorder.played.length, 1, 'a stopped room must stay silent');
});

void test('a rendered voice is reported and usable without any platform voice', () => {
  const { player } = recordingPlayer();
  const speech = new RoomSpeech(() => {}, null, new RenderedVoice(manifest, '/voice/', player));
  assert.equal(speech.ready, true, 'rendered audio needs no platform voice');
  assert.equal(speech.voiceName, 'bm_george');
});

void test('a malformed manifest is refused rather than half-trusted', () => {
  assert.equal(parseManifest(null), null);
  assert.equal(parseManifest({ voice: 'x', lines: [] }), null);
  for (const broken of [
    { ...LINE, durationMs: 0 },
    { ...LINE, durationMs: -1 },
    { ...LINE, durationMs: Number.NaN },
    { ...LINE, file: '' },
    { ...LINE, text: '' },
  ]) assert.equal(parseManifest({ voice: 'x', sampleRate: 24000, lines: [broken] }), null, JSON.stringify(broken));
  assert.deepEqual(parseManifest(manifest as unknown), manifest);
});

void test('the manifest is fetched once however often the microphone reconnects', async () => {
  resetVoiceManifest();
  let requests = 0;
  const fetchImpl = (async () => {
    requests += 1;
    return { ok: true, json: async () => manifest } as Response;
  }) as unknown as typeof fetch;
  const results = await Promise.all([1, 2, 3].map(() => loadVoiceManifest(fetchImpl, '/voice/manifest.json')));
  assert.equal(requests, 1);
  for (const result of results) assert.deepEqual(result, manifest);
  resetVoiceManifest();
});

void test('a missing manifest leaves the room on its platform voice', async () => {
  resetVoiceManifest();
  const failing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  assert.equal(await loadVoiceManifest(failing, '/voice/manifest.json'), null);
  resetVoiceManifest();
});

void test('manifest validation rejects each malformed field independently', () => {
  for (const value of [undefined, 1, 'manifest', {}, { voice: 1, lines: [LINE] }, { voice: 'x', lines: {} }]) {
    assert.equal(parseManifest(value), null);
  }
  for (const line of [null, 1, { ...LINE, id: 1 }, { ...LINE, text: 1 }, { ...LINE, file: 1 }, { ...LINE, durationMs: '100' }, { ...LINE, durationMs: Infinity }]) {
    assert.equal(parseManifest({ voice: 'x', lines: [line] }), null);
  }
  assert.deepEqual(parseManifest({ voice: 'x', lines: [LINE] }), { voice: 'x', sampleRate: 0, lines: [LINE] });
});

void test('rendered playback normalizes its base path and clamps volume', () => {
  const recorder = recordingPlayer();
  const voice = new RenderedVoice(manifest, '/voice', recorder.player);
  assert.equal(voice.speak('unknown', 1, 0, () => {}), false);
  for (const volume of [-1, 2]) assert.equal(voice.speak(LINE.text, volume, 0.3, () => {}), true);
  assert.deepEqual(recorder.played, [
    { url: '/voice/forgetting-0.wav', volume: 0, pan: 0.3 },
    { url: '/voice/forgetting-0.wav', volume: 1, pan: 0.3 },
  ]);
});

void test('an HTTP failure does not try to parse a manifest body', async () => {
  resetVoiceManifest();
  try {
    const fetchImpl = (async () => ({ ok: false, json: () => { throw new Error('body must not be read'); } })) as unknown as typeof fetch;
    assert.equal(await loadVoiceManifest(fetchImpl), null);
  } finally {
    resetVoiceManifest();
  }
});
