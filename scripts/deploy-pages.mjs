/**
 * Publish the built room to Cloudflare Pages.
 *
 * The exhibition runtime is unchanged by this: the gallery machine still runs
 * `npm run exhibit`, still serves from `127.0.0.1`, still needs no network.
 * This exists for the other use — a link to open the piece from somewhere that
 * is not the gallery — and it stages the upload rather than handing Pages the
 * build directory, because the build directory contains files that the local
 * server never serves and Workers hosting is told to skip. What goes and what
 * stays is decided in `lib/pages-publish.ts`, where it can be tested.
 *
 * The staging copy is deliberate. Editing `_headers` in place inside `dist/`
 * would mean the next build silently reverts it, and the publish after that
 * would append to a file the build had already rewritten.
 *
 * Usage: npm run deploy -- [--project=<name>] [--branch=<name>] [--dry-run]
 */

import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { deployFlag, partitionPublishable, withExhibitionHeaders } from '../lib/pages-publish.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const buildDir = join(root, 'dist', 'client');

const projectName = deployFlag(process.argv, 'project', 'the-room-remembers-you');
const branch = deployFlag(process.argv, 'branch', 'main');
const dryRun = process.argv.includes('--dry-run');

/** Every file under a directory, as paths relative to it. */
async function walk(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

async function main() {
  let found;
  try {
    found = await walk(buildDir);
  } catch {
    console.error(`No build at ${buildDir}. Run \`npm run build\` first.`);
    process.exitCode = 1;
    return;
  }

  const { publish, withhold } = partitionPublishable(found);
  if (publish.length === 0) {
    console.error(`Nothing to publish in ${buildDir}.`);
    process.exitCode = 1;
    return;
  }

  const staging = await mkdtemp(join(tmpdir(), 'room-pages-'));
  try {
    for (const file of publish) {
      await cp(join(buildDir, file), join(staging, file), { recursive: true });
    }

    // The local server grants camera and microphone; so must the hosted copy.
    const headersPath = join(staging, '_headers');
    const generated = await readFile(headersPath, 'utf8').catch(() => '');
    await writeFile(headersPath, withExhibitionHeaders(generated));

    console.log(`Publishing ${publish.length} files from ${buildDir}`);
    if (withhold.length > 0) console.log(`Withholding ${withhold.join(', ')}`);

    if (dryRun) {
      console.log(`Dry run: staged at ${staging} (kept for inspection)`);
      return;
    }

    // Wrangler otherwise finds `.wrangler/deploy/config.json`, which points at
    // the Workers build's own config and has nothing to say about Pages.
    await run('npx', [
      'wrangler',
      'pages',
      'deploy',
      staging,
      `--project-name=${projectName}`,
      `--branch=${branch}`,
      '--commit-dirty=true',
    ]);
  } finally {
    if (!dryRun) await rm(staging, { recursive: true, force: true });
  }
}

/** Run a command attached to this terminal, and fail if it fails. */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0]} ${args[1]} exited with ${code}`));
    });
  });
}

await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
