import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANALYSIS_BAND,
  effectiveWhisperThreshold,
  interpolateEnvelope,
  PERSONALITY_TONE,
  TONE_BAND,
  whisperBand,
  whisperReplayGain,
} from './audio-memory.ts';
import type { RoomPersonality } from './room-types.ts';

const ALL_PERSONALITIES: RoomPersonality[] = [
  'dormant',
  'curious',
  'attentive',
  'crowded',
  'overwhelmed',
  'lonely',
  'remembering',
  'forgetting',
];

void test('the room tone cannot reach the whisper detector', () => {
  // The speakers run continuously. If these bands overlapped, the installation
  // would hear its own drone as a permanent raised noise floor and would either
  // mask real whispers or invent them.
  assert.ok(
    TONE_BAND.maxHz < ANALYSIS_BAND.minHz,
    `room tone reaches ${TONE_BAND.maxHz} Hz but analysis starts at ${ANALYSIS_BAND.minHz} Hz`,
  );
  // Keep real headroom for the filters' skirts, not just a nominal gap.
  assert.ok(ANALYSIS_BAND.minHz / TONE_BAND.maxHz >= 1.2);
});

void test('the analysis band still covers speech', () => {
  assert.ok(ANALYSIS_BAND.minHz <= 200);
  assert.ok(ANALYSIS_BAND.maxHz >= 4000);
  assert.ok(ANALYSIS_BAND.minHz < ANALYSIS_BAND.maxHz);
});

void test('every room personality has an audible body', () => {
  for (const personality of ALL_PERSONALITIES) {
    assert.ok(personality in PERSONALITY_TONE, `${personality} is never heard`);
  }
  assert.equal(Object.keys(PERSONALITY_TONE).length, ALL_PERSONALITIES.length);
});

void test('no two personalities sound the same', () => {
  const seen = new Map<string, RoomPersonality>();
  for (const personality of ALL_PERSONALITIES) {
    const tone = PERSONALITY_TONE[personality];
    const signature = [tone.gain, tone.detuneCents, tone.cutoffHz, tone.beatHz].join('/');
    const clash = seen.get(signature);
    assert.equal(clash, undefined, `${personality} is indistinguishable from ${clash}`);
    seen.set(signature, personality);
  }
});

void test('the room tone stays inside its own band and below a safe level', () => {
  for (const personality of ALL_PERSONALITIES) {
    const tone = PERSONALITY_TONE[personality];
    assert.ok(
      tone.cutoffHz <= TONE_BAND.maxHz,
      `${personality} opens the tone filter to ${tone.cutoffHz} Hz, outside the tone band`,
    );
    assert.ok(tone.cutoffHz >= TONE_BAND.minHz);
    assert.ok(tone.gain > 0 && tone.gain <= 1);
    assert.ok(tone.beatHz > 0 && tone.beatHz < 1);
  }
});

void test('a crowded room is louder and rougher than a dormant one', () => {
  assert.ok(PERSONALITY_TONE.overwhelmed.gain > PERSONALITY_TONE.crowded.gain);
  assert.ok(PERSONALITY_TONE.crowded.gain > PERSONALITY_TONE.attentive.gain);
  assert.ok(PERSONALITY_TONE.attentive.gain > PERSONALITY_TONE.dormant.gain);
  assert.ok(PERSONALITY_TONE.overwhelmed.detuneCents > PERSONALITY_TONE.remembering.detuneCents);
  assert.ok(PERSONALITY_TONE.forgetting.gain < PERSONALITY_TONE.lonely.gain);
});

void test('a replayed whisper is actually audible', () => {
  // It was not. The sample buffer was pre-scaled to 0.12 and then passed
  // through a gain of 0.1, so a recalled whisper arrived at roughly -44 dBFS:
  // audible only in silence with an ear at the speaker, and nothing at all on
  // a television. Nobody heard one for the entire life of the feature.
  const atDefault = whisperReplayGain(0.32);
  const dbfs = 20 * Math.log10(atDefault);
  assert.ok(dbfs > -24, `replay peaks at ${dbfs.toFixed(1)} dBFS, which is inaudible in a room`);
  assert.ok(dbfs < -6, `replay peaks at ${dbfs.toFixed(1)} dBFS, which is too loud for a whisper`);
});

