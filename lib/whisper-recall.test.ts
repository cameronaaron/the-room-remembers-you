import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseWhisperRecall,
  WHISPER_RIPENS_MS,
  whisperRecallRate,
} from './whisper-recall.ts';

const NOW = 10_000_000;
const whisper = (id: string, ageMs: number) => ({ id, createdAt: NOW - ageMs });
const ripe = whisper('ripe', WHISPER_RIPENS_MS + 1_000);
const always = () => 0;
const never = () => 0.999_999;
const everything = () => true;

const recall = (overrides: Partial<Parameters<typeof chooseWhisperRecall>[0]> = {}) =>
  chooseWhisperRecall({
    held: [ripe],
    sinceLastRollSeconds: 0.042,
    frequency: 0.4,
    hasRecording: everything,
    now: NOW,
    random: always,
    ...overrides,
  });

void test('a ripe whisper with audio behind it is the one that comes back', () => {
  const result = recall();
  assert.equal(result.because, null);
  assert.equal(result.whisper?.id, 'ripe');
});

void test('a frequency of zero is off, and says so rather than reading as bad luck', () => {
  // The defect this file exists for. The console slider bottoms out at zero,
  // the audition button ignores the rate and keeps playing, so the room holds
  // whispers that can be played on demand and never surface by themselves.
  // 'not this time' would be true here and useless: it is true of every tick,
  // forever, and sends an operator looking at the microphone instead.
  const result = recall({ frequency: 0, random: always });
  assert.equal(result.whisper, null);
  assert.equal(result.because, 'frequency is zero');
});

void test('no roll, however long the wait, can undo a frequency of zero', () => {
  for (const sinceLastRollSeconds of [0.042, 1, 60, 3_600]) {
    assert.equal(recall({ frequency: 0, sinceLastRollSeconds, random: always }).because, 'frequency is zero');
  }
});

void test('an empty room is distinguished from a silent one', () => {
  assert.equal(recall({ held: [] }).because, 'nothing held');
});

void test('a whisper too young to be a memory is not recalled', () => {
  const young = recall({ held: [whisper('young', WHISPER_RIPENS_MS - 1_000)] });
  assert.equal(young.whisper, null);
  assert.equal(young.because, 'nothing ripe yet');
  // And the boundary itself is not ripe: strictly older than the window.
  assert.equal(recall({ held: [whisper('exact', WHISPER_RIPENS_MS)] }).because, 'nothing ripe yet');
  assert.equal(recall({ held: [whisper('past', WHISPER_RIPENS_MS + 1)] }).because, null);
});

void test('a whisper whose audio did not survive the session is not recalled', () => {
  // Texture is persisted, PCM never is. A whisper restored from storage has a
  // shape on the wall and no voice, and offering it would be silence.
  const result = recall({ held: [ripe], hasRecording: () => false });
  assert.equal(result.whisper, null);
  assert.equal(result.because, 'nothing ripe yet');
});

/**
 * The decision draws twice: once to decide whether to speak at all, then once
 * to pick which whisper. A test that feeds one value to both cannot separate
 * "the roll failed" from "the draw landed elsewhere", so the two are scripted.
 */
const rolls = (...values: number[]) => {
  let at = 0;
  return () => values[Math.min(at++, values.length - 1)];
};

void test('only whispers that are both ripe and audible can be chosen', () => {
  const held = [
    whisper('young', 1_000),
    whisper('silent', WHISPER_RIPENS_MS + 5_000),
    ripe,
  ];
  const hasRecording = (id: string) => id !== 'silent';
  // Walk the draw across the unit interval: wherever it lands it must reach the
  // one eligible whisper, never the young one and never the voiceless one.
  for (const draw of [0, 0.25, 0.5, 0.75, 0.999]) {
    const result = chooseWhisperRecall({
      held, sinceLastRollSeconds: 1, frequency: 1, hasRecording, now: NOW,
      random: rolls(0, draw),
    });
    assert.equal(result.whisper?.id, 'ripe', `a draw of ${draw} reached the wrong whisper`);
  }
});

void test('the draw can reach every eligible whisper and never past the end', () => {
  const held = [
    whisper('a', WHISPER_RIPENS_MS + 1_000),
    whisper('b', WHISPER_RIPENS_MS + 2_000),
    whisper('c', WHISPER_RIPENS_MS + 3_000),
  ];
  const reached = new Set<string>();
  for (let step = 0; step < 300; step += 1) {
    const result = chooseWhisperRecall({
      held, sinceLastRollSeconds: 1, frequency: 1, hasRecording: everything, now: NOW,
      random: rolls(0, step / 300),
    });
    assert.ok(result.whisper, `a draw of ${step / 300} chose nothing`);
    reached.add(result.whisper.id);
  }
  assert.deepEqual([...reached].sort(), ['a', 'b', 'c']);
});

void test('a roll that does not come up is reported as the ordinary case it is', () => {
  const result = recall({ random: never });
  assert.equal(result.whisper, null);
  assert.equal(result.because, 'not this time');
});

void test('the rate rises with the setting and is never negative', () => {
  assert.ok(whisperRecallRate(1) > whisperRecallRate(0.4));
  assert.ok(whisperRecallRate(0.4) > whisperRecallRate(0.1));
  assert.equal(whisperRecallRate(0), 0);
  // A corrupted config cannot invert the room into recalling constantly.
  assert.equal(whisperRecallRate(-5), 0);
});

void test('a visitor at the default setting meets a whisper within a gallery visit', () => {
  // The rate is wall-clock, so this is a property of the setting rather than of
  // the hardware profile: the same expectation must hold whatever the sensing
  // loop runs at. Deterministic — a counter stands in for the RNG — so this
  // measures the rate and not today's luck.
  for (const sensingHz of [10, 24, 60]) {
    const tick = 1 / sensingHz;
    let draws = 0;
    // A uniform sweep of the unit interval, one value per roll.
    const random = () => ((draws += 1) % 1_000) / 1_000;
    let elapsed = 0;
    let firstAt: number | null = null;
    for (let step = 0; step < sensingHz * 600 && firstAt === null; step += 1) {
      elapsed += tick;
      const result = chooseWhisperRecall({
        held: [ripe], sinceLastRollSeconds: tick, frequency: 0.4,
        hasRecording: everything, now: NOW, random,
      });
      if (result.whisper) firstAt = elapsed;
    }
    assert.ok(firstAt !== null && firstAt < 600, `at ${sensingHz} Hz nothing surfaced in ten minutes`);
  }
});
