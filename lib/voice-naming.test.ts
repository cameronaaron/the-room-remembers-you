import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function executable(path: string, body: string) {
  await writeFile(path, body);
  await chmod(path, 0o755);
}
import {
  assertCompleteRender,
  languageOf,
  lineId,
  linesToRender,
  parseArgs,
  staleRenderings,
} from '../scripts/render-voice.ts';
import { VOICE_LINES, type VoiceKind } from './room-voice.ts';

void test('a voice carries its own language, so the phonemiser cannot disagree with it', () => {
  // Rendering an American voice against British phonemes degrades quietly
  // instead of failing, so the pairing is derived rather than passed.
  assert.equal(languageOf('af_heart'), 'a');
  assert.equal(languageOf('am_michael'), 'a');
  assert.equal(languageOf('bm_george'), 'b');
  assert.equal(languageOf('bf_emma'), 'b');
  for (const bad of ['', 'x', 'heart', 'a_heart', 'afheart', 'ax_heart']) {
    assert.throws(() => languageOf(bad), /unrecognised Kokoro voice/, bad);
  }
});

void test('arguments are read in either form, and the defaults are the shipped ones', () => {
  assert.deepEqual(parseArgs([]), { voice: 'af_heart', speed: 0.92, langCode: 'a' });
  assert.deepEqual(parseArgs(['--voice', 'bm_george']), { voice: 'bm_george', speed: 0.92, langCode: 'b' });
  assert.deepEqual(parseArgs(['--voice=bf_emma']), { voice: 'bf_emma', speed: 0.92, langCode: 'b' });
  assert.equal(parseArgs(['--speed', '0.8']).speed, 0.8);
  assert.equal(parseArgs(['--speed=1.1']).speed, 1.1);
  assert.deepEqual(parseArgs(['rubbish', '--voice', 'af_bella']).voice, 'af_bella');
});

void test('the language follows the voice unless it is deliberately overridden', () => {
  // The renderer once hardcoded British while accepting any --voice, which
  // would have rendered an American voice reading British phonemes: degraded
  // output, no error. The default must come from the name.
  assert.equal(parseArgs(['--voice', 'af_heart']).langCode, 'a');
  assert.equal(parseArgs(['--voice', 'bm_lewis']).langCode, 'b');
  // An explicit override stays possible, because it is sometimes right.
  assert.equal(parseArgs(['--voice', 'af_heart', '--lang', 'b']).langCode, 'b');
});

void test('a voice name that is not a Kokoro name is refused, not guessed at', () => {
  assert.throws(() => parseArgs(['--voice', 'Daniel']), /unrecognised Kokoro voice/);
  assert.throws(() => parseArgs(['--voice', '']), /unrecognised Kokoro voice/);
});

void test('every line in the table gets a stable, filesystem-safe id', () => {
  // A re-render overwrites in place. An unstable id would leave the previous
  // rendering of a line on disk, still playable, next to its replacement.
  const seen = new Set<string>();
  for (const [kind, lines] of Object.entries(VOICE_LINES)) {
    lines.forEach((_, index) => {
      const id = lineId(kind as VoiceKind, index);
      assert.match(id, /^[a-z]+-\d+$/, `${id} is not safe as a filename`);
      assert.ok(!seen.has(id), `${id} is used twice`);
      seen.add(id);
      assert.equal(lineId(kind as VoiceKind, index), id, 'and it must be stable');
    });
  }
});

void test('the render covers the room\'s whole vocabulary exactly once', () => {
  const lines = linesToRender();
  const expected = Object.values(VOICE_LINES).reduce((sum, set) => sum + set.length, 0);
  assert.equal(lines.length, expected, 'every line the room can say must be rendered');
  assert.equal(new Set(lines.map((line) => line.id)).size, lines.length, 'and exactly once');
  for (const line of lines) assert.ok(line.text.length > 0);
});

void test('a partial render is refused rather than published as a manifest', () => {
  // A manifest listing only the lines that succeeded leaves the room mute on
  // exactly the occasions that failed, with no file missing to notice.
  assert.throws(() => assertCompleteRender(33, 34), /expected 34 rendered lines, got 33/);
  assertCompleteRender(34, 34);
});