void test('replay level tracks the master volume and stays bounded', () => {
  assert.equal(whisperReplayGain(0), 0, 'muted means silent');
  assert.ok(whisperReplayGain(0.5) > whisperReplayGain(0.2));
  assert.ok(whisperReplayGain(10) <= 0.45, 'a mis-set volume must not clip the output');
  assert.ok(whisperReplayGain(-1) >= 0);
});

void test('the whisper band admits ordinary speech, not just breath', () => {
  // The upper bound was a flat 0.22, which someone speaking normally close to a
  // laptop microphone clears easily. The loudest, most deliberate attempts to
  // make the room hear something were the ones it discarded.
  const band = whisperBand(0.035);
  assert.equal(band.min, 0.035);
  assert.ok(band.max > 0.22, `an upper bound of ${band.max} still rejects normal speech`);
  assert.ok(band.max < 0.8, 'a shout should still be out of band');
});

void test('the whisper band scales with the threshold an operator sets', () => {
  assert.ok(whisperBand(0.08).max > whisperBand(0.02).max);
  for (const threshold of [0.005, 0.035, 0.09, 0.2]) {
    const band = whisperBand(threshold);
    assert.ok(band.max > band.min, `band collapsed at threshold ${threshold}`);
  }
});

void test('the whisper threshold answers to the room, not to a constant', () => {
  // From a real session: floor 0.0001, speech peaking at 0.042, threshold
  // pinned at 0.035 — 84% of the loudest moment. Two samples in 307 crossed it
  // and 161 seconds of talking produced one whisper.
  const quietRoom = effectiveWhisperThreshold(0.004, 0.0001);
  assert.ok(quietRoom < 0.006, `a quiet room still demanded ${quietRoom}`);
  assert.ok(quietRoom > 0.0001 * 4, 'but must stay clear of the floor itself');

  // Ordinary speech in that room must land inside the band.
  const band = whisperBand(quietRoom);
  for (const level of [0.006, 0.012, 0.025, 0.042]) {
    assert.ok(level > band.min && level < band.max, `speech at ${level} was excluded`);
  }
});

void test('a noisy room raises its own threshold', () => {
  // Otherwise a gallery with air handling would record its own ventilation.
  const noisy = effectiveWhisperThreshold(0.004, 0.01);
  assert.ok(noisy > 0.05, `a noisy room only demanded ${noisy}`);
  assert.ok(noisy > effectiveWhisperThreshold(0.004, 0.0001));
});

void test('the configured value is a floor the room cannot undercut', () => {
  assert.equal(effectiveWhisperThreshold(0.02, 0), 0.02);
  assert.ok(effectiveWhisperThreshold(0.02, 0.000001) >= 0.02);
});

void test('the envelope is read smoothly, not in steps', () => {
  // At most 32 points stretched over seconds: nearest-neighbour indexing
  // stepped the amplitude audibly and added a granular edge to the noise.
  const envelope = [0, 1, 0];
  assert.equal(interpolateEnvelope(envelope, 0), 0);
  assert.equal(interpolateEnvelope(envelope, 0.5), 1);
  assert.equal(interpolateEnvelope(envelope, 1), 0);
  assert.ok(Math.abs(interpolateEnvelope(envelope, 0.25) - 0.5) < 1e-9, 'midpoints interpolate');

  // No jumps anywhere along the read.
  let previous = interpolateEnvelope(envelope, 0);
  for (let step = 1; step <= 200; step += 1) {
    const next = interpolateEnvelope(envelope, step / 200);
    assert.ok(Math.abs(next - previous) < 0.05, `stepped at ${step / 200}`);
    previous = next;
  }
});

void test('reading an envelope is safe at every input', () => {
  assert.equal(interpolateEnvelope([], 0.5), 0);
  assert.equal(interpolateEnvelope([0.7], 0.5), 0.7);
  assert.equal(interpolateEnvelope([0, 1], -5), 0);
  assert.equal(interpolateEnvelope([0, 1], 5), 1);
});
