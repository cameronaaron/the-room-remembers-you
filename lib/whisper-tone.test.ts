import assert from 'node:assert/strict';
import test from 'node:test';
import { whisperTone } from './whisper-tone.ts';

const rate = 24000;
const amplitude = (pcm: Float32Array, hz: number) => {
  let sin = 0;
  let cos = 0;
  for (let i = 1000; i < pcm.length; i++) {
    sin += pcm[i] * Math.sin(2 * Math.PI * hz * i / rate);
    cos += pcm[i] * Math.cos(2 * Math.PI * hz * i / rate);
  }
  return Math.hypot(sin, cos) * 2 / (pcm.length - 1000);
};

void test('tone reduces chest resonance while retaining vowel and consonant bands', () => {
  const frequencies = [120, 700, 2200, 4500];
  const input = Float32Array.from({ length: rate }, (_, i) =>
    frequencies.reduce((sum, hz) => sum + 0.1 * Math.sin(2 * Math.PI * hz * i / rate), 0));
  const original = input.slice();
  const output = whisperTone(input, rate);
  assert.deepEqual(input, original, 'the stored visitor recording must not be overwritten');
  assert.equal(output.length, input.length, 'words must keep their duration');
  assert.ok(amplitude(output, 120) / amplitude(output, 2200) < 0.6);
  assert.ok(amplitude(output, 700) / amplitude(output, 2200) > 0.7);
  assert.ok(amplitude(output, 4500) / amplitude(output, 2200) > 0.6);
  assert.ok(Math.max(...output.map(Math.abs)) <= 0.901);
});

void test('quiet recorded speech is leveled audibly and silence never turns into hiss', () => {
  const voice = Float32Array.from({ length: rate }, (_, i) => 0.008 * Math.sin(2 * Math.PI * 700 * i / rate));
  const output = whisperTone(voice, rate);
  const rms = Math.sqrt(output.reduce((sum, value) => sum + value * value, 0) / output.length);
  assert.ok(rms > 0.18 && rms < 0.24);
  assert.ok(whisperTone(new Float32Array(rate), rate).every((value) => value === 0));
});

void test('silent gaps remain silent after filter decay and high peaks stay bounded', () => {
  const input = new Float32Array(rate);
  for (let i = 0; i < rate / 3; i++) input[i] = 0.5 * Math.sin(2 * Math.PI * 900 * i / rate);
  input[0] = 1;
  const output = whisperTone(input, rate);
  assert.ok(output.slice(rate / 2).every((value) => Math.abs(value) < 1e-6));
  assert.ok(Math.max(...output.map(Math.abs)) <= 0.901);
});
