import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseVoice,
  estimateSpeechMs,
  RoomSpeech,
  SPEECH_RATE,
  type SpeechHost,
  type SpeechRequest,
  type SpeechVoice,
} from './room-speech.ts';
import { VOICE_LINES, type VoiceKind } from './room-voice.ts';

const voice = (name: string, lang: string, localService: boolean): SpeechVoice => ({ name, lang, localService });

void test('the room never reaches for a network voice', () => {
  // The runtime boundary is offline. A server-synthesised voice would make the
  // installation quietly dependent on a connection it is not supposed to have.
  const remoteOnly = [voice('Google UK English Male', 'en-GB', false), voice('Cloud Voice', 'en-US', false)];
  assert.equal(chooseVoice(remoteOnly), null, 'silence is correct when no local voice exists');
});

void test('a local voice is preferred over a remote one of the same language', () => {
  const chosen = chooseVoice([
    voice('Google UK English Male', 'en-GB', false),
    voice('Daniel', 'en-GB', true),
  ]);
  assert.equal(chosen?.name, 'Daniel');
});

void test('an unhurried platform voice is preferred over the default', () => {
  const chosen = chooseVoice([
    voice('Albert', 'en-US', true),
    voice('Serena', 'en-GB', true),
    voice('Zarvox', 'en-US', true),
  ]);
  assert.equal(chosen?.name, 'Serena');
});

void test('the requested language wins, but any local voice beats silence', () => {
  const english = chooseVoice([voice('Amelie', 'fr-FR', true), voice('Alva', 'en-US', true)]);
  assert.equal(english?.name, 'Alva');
  const onlyFrench = chooseVoice([voice('Amelie', 'fr-FR', true)]);
  assert.equal(onlyFrench?.name, 'Amelie', 'a voice in the wrong language still beats none');
});

void test('the suppression estimate always over-runs the line it covers', () => {
  // Under-estimating means the room hears its own sentence and records it as a
  // visitor's whisper. Over-estimating costs one missed whisper.
  for (const kind of Object.keys(VOICE_LINES) as VoiceKind[]) {
    for (const line of VOICE_LINES[kind]) {
      const estimate = estimateSpeechMs(line, SPEECH_RATE);
      const words = line.trim().split(/\s+/).length;
      // Generous real-world upper bound: 500 ms a word at this rate.
      const plausibleMax = words * 500;
      assert.ok(estimate > plausibleMax * 0.9, `"${line}" estimated at only ${estimate}ms`);
      assert.ok(estimate < 12_000, `"${line}" would hold the microphone for ${estimate}ms`);
    }
  }
});

void test('the estimate grows with length and shrinks with rate', () => {
  assert.ok(estimateSpeechMs('you stopped.', 1) < estimateSpeechMs('you are walking their line.', 1));
  assert.ok(estimateSpeechMs('you stopped.', 0.5) > estimateSpeechMs('you stopped.', 1));
  assert.ok(estimateSpeechMs('', 1) > 0, 'even an empty line must hold the microphone briefly');
});

