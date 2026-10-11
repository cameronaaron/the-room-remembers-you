import { spawn } from 'node:child_process';
import { Agent, request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { HEARTBEAT_INTERVAL_MS, RenderWatchdog } from '../lib/liveness.ts';
import { chromeKioskArguments, observeHealth } from './exhibit-runtime.ts';

const root = new URL('..', import.meta.url);
const kiosk = process.argv.includes('--kiosk');
const skipBuild = process.argv.includes('--skip-build');
// The port the static server binds, and the origin everything here probes, are
// one setting. PORT is what `npm start` already reads, so a second machine — or
// a test that must not collide with a dev server — sets one variable, not two.
const port = Number(process.env.PORT || 3000);
const origin = `http://127.0.0.1:${port}`;
let server = null;
let browser = null;
let stopping = false;
let watchdog = null;
let watchTimer = null;

/**
 * Probes get an agent of their own, with no keep-alive.
 *
 * Node's global agent pools sockets, and a pooled socket to the room's own
 * server is a live handle that outlives the request. Measured: the launcher
 * took twenty seconds to exit after being told to stop, waiting on a probe
 * socket and a child handle rather than on anything it still needed.
 */
const probes = new Agent({ keepAlive: false });

/**
 * Chrome runs against a profile of its own, in a stable location.
 *
 * `open -a "Google Chrome"` hands back no process handle at all, which is why
 * the browser could previously be started and never afterwards managed: it was
 * opened once, `kioskOpened` latched true, and if the tab crashed at 2pm the
 * wall stayed black until somebody walked past. Spawning Chrome directly gives
 * a handle to kill and replace.
 *
 * The profile is stable rather than temporary so that camera and microphone
 * permissions, granted once by the operator, survive every relaunch. A fresh
 * profile per launch would put a permission prompt on the gallery wall instead.
 */
const profileDir = join(
  homedir(),
  'Library',
  'Application Support',
  'the-room-remembers-you',
  'chrome-profile',
);

/**
 * Which browser to be the room in.
 *
 * `CHROME_BIN` is the same variable the render-regression harness reads, for
 * the same reason: Chrome is not always at the default path, and a test needs
 * to stand something else in its place without a browser opening on the wall.
 *
 * The kiosk launch used to give up silently on anything but macOS, so a Linux
 * gallery machine served the page and never opened it, with nothing said. It
 * now tries, and the spawn error below says what to do if there is no Chrome.
 */
const CHROME = process.env.CHROME_BIN
  || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
    child.once('error', reject);
  });
}

function getJson(path) {
  return new Promise((resolve) => {
    const probe = request(`${origin}${path}`, { method: 'GET', agent: probes }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    probe.on('error', () => resolve(null));
    probe.setTimeout(2000, () => { probe.destroy(); resolve(null); });
    probe.end();
  });
}

async function waitForRoom(attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ready = await new Promise((resolve) => {
      const probe = request(`${origin}/`, { method: 'HEAD', agent: probes }, (response) => {
        response.resume();
        resolve(Boolean(response.statusCode && response.statusCode < 500));
      });
      probe.on('error', () => resolve(false));
      probe.setTimeout(750, () => { probe.destroy(); resolve(false); });
      probe.end();
    });
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function launchBrowser() {
  if (!kiosk || stopping) return;
  browser?.kill('SIGTERM');
  browser = spawn(CHROME, chromeKioskArguments(origin, profileDir), { stdio: 'ignore' });
  browser.on('error', (error) => {
    console.error(`Could not start Chrome (${error.message}). Open ${origin}/ by hand.`);
    browser = null;
  });
}

/**
 * Watch the renderer, not just the server.
 *
 * The static file server has no dependencies and holds no state; it was the
 * only thing being restarted. What actually fails on an unattended machine is
 * the page — and the worst version of that failure reports nothing at all,
 * because a stalled render loop keeps showing its last frame, which in a dark
 * gallery is indistinguishable from a room with nothing to remember.
 */
function startWatchdog() {
  if (!kiosk || watchTimer) return;
  watchdog = new RenderWatchdog(Date.now());
  watchTimer = setInterval(async () => {
    if (stopping) return;
    const health = await getJson('/health');
    const now = Date.now();
    const verdict = watchdog.check(observeHealth(health, now), now);
    if (!verdict.relaunch) return;
    console.error(`Renderer ${verdict.state}: ${verdict.reason}. Relaunching the browser.`);
    watchdog.relaunched(now);
    launchBrowser();
  }, HEARTBEAT_INTERVAL_MS);
  watchTimer.unref?.();
}

async function startServer() {
  if (stopping) return;
  server = spawn('npm', ['start'], { cwd: root, stdio: 'inherit', shell: false });
  if (await waitForRoom()) {
    console.log(`\nTHE ROOM REMEMBERS YOU is ready at ${origin}/`);
    console.log('Press O for the operator console, F for fullscreen.\n');
    launchBrowser();
    startWatchdog();
  }
  server.once('exit', () => {
    if (!stopping) {
      console.error('Renderer stopped. Restarting in 2 seconds…');
      setTimeout(startServer, 2000);
    }
  });
}

function stop() {
  stopping = true;
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
  browser?.kill('SIGTERM');
  server?.kill('SIGTERM');
  probes.destroy();
  // Nothing here is buffered, and launchd waits for this process to go before
  // it will start the next one. Draining the loop instead of exiting took
  // twenty seconds, which is twenty seconds of black wall on every restart.
  process.exit(0);
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

if (!skipBuild) await run('npm', ['run', 'build']);
await startServer();
