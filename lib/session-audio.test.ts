import assert from 'node:assert/strict';
import test from 'node:test';
import { whisperTone } from './whisper-tone.ts';
import { SessionAudio } from './session-audio.ts';
import { AudioMemoryEngine } from './audio-memory.ts';
import type { WhisperMemory } from './room-types.ts';

void test('capture retains contiguous real samples across chunks and ring wrap', () => {
  const audio = new SessionAudio(10);
  audio.push(Float32Array.from({ length: 60 }, (_, i) => i));
  audio.push(Float32Array.from({ length: 30 }, (_, i) => i + 60));
  audio.capture('voice', 2);
  assert.deepEqual([...audio.get('voice')!], Array.from({ length: 20 }, (_, i) => i + 70));
  audio.clearRing();
  assert.equal(audio.get('voice')!.length, 20);
  const retained = audio.get('voice')!;
  audio.clear();
  assert.equal(audio.get('voice'), undefined);
  assert.ok(retained.every((value) => value === 0));
});

void test('session audio evicts and zeros old clips at both limits', () => {
  const audio = new SessionAudio(24000);
  audio.push(new Float32Array(168000).fill(0.2));
  audio.capture('first', 6);
  const first = audio.get('first')!;
  for (let i = 0; i < 100; i++) audio.capture(String(i), 6);
  assert.ok(audio.bytes <= 32 * 1024 * 1024);
  assert.equal(audio.get('first'), undefined);
  assert.ok(first.every((value) => value === 0));
});

void test('replay tones actual PCM at original speed and preserves longer suppression', () => {
  const engine = new AudioMemoryEngine(() => {});
  const recordings = new SessionAudio(10);
  recordings.push(Float32Array.from([0.1, 0.2, -0.1, -0.2, 0]));
  recordings.capture('voice', 0.5);
  let pcm = new Float32Array(5);
  const parameter = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} });
  const node = () => ({ connect(other: unknown) { return other; }, disconnect() {} });
  let starts = 0;
  const source = { ...node(), buffer: null, playbackRate: parameter(), start() { starts++; }, stop() {}, onended: null };
  const context = { currentTime: 1, sampleRate: 10, state: 'running', destination: {},
    createBuffer: (_channels: number, length: number) => { pcm = new Float32Array(length); return { duration: length / 10, getChannelData: () => pcm }; },
    createBufferSource: () => source,
    createGain: () => ({ ...node(), gain: parameter() }),
    createStereoPanner: () => ({ ...node(), pan: parameter() }),
  };
  Object.assign(engine, { context, recordings });
  const memory = { id: 'voice', position: { x: 0.5 } } as WhisperMemory;
  engine.suppressFor(60000);
  const before = (engine as unknown as { suppressUntil: number }).suppressUntil;
  engine.replay(memory, 0.32);
  assert.deepEqual(pcm, whisperTone(recordings.get('voice')!, context.sampleRate));
  assert.deepEqual(recordings.get('voice'), Float32Array.from([0.1, 0.2, -0.1, -0.2, 0]));
  assert.equal(source.playbackRate.value, 1);
  assert.equal(starts, 1);
  assert.ok((engine as unknown as { suppressUntil: number }).suppressUntil >= before);
  engine.replay(memory, 0.32);
  assert.equal(starts, 1);
  context.currentTime = 10;
  engine.replay({ ...memory, id: 'old-envelope-only' }, 0.32);
  engine.replay(memory, 0);
  assert.equal(starts, 1);
  engine.replay(memory, 0.32, 1);
  assert.equal(starts, 2);
  assert.equal(pcm.length, 2, 'a failing voice ends before the original phrase');
  assert.equal(recordings.get('voice')!.length, 5, 'forgetting playback must not overwrite the source');
});

void test('audio worklet transfers continuous mono PCM without monitoring the microphone', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const chunks: Float32Array[] = [];
  let create: (() => { process(input: Float32Array[][]): boolean }) | undefined;
  class Processor {
    port = { postMessage: (chunk: Float32Array) => chunks.push(chunk) };
  }
  runInNewContext(readFileSync(new URL('../public/audio/capture-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: Processor,
    Float32Array,
    registerProcessor: (_name: string, implementation: new () => { process(input: Float32Array[][]): boolean }) => {
      create = () => new implementation();
    },
  });
  assert.ok(create);
  const processor = create();
  assert.equal(processor.process([[new Float32Array([0.2, -0.4]), new Float32Array([0.4, -0.2])]]), true);
  processor.process([[new Float32Array([0.5, 0.6])]]);
  assert.equal(chunks.length, 2);
  assert.ok(Math.abs(chunks[0][0] - 0.3) < 1e-6);
  assert.ok(Math.abs(chunks[0][1] + 0.3) < 1e-6);
  assert.deepEqual(chunks[1], new Float32Array([0.5, 0.6]));
  processor.process([]);
  assert.equal(chunks.length, 2);
});

void test('held clips are evicted oldest-first and their samples are wiped, not merely dropped', () => {
  const audio = new SessionAudio(48_000);
  audio.push(new Float32Array(1024).fill(0.5));
  const retained: Float32Array[] = [];
  for (let index = 0; index < 85; index += 1) {
    audio.capture(`clip-${index}`, 0.01);
    const clip = audio.get(`clip-${index}`);
    if (clip) retained.push(clip);
  }
  assert.equal(audio.get('clip-0'), undefined, 'the oldest clip is the one that goes');
  assert.equal(audio.get('clip-84')?.length, 480, 'the newest is kept whole');
  let held = 0;
  for (let index = 0; index < 85; index += 1) if (audio.get(`clip-${index}`)) held += 1;
  assert.equal(held, 80, 'the cap is a count of clips, not a suggestion');
  // Privacy: an evicted clip's PCM must be zeroed, not left for whoever still
  // holds the reference the capture handed out.
  assert.ok(retained[0].every((sample) => sample === 0), 'evicted PCM was left in memory');
});

void test('the byte ceiling evicts even while the clip count is far below its cap', () => {
  const audio = new SessionAudio(48_000);
  audio.push(new Float32Array(48_000 * 7).fill(0.25));
  // 6.5 s per clip at 4 bytes a sample is 1.25 MiB; 32 MiB is reached at 26.
  for (let index = 0; index < 40; index += 1) audio.capture(`clip-${index}`, 6.5);
  assert.ok(audio.bytes <= 32 * 1024 * 1024, `held ${audio.bytes} bytes`);
  assert.equal(audio.get('clip-0'), undefined);
  assert.ok(audio.get('clip-39'), 'the most recent whisper survives the ceiling');
  let held = 0;
  for (let index = 0; index < 40; index += 1) if (audio.get(`clip-${index}`)) held += 1;
  assert.ok(held < 80, 'the byte ceiling bound the set before the count could');
});
