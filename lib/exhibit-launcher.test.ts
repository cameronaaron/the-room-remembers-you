import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The launcher, driven for real, with stand-ins where the gallery machine is.
 *
 * `exhibit.mjs` is what opens the room and what keeps it open for twelve hours
 * with nobody in the building. Its decisions are unit-tested in
 * gallery-launch.test.ts; what is left — spawn the server, wait for it, open
 * the browser against it, put it back when it falls over, and let go on a
 * signal — is process wiring, and process wiring is only true when processes
 * actually run. Nothing here builds the site, and no real browser is opened:
 * `npm` and Chrome are scripts on PATH that record what they were asked.
 */

const exhibit = fileURLToPath(new URL('../scripts/exhibit.mjs', import.meta.url));
const project = fileURLToPath(new URL('..', import.meta.url));

/** A port nothing is listening on, released immediately before use. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * Stop a launcher and everything under it.
 *
 * The launcher's children inherit its stdio, so an orphaned server keeps this
 * test's pipes open and the run never ends. Detaching gives the whole tree one
 * process group id to take at once.
 */
function killGroup(pid: number | undefined) {
  if (pid === undefined) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

async function executable(path: string, body: string) {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

/** Wait for a predicate over the accumulated log, or fail with what was seen. */
async function until(read: () => Promise<string>, matches: (log: string) => boolean, what: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  let log = '';
  while (Date.now() < deadline) {
    log = await read();
    if (matches(log)) return log;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}; log was:\n${log}`);
}

void test('the launcher builds, serves, opens the room, puts it back, and lets go', async () => {
  const home = await mkdtemp(join(tmpdir(), 'room-exhibit-'));
  const bin = join(home, 'bin');
  await mkdir(bin, { recursive: true });
  const log = join(home, 'calls.log');
  const port = await freePort();

  // A server that answers anything, and — the first time only — stops on its
  // own a second later. That is the failure the restart exists for.
  await writeFile(join(home, 'server.mjs'), `
    import { createServer } from 'node:http';
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    const first = !existsSync(process.env.ONCE);
    if (first) writeFileSync(process.env.ONCE, 'x');
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{}');
    });
    server.listen(${port}, '127.0.0.1', () => appendFileSync(process.env.CALLS, 'serving\\n'));
    if (first) setTimeout(() => process.exit(1), 1000);
  `);
  await executable(join(bin, 'npm'), `#!/bin/sh
echo "npm $@" >> "${log}"
if [ "$1" = "start" ]; then exec node "${join(home, 'server.mjs')}"; fi
exit 0
`);
  await executable(join(bin, 'chrome'), `#!/bin/sh
echo "chrome $@" >> "${log}"
exec sleep 600
`);
  await writeFile(log, '');

  const child = spawn(process.execPath, [exhibit, '--kiosk'], {
    cwd: project,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      PORT: String(port),
      CHROME_BIN: join(bin, 'chrome'),
      ONCE: join(home, 'once'),
      CALLS: log,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const calls = () => readFile(log, 'utf8');
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

  try {
    // Without --skip-build the site is built first. A gallery machine booting
    // into a stale build is the reason this is not simply skipped.
    await until(calls, (text) => text.includes('npm run build'), 'the build');
    await until(calls, (text) => text.includes('npm start'), 'the server');
    const opened = await until(calls, (text) => text.includes('chrome '), 'the browser');

    const args = opened.split('\n').find((line) => line.startsWith('chrome '))!.slice('chrome '.length).split(' ');
    assert.ok(args.includes('--kiosk'), `kiosk missing from ${args.join(' ')}`);
    assert.equal(args.at(-1), `http://127.0.0.1:${port}`, 'the browser must open the port the server bound');
    const profile = args.find((arg) => arg.startsWith('--user-data-dir='))!;
    assert.ok(profile.includes(home), 'the profile lives with the operator, so its camera grant survives');
    assert.ok(!profile.includes(tmpdir().replace(home, '')) || profile.startsWith(`--user-data-dir=${home}`));

    // The server is spawned before the browser: opening a window onto nothing
    // would show the visitor a connection error on the gallery wall.
    assert.ok(opened.indexOf('npm start') < opened.indexOf('chrome '));

    // The first server exits on its own. The launcher must put it back, and
    // the replacement must actually bind the port rather than merely be spawned.
    await until(calls, (text) => (text.match(/npm start/g) ?? []).length >= 2, 'the server to be restarted');
    assert.ok(output.includes('Restarting in 2 seconds'), 'a restart must say so in the log');
    await until(calls, (text) => (text.match(/serving/g) ?? []).length >= 2, 'the replacement to listen');

    // launchd will not start the next instance until this one is gone, so a
    // slow exit is black wall time on every restart. Measured at twenty seconds
    // before the probe agent was given no keep-alive and stop() stopped waiting
    // for the loop to drain.
    const askedAt = Date.now();
    child.kill('SIGTERM');
    assert.equal(await exited, 0, 'a signal must stop the launcher, not leave it respawning');
    assert.ok(Date.now() - askedAt < 3_000, `the launcher took ${Date.now() - askedAt}ms to let go`);
    const final = await calls();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.deepEqual(await calls(), final, 'nothing may be started after the launcher was told to stop');
  } finally {
    killGroup(child.pid);
    child.stdout.destroy();
    child.stderr.destroy();
  }
});

