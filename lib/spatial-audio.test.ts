import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOM_PAN_LIMIT, stereoPanFor } from './spatial-audio.ts';
import { RenderedVoice, type VoiceManifest, type VoicePlayer } from './rendered-speech.ts';
import { RoomSpeech } from './room-speech.ts';

const LINE = {
  id: 'return-1',
  text: 'you came back.',
  file: 'return-1.wav',
  durationMs: 1410,
};
const manifest: VoiceManifest = { voice: 'af_heart', sampleRate: 24000, lines: [LINE] };

function recordingPlayer() {
  const played: { url: string; volume: number; pan: number }[] = [];
  const player: VoicePlayer = {
    play(url, volume, pan) { played.push({ url, volume, pan }); },
    cancel() {},
  };
  return { player, played };
}

void test('the room speaks from the side its subject is standing on', () => {
  const { player, played } = recordingPlayer();
  const speech = new RoomSpeech(() => {}, null, new RenderedVoice(manifest, '/voice/', player));

  speech.say(LINE.text, 0.5, stereoPanFor(0.08));
  speech.say(LINE.text, 0.5, stereoPanFor(0.92));
  assert.ok(played[0].pan < -0.5, 'a line about someone at the left edge comes from the left');
  assert.ok(played[1].pan > 0.5, 'and one about someone at the right edge from the right');
});

void test('the centre of the room is the centre of the field', () => {
  assert.equal(stereoPanFor(0.5), 0);
});

void test('nothing is panned so hard it disappears for half the room', () => {
  // A fully panned source is silent in the other channel, and a memory that is
  // inaudible to the person it belongs to has failed at its only purpose.
  assert.equal(stereoPanFor(0), -ROOM_PAN_LIMIT);
  assert.equal(stereoPanFor(1), ROOM_PAN_LIMIT);
  assert.equal(stereoPanFor(-4), -ROOM_PAN_LIMIT, 'an out-of-room coordinate is clamped, not extrapolated');
  assert.equal(stereoPanFor(9), ROOM_PAN_LIMIT);
  assert.ok(ROOM_PAN_LIMIT < 1);
});

void test('a memory and a sentence about the same place come from the same place', () => {
  // The whole reason the mapping is shared. Two code paths placed sound in this
  // room and disagreed: a remembered whisper was panned, while the room's own
  // line went through an element that takes a volume and knows no position, so
  // the text pointed at a visitor and the voice came from the speakers.
  const { player, played } = recordingPlayer();
  const speech = new RoomSpeech(() => {}, null, new RenderedVoice(manifest, '/voice/', player));
  for (const x of [0, 0.17, 0.33, 0.5, 0.74, 1]) {
    speech.say(LINE.text, 1, stereoPanFor(x));
  }
  const whisperPans = [0, 0.17, 0.33, 0.5, 0.74, 1].map(stereoPanFor);
  assert.deepEqual(played.map((entry) => entry.pan), whisperPans);
});

void test('a nonsense coordinate is centred rather than propagated into the mix', () => {
  assert.equal(stereoPanFor(Number.NaN), 0);
  assert.equal(stereoPanFor(Number.POSITIVE_INFINITY), 0);
});

void test('an unplaced line is centred, which is what one microphone can honestly claim', () => {
  // Voice position is associated with the sole observed visitor, or centred.
  // The default must be the centre, never a stale side.
  const { player, played } = recordingPlayer();
  const speech = new RoomSpeech(() => {}, null, new RenderedVoice(manifest, '/voice/', player));
  speech.say(LINE.text, 0.5);
  assert.equal(played[0].pan, 0);
});