void test('a line removed from the table stops speaking from disk', () => {
  const expected = new Set(['return-0.wav', 'return-1.wav']);
  const onDisk = ['return-0.wav', 'return-1.wav', 'deleted-line-0.wav', 'manifest.json', 'notes.txt'];
  assert.deepEqual(staleRenderings(onDisk, expected), ['deleted-line-0.wav']);
  // Nothing that is not a rendering is ever removed: the manifest lives here.
  assert.deepEqual(staleRenderings(['manifest.json'], new Set()), []);
});

void test('a render reports through a file, cleans up what a deleted line left, and refuses a short set', async () => {
  // Every part of this except Kokoro itself. The model stack prints a
  // download notice to stdout on first run, which corrupted the report after a
  // completely successful 34-line render — so the report goes through a file
  // the job names, and that is what is exercised here. `uv` is a script on PATH
  // that writes the report the renderer would have written.
  const workspace = await mkdtemp(join(tmpdir(), 'render-voice-'));
  const bin = join(workspace, 'bin');
  const out = join(workspace, 'voice');
  await mkdir(bin, { recursive: true });
  await mkdir(out, { recursive: true });
  // A file from a line that no longer exists, and one the render will keep.
  await writeFile(join(out, 'deleted-line.wav'), 'old');
  await writeFile(join(out, 'manifest.json'), '{}');

  const lines = linesToRender();
  const fakeRenderer = join(workspace, 'render.mjs');
  await writeFile(fakeRenderer, `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const job = JSON.parse(readFileSync(0, 'utf8'));
    // Kokoro's own first-run notice, on the channel the report used to share.
    console.log('downloading model weights...');
    const limit = Number(process.env.RENDER_ONLY ?? job.lines.length);
    // The real renderer names the file after the line's id, which is what the
    // stale-file sweep compares against.
    const rendered = job.lines.slice(0, limit).map((line) => {
      const file = line.id + '.wav';
      writeFileSync(join(job.outDir, file), 'wav');
      return { ...line, file, durationMs: 1200, peak: 0.89, rms: 0.0843 };
    });
    writeFileSync(job.reportPath, JSON.stringify({ voice: job.voice, sampleRate: 24000, lines: rendered }));
  `);
  await executable(join(bin, 'uv'), `#!/bin/sh
# uv run --quiet <script>: the script is the last argument.
shift 2
exec node "${fakeRenderer}"
`);

  const render = (extra: Record<string, string> = {}) => new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/render-voice.ts', import.meta.url)), '--voice', 'af_heart'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROOM_VOICE_OUT: out, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', (code) => resolve({ code, output }));
  });

  const complete = await render();
  assert.equal(complete.code, 0, complete.output);
  assert.ok(complete.output.includes(`rendering ${lines.length} lines as af_heart (a) at speed`), complete.output);
  assert.match(complete.output, new RegExp(`wrote ${lines.length} files`));

  const written = await readdir(out);
  assert.equal(written.filter((name) => name.endsWith('.wav')).length, lines.length);
  // A line deleted from the table must not keep speaking from disk.
  assert.ok(!written.includes('deleted-line.wav'), 'a rendering with no line behind it was left on disk');

  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.voice, 'af_heart');
  assert.equal(manifest.sampleRate, 24_000);
  assert.equal(manifest.lines.length, lines.length);
  // The notice the model printed to stdout must not be in the report.
  assert.ok(!JSON.stringify(manifest).includes('downloading'), 'the report shared a channel with the model stack');

  // A short render is the failure that is silent in every other channel: files
  // are written, the manifest is written, and one line is missing.
  const short = await render({ RENDER_ONLY: String(lines.length - 1) });
  assert.notEqual(short.code, 0, 'a render that dropped a line reported success');
  assert.match(short.output, new RegExp(`expected ${lines.length} rendered lines, got ${lines.length - 1}`));

  await rm(workspace, { recursive: true, force: true });
});