/** A stand-in platform that records what was asked of it. */
function fakeHost(voices: SpeechVoice[]) {
  const handlers = new Set<() => void>();
  const spoken: SpeechRequest[] = [];
  let cancels = 0;
  let current = voices;
  return {
    spoken,
    get listeners() { return handlers.size; },
    get cancels() { return cancels; },
    setVoices(next: SpeechVoice[]) {
      current = next;
      // Copied: a handler may unsubscribe itself while being notified.
      for (const handler of Array.from(handlers)) handler();
    },
    host: {
      getVoices: () => current,
      onVoicesChanged: (handler: () => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      speak: (request: SpeechRequest) => spoken.push(request),
      cancel: () => { cancels += 1; },
    } satisfies SpeechHost,
  };
}

const daniel: SpeechVoice = { name: 'Daniel', lang: 'en-GB', localService: true };

void test('stopping releases the platform listener', () => {
  // RoomSpeech is rebuilt every time the microphone reconnects, which happens
  // on a 2.5 s retry whenever a device drops. A listener left behind on each
  // rebuild is a slow leak in an installation meant to run unattended for days.
  const fake = fakeHost([daniel]);
  const speech = new RoomSpeech(() => {}, fake.host);
  assert.equal(fake.listeners, 1);
  speech.stop();
  assert.equal(fake.listeners, 0, 'the listener outlived the instance');
});

void test('repeated restarts leave nothing behind', () => {
  const fake = fakeHost([daniel]);
  for (let restart = 0; restart < 25; restart += 1) {
    const speech = new RoomSpeech(() => {}, fake.host);
    speech.stop();
  }
  assert.equal(fake.listeners, 0, 'listeners accumulated across restarts');
});

void test('a stopped instance stays silent even if something still holds it', () => {
  const fake = fakeHost([daniel]);
  const speech = new RoomSpeech(() => {}, fake.host);
  speech.stop();
  speech.say('you stopped.', 0.5);
  assert.equal(fake.spoken.length, 0);
  assert.equal(speech.ready, false);
});

void test('a stopped instance ignores a late voices-changed callback', () => {
  const fake = fakeHost([]);
  const speech = new RoomSpeech(() => {}, fake.host);
  speech.stop();
  fake.setVoices([daniel]);
  assert.equal(speech.ready, false);
});

void test('the microphone is closed before the line is spoken, and again after', () => {
  // Speech sits inside the whisper analysis band. If the room hears itself it
  // records its own sentence and replays it later as someone else's memory.
  const fake = fakeHost([daniel]);
  const suppressions: number[] = [];
  const speech = new RoomSpeech((ms) => suppressions.push(ms), fake.host);
  speech.say('you are walking their line.', 0.5);

  assert.equal(fake.spoken.length, 1);
  assert.equal(suppressions.length, 1, 'suppression must precede the utterance');
  assert.ok(suppressions[0] > 1_000);
  fake.spoken[0].onEnd();
  assert.equal(suppressions.length, 2, 'a tail of silence should follow');
});

void test('a voice arriving late is picked up', () => {
  // Platforms commonly report an empty voice list on first call.
  const fake = fakeHost([]);
  const speech = new RoomSpeech(() => {}, fake.host);
  assert.equal(speech.ready, false);
  fake.setVoices([daniel]);
  assert.equal(speech.ready, true);
  assert.equal(speech.voiceName, 'Daniel');
});

void test('with no platform at all the room simply does not speak', () => {
  const speech = new RoomSpeech(() => {}, null);
  speech.say('you stopped.', 1);
  speech.stop();
  assert.equal(speech.ready, false);
});

void test('a voices-changed event already in flight when the room stops cannot revive it', () => {
  // `removeEventListener` does not recall an event the platform has already
  // dispatched. RoomSpeech is rebuilt on every 2.5 s microphone retry, so a
  // notification landing on a retired instance is ordinary, not exotic — and a
  // retired instance that picks a voice is one that can still be asked to speak.
  let notify: (() => void) | null = null;
  let voices: SpeechVoice[] = [];
  const spoken: string[] = [];
  const host: SpeechHost = {
    getVoices: () => voices,
    onVoicesChanged: (handler) => { notify = handler; return () => { /* the event is already out */ }; },
    speak: (request: SpeechRequest) => { spoken.push(request.text); request.onEnd(); },
    cancel: () => {},
  };
  const speech = new RoomSpeech(() => {}, host);
  assert.equal(speech.ready, false, 'no voice has arrived yet');
  speech.stop();
  voices = [voice('Daniel', 'en-GB', true)];
  notify!();
  assert.equal(speech.ready, false, 'a stopped room stays stopped');
  speech.say('you stopped.', 1);
  assert.deepEqual(spoken, [], 'and says nothing');
  assert.equal(speech.voiceName, 'none', 'no voice was ever adopted');
});