void test('a launcher told to skip the build serves immediately', async () => {
  const home = await mkdtemp(join(tmpdir(), 'room-exhibit-'));
  const bin = join(home, 'bin');
  await mkdir(bin, { recursive: true });
  const log = join(home, 'calls.log');
  const port = await freePort();
  await writeFile(join(home, 'server.mjs'), `
    import { createServer } from 'node:http';
    createServer((_, response) => response.end('{}')).listen(${port}, '127.0.0.1');
    setInterval(() => {}, 1000);
  `);
  await executable(join(bin, 'npm'), `#!/bin/sh
echo "npm $@" >> "${log}"
if [ "$1" = "start" ]; then exec node "${join(home, 'server.mjs')}"; fi
exit 0
`);
  await writeFile(log, '');

  // No --kiosk: the operator is sitting at the machine and will open it. The
  // launcher must not reach for a browser at all, on any platform.
  const child = spawn(process.execPath, [exhibit, '--skip-build'], {
    cwd: project,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, PORT: String(port), CHROME_BIN: '/nonexistent/chrome' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await until(() => readFile(log, 'utf8'), (text) => text.includes('npm start'), 'the server');
    await until(async () => output, (text) => text.includes('is ready at'), 'the ready message');
    assert.ok(output.includes(`http://127.0.0.1:${port}/`), 'the message must name the port actually bound');
    const calls = await readFile(log, 'utf8');
    assert.ok(!calls.includes('npm run build'), '--skip-build must skip the build');
    assert.ok(!output.includes('Could not start Chrome'), 'no browser should have been attempted');
  } finally {
    killGroup(child.pid);
    child.stdout.destroy();
    child.stderr.destroy();
  }
});

void test('the autostart installer writes an agent that plutil accepts and launchctl is asked to load', async () => {
  // Everything real except launchctl, which is replaced because loading the
  // agent would start the installation on this machine. `plutil -lint` is the
  // real one: a document that passes the escaping tests and then fails the
  // parser is an agent a gallery machine boots into and does not run.
  const home = await mkdtemp(join(tmpdir(), 'room-autostart-'));
  const bin = join(home, 'bin');
  await mkdir(bin, { recursive: true });
  const log = join(home, 'launchctl.log');
  await executable(join(bin, 'launchctl'), `#!/bin/sh
echo "$@" >> "${log}"
exit 0
`);
  await writeFile(log, '');

  const installer = fileURLToPath(new URL('../scripts/install-autostart.mjs', import.meta.url));
  const finished = await new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, [installer], {
      cwd: project,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', (code) => resolve({ code, output }));
  });
  assert.equal(finished.code, 0, finished.output);

  const plist = join(home, 'Library', 'LaunchAgents', 'art.room-remembers-you.plist');
  const document = await readFile(plist, 'utf8');
  assert.ok(document.includes('<key>RunAtLoad</key><true/>'));
  assert.ok(document.includes(project.replace(/\/$/, '')), 'the agent must run this checkout');
  assert.ok(document.includes('--kiosk'), 'a gallery machine opens into the room, not a desktop');

  // The old agent is removed before the new one is loaded. Bootstrapping over
  // a loaded label fails, which on a gallery machine means the update silently
  // did not take and the old build keeps running.
  const commands = (await readFile(log, 'utf8')).trim().split('\n');
  assert.equal(commands.length, 2, `expected bootout then bootstrap, got ${commands.join(' / ')}`);
  assert.ok(commands[0].startsWith('bootout '), commands[0]);
  assert.ok(commands[1].startsWith('bootstrap '), commands[1]);
  for (const command of commands) {
    assert.ok(command.endsWith(plist), `${command} did not name the agent just written`);
    assert.match(command, /gui\/\d+/, 'the agent belongs to the operator session, not to root');
  }
  assert.ok(finished.output.includes(plist), 'the installer must say where it put the agent');
});
