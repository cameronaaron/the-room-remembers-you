import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { AGENT_LABEL, autostartCommand, launchAgentPlist, shellQuote, xmlEscape } from '../scripts/autostart-plist.ts';
import { chromeKioskArguments, observeHealth } from '../scripts/exhibit-runtime.ts';
import { HEARTBEAT_STALE_MS, LAUNCH_GRACE_MS, RenderWatchdog } from './liveness.ts';
import type { Heartbeat } from './liveness.ts';

/**
 * The machine that opens the gallery.
 *
 * Nothing here touches a process, a browser or a plist on disk. What it holds
 * fixed is the two decisions that have no second chance on an unattended
 * machine: what goes into the launch agent, given a path chosen by whoever
 * checked the work out, and whether a health reply means the room is alive.
 */

const beat: Heartbeat = {
  at: 1_000_000,
  uptimeMs: 600_000,
  fps: 60,
  sensingHz: 23.8,
  tracks: 1,
  entered: true,
  engine: 'WebGL2 swarm · 360k',
};

void test('a path with XML in it is escaped once, not escaped twice', () => {
  assert.equal(xmlEscape('Art & Craft'), 'Art &amp; Craft');
  // The ampersand has to go first. Replacing < before & turns "<" into "&lt;"
  // and then into "&amp;lt;", which renders as the literal text "&lt;".
  assert.equal(xmlEscape('<a & b>'), '&lt;a &amp; b&gt;');
  assert.equal(xmlEscape('say "room"'), 'say &quot;room&quot;');
  assert.equal(xmlEscape('plain'), 'plain');
});

void test('a path with a quote in it cannot end the shell command early', () => {
  // /tmp/someone/Nadia's work/room is an ordinary checkout and a command
  // that ends at the apostrophe, leaving the rest to run as its own words.
  assert.equal(shellQuote("Nadia's work"), `'Nadia'\\''s work'`);
  assert.equal(shellQuote('/tmp/a/room'), `'/tmp/a/room'`);
  assert.equal(shellQuote('; rm -rf ~'), `'; rm -rf ~'`);

  // Asserting against a hand-written expectation only proves the function does
  // what this test thinks zsh wants. The agent runs `zsh -lc`, so ask zsh: each
  // path must come back as exactly one argument, unchanged.
  for (const path of ["/tmp/someone/Nadia's work/room", '/Art & Craft/room', "a'; rm -rf ~; echo '", '/room $HOME `id` "x"', '/room\\path']) {
    const echoed = execFileSync('/bin/zsh', ['-c', `printf '%s\\n' ${shellQuote(path)}`], { encoding: 'utf8' });
    assert.equal(echoed, `${path}\n`, `zsh did not read ${path} back as one literal argument`);
  }
});

void test('the launch agent survives a project path containing both a quote and an ampersand', () => {
  const project = "/tmp/someone/Art & Craft/Nadia's room";
  const document = launchAgentPlist({ project, runtime: `${project}/.runtime` });
  assert.match(document, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.ok(document.includes(`<key>Label</key><string>${AGENT_LABEL}</string>`));
  assert.ok(document.includes('<key>RunAtLoad</key><true/>'), 'a gallery machine must open by itself');
  assert.ok(document.includes('<key>KeepAlive</key><true/>'), 'and reopen if the room stops');

  // Nothing may leave a raw & or a bare " in the document; plutil -lint in the
  // installer would reject it, but only after the agent is already written.
  const elements = [...document.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  assert.ok(elements.length >= 4);
  for (const element of elements) {
    assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(element), `unescaped ampersand in ${element}`);
    assert.ok(!element.includes('"'), `unescaped quote in ${element}`);
  }
  const command = elements.find((element) => element.includes('npm run exhibit'))!;
  assert.ok(command.includes('&amp;&amp;'), 'the shell && must be escaped for XML');
  // And after XML decoding it must still be the command that was quoted.
  const decoded = command.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
  assert.equal(decoded, autostartCommand(project));
  assert.ok(decoded.endsWith('--kiosk --skip-build'), 'the gallery boots to run, not to compile');
});

void test('both log paths are named and distinct, so a failed boot leaves a record', () => {
  const document = launchAgentPlist({ project: '/room', runtime: '/room/.runtime' });
  assert.ok(document.includes('<key>StandardOutPath</key><string>/room/.runtime/installation.log</string>'));
  assert.ok(document.includes('<key>StandardErrorPath</key><string>/room/.runtime/installation-error.log</string>'));
});

void test('Chrome is asked to come up as the room and not as a restore prompt', () => {
  const args = chromeKioskArguments('http://127.0.0.1:3000', '/profiles/room');
  assert.equal(args.at(-1), 'http://127.0.0.1:3000', 'the URL is the last argument Chrome reads');
  assert.ok(args.includes('--kiosk'));
  // The room starts its own audio with nobody present to click anything.
  assert.ok(args.includes('--autoplay-policy=no-user-gesture-required'));
  // A stable profile keeps the camera and microphone grants the operator gave.
  assert.ok(args.includes('--user-data-dir=/profiles/room'));
  for (const flag of ['--disable-session-crashed-bubble', '--hide-crash-restore-bubble', '--no-first-run', '--no-default-browser-check']) {
    assert.ok(args.includes(flag), `${flag} missing: a relaunch would open a dialog on the gallery wall`);
  }
  assert.ok(!args.some((arg) => arg.startsWith('--user-data-dir=/tmp')), 'a temporary profile loses the permissions');
});

void test('a health reply is only an observation if it carries both a beat and its age', () => {
  const now = 5_000_000;
  assert.deepEqual(observeHealth({ beat, ageMs: 1_200 }, now), { beat, receivedAt: now - 1_200 });
  assert.equal(observeHealth(null, now), null, 'an unreachable page is not a fresh one');
  assert.equal(observeHealth({}, now), null);
  assert.equal(observeHealth({ beat }, now), null, 'a beat of unknown age tells the watchdog nothing');
  assert.equal(observeHealth({ beat, ageMs: '1200' }, now), null);
  assert.equal(observeHealth({ beat, ageMs: Number.NaN }, now), null);
  assert.equal(observeHealth({ beat, ageMs: -50 }, now), null, 'a beat from the future is a broken clock');
  assert.equal(observeHealth({ beat: { ...beat, fps: undefined }, ageMs: 10 }, now), null);
  assert.equal(observeHealth('{"beat":1}' as unknown as null, now), null);
});

void test('an age the server has been sitting on is read as stale, not as an arrival', () => {
  // The whole point of working back from ageMs: a server holding a two-minute
  // old beat is the frozen page the watchdog exists to catch, and treating the
  // reply's arrival as the beat's time would have it agree the room is fine.
  const start = 9_000_000;
  const watchdog = new RenderWatchdog(start);
  const now = start + LAUNCH_GRACE_MS + 10_000;
  const fresh = watchdog.check(observeHealth({ beat, ageMs: 500 }, now), now);
  assert.equal(fresh.relaunch, false);
  assert.equal(fresh.state, 'ok');

  const held = watchdog.check(observeHealth({ beat, ageMs: HEARTBEAT_STALE_MS + 1_000 }, now), now);
  assert.equal(held.state, 'gone');
  assert.equal(held.relaunch, true, 'a page that stopped reporting must be relaunched');
  assert.match(held.reason, /heartbeat/);
});
