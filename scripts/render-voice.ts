/**
 * Give the room its voice, once, offline.
 *
 * The vocabulary is a fixed table of 34 lines, so every sentence the room can
 * ever say is known ahead of time and none of it has to be synthesised while
 * the gallery is open. Rendering ahead keeps the runtime's offline guarantee
 * intact, removes synthesis latency from moments that are timed to the frame,
 * and — because a rendered file has a known length — lets the microphone be
 * closed for exactly as long as the room is actually speaking.
 *
 *   npm run render-voice -- --voice af_heart
 *
 * Re-run only when a line changes. The output is committed; the model is not
 * needed to exhibit the work.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VOICE_LINES } from '../lib/room-voice.ts';
import type { VoiceKind } from '../lib/room-voice.ts';

/**
 * Where the rendered files land.
 *
 * `ROOM_VOICE_OUT` exists so a render can be staged somewhere else and listened
 * to before it replaces what is committed — and so this script can be driven by
 * a test without overwriting the room's actual voice, which is the sort of
 * thing a test discovers by destroying it once.
 */
export const OUT_DIR = new URL(
  process.env.ROOM_VOICE_OUT ? `${process.env.ROOM_VOICE_OUT.replace(/\/?$/, '/')}` : '../public/voice/',
  process.env.ROOM_VOICE_OUT ? pathToFileURL(`${process.cwd()}/`) : import.meta.url,
);
const MANIFEST = new URL('manifest.json', OUT_DIR);

type RenderedLine = {
  id: string;
  text: string;
  file: string;
  durationMs: number;
  peak: number;
  rms: number;
};

/**
 * Kokoro names a voice `<language><gender>_<name>`, so `af_heart` is American
 * and `bm_george` is British. Taking the language from the name keeps the
 * phonemiser and the voice in agreement: passing an American voice while the
 * default British code stood produced an American voice reading British
 * phonemes, which degrades quietly rather than failing.
 */
export function languageOf(voice: string): string {
  if (!/^[a-z][fm]_.+$/.test(voice)) throw new Error(`unrecognised Kokoro voice name: ${voice}`);
  return voice.slice(0, 1);
}

/**
 * Exported for tests. The renderer itself spawns `uv` and a model download, so
 * the parsing is the part that can be held to a standard: a voice and a
 * language that disagree render a real, degraded result with no error.
 */
export function parseArgs(argv: readonly string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [flag, inline] = token.slice(2).split('=');
    args.set(flag, inline ?? argv[++i] ?? '');
  }
  const voice = args.get('voice') ?? 'af_heart';
  return {
    voice,
    speed: Number(args.get('speed') ?? '0.92'),
    langCode: args.get('lang') ?? languageOf(voice),
  };
}

/** Stable, filesystem-safe id for a line, so a re-render overwrites in place. */
export function lineId(kind: VoiceKind, index: number): string {
  return `${kind}-${index}`;
}

/** Every line the room can say, flattened into what the renderer is asked for. */
export function linesToRender(): Array<{ id: string; text: string }> {
  return Object.entries(VOICE_LINES).flatMap(([kind, set]) =>
    set.map((text, index) => ({ id: lineId(kind as VoiceKind, index), text })),
  );
}

/**
 * Rendered files on disk that no line claims any more.
 *
 * A line deleted from the table must not keep speaking: the runtime plays
 * whatever the manifest names, but a stale file left beside it is a sentence
 * the work no longer contains, sitting in the shipped artifact.
 */
export function staleRenderings(
  onDisk: readonly string[],
  expected: ReadonlySet<string>,
): string[] {
  return onDisk.filter((name) => name.endsWith('.wav') && !expected.has(name));
}

/**
 * Refuse a partial render rather than writing a manifest for it.
 *
 * A short report means some lines failed silently, and a manifest listing the
 * survivors would leave the room mute on exactly those occasions, with no file
 * missing and nothing to notice.
 */
export function assertCompleteRender(rendered: number, expected: number) {
  if (rendered !== expected) {
    throw new Error(`expected ${expected} rendered lines, got ${rendered}`);
  }
}

async function main() {
  const { voice, speed, langCode } = parseArgs(process.argv.slice(2));
  const lines = linesToRender();
  console.log(`rendering ${lines.length} lines as ${voice} (${langCode}) at speed ${speed}`);

  // The renderer reports through a file, not stdout: the model stack prints to
  // stdout on first run and silently corrupted the payload when they shared it.
  const workspace = await mkdtemp(join(tmpdir(), 'render-voice-'));
  const reportPath = join(workspace, 'report.json');
  const script = fileURLToPath(new URL('./kokoro-render.py', import.meta.url));
  const child = spawn('uv', ['run', '--quiet', script], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(JSON.stringify({ outDir: fileURLToPath(OUT_DIR), reportPath, voice, speed, langCode, lines }));

  const code: number = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) throw new Error(`kokoro-render.py exited ${code}`);

  const report = JSON.parse(await readFile(reportPath, 'utf8')) as { voice: string; sampleRate: number; lines: RenderedLine[] };
  await rm(workspace, { recursive: true, force: true });
  assertCompleteRender(report.lines.length, lines.length);

  // A line deleted from the table must not keep speaking from disk.
  const expected = new Set(report.lines.map((line) => line.file));
  for (const name of staleRenderings(await readdir(OUT_DIR), expected)) {
    await rm(new URL(name, OUT_DIR));
  }

  await writeFile(MANIFEST, `${JSON.stringify(report, null, 2)}\n`);
  const total = report.lines.reduce((sum, line) => sum + line.durationMs, 0);
  console.log(`wrote ${report.lines.length} files, ${(total / 1000).toFixed(1)}s of speech`);
}

// Guarded so the module can be imported for its pure helpers without kicking
// off a render.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
