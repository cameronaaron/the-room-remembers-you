import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
// The fixture comes first, and must: React DOM picks its event implementation
// at import time, and Base UI resolves the document its portals attach to the
// same way. A component imported ahead of the fixture renders into nothing —
// silently, with no error anywhere.
import { mountInstallation, figure, figures } from './test-doubles/installation.ts';
import { RoomInstallation } from '../components/room-installation.tsx';
import { DEFAULT_CONFIG } from './room-types.ts';
import { VOICE_LINES } from './room-voice.ts';

/**
 * The installation, running, with every device replaced by a double.
 *
 * `installation-rendering.test.ts` proves it draws. This proves it runs: that
 * the threshold screen holds the sensors closed until someone asks, that a
 * granted camera becomes tracks and a refused one becomes an explanation, that
 * the operator's keys do what the wall tells a visitor they do, and that
 * closing the room lets go of the stream, the loop and the timers.
 *
 * Nothing here touches a real camera, microphone, GPU or store.
 */

const settled = { ...DEFAULT_CONFIG, hardwareProfile: 'CHEAP' as const, visualEngine: 'swarm' as const };

/** Enter the room and let the background model settle on an empty gallery. */
async function enterAndWarm(room: Awaited<ReturnType<typeof mountInstallation>>) {
  await room.click(room.button(/Enter the room/));
  await room.settle(5);
  room.look(() => 40);
  await room.advance(120, 40);
  await room.settle(5);
  await room.tick();
}

void test('nothing is opened until a visitor asks for the room', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    // The threshold screen is a static page, and the promise it makes — that
    // the camera is not on yet — is the one the whole privacy claim rests on.
    assert.match(room.text(), /The room remembers you\./);
    assert.match(room.text(), /No video is kept/);
    assert.equal(room.constraints.length, 0, 'no device was asked for before anyone entered');
    assert.equal(room.cameraStreams.length, 0);

    await room.click(room.button(/Enter the room/));
    await room.settle(5);
    assert.match(room.text(), /Allow the camera and microphone/);
    assert.equal(room.cameraStreams.length, 1);
    assert.equal(room.microphoneStreams.length, 1);

    // Video and audio are asked for separately, so a refused microphone does
    // not also cost the room its camera.
    assert.equal(room.constraints.filter((request) => request.video && !request.audio).length, 1);
    assert.equal(room.constraints.filter((request) => request.audio && !request.video).length, 1);
  } finally { await room.close(); }
});

void test('a granted camera turns a moving figure into one tracked body', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    await room.key('d');
    assert.match(room.text(), /What the machine sees/, 'the instrument must open on its own key');

    // Walk a figure across the room. A cell needs two frames of persistence
    // before it counts, and a detection needs two sightings before it is a
    // person, so nothing here can be a single-frame artefact.
    for (let step = 0; step < 40; step += 1) {
      room.look(figure(0.3 + step * 0.006));
      await room.advance(120);
    }
    await room.tick();
    const text = room.text();
    assert.match(text, /Detector\s*tracking/, 'the background model must have settled');
    assert.match(text, /input: camera/);
    assert.equal(text.match(/Bodies(\d+)/)?.[1], '1', 'one walking figure is one body');
    assert.equal(text.match(/Tracks(\d+) live · (\d+) hidden/)?.[1], '1');
    assert.equal(text.match(/Tracks(\d+) live · (\d+) hidden/)?.[2], '0', 'nothing may be held for occlusion here');

    // And it must leave the room again when they go, rather than lingering as
    // a phantom for as long as the installation runs.
    room.look(() => 40);
    await room.advance(120, 60);
    await room.tick();
    assert.equal(room.text().match(/Tracks(\d+) live/)?.[1], '0', 'the visitor left and the track did not');
  } finally { await room.close(); }
});


void test('a refused camera explains itself instead of looking like an empty gallery', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled, deny: { camera: true } });
  try {
    await room.click(room.button(/Enter the room/));
    await room.settle(10);
    // "Sensing failure is silent by construction": a camera that sees nothing
    // renders exactly what an empty gallery renders, so it has to say so.
    assert.match(room.text(), /Camera unavailable/);
    assert.match(room.text(), /Press D/);
    assert.equal(room.cameraStreams.length, 0);
    assert.equal(room.microphoneStreams.length, 1, 'a refused camera must not cost the room its microphone');
  } finally { await room.close(); }
});

void test('a refused microphone leaves the visual memory running', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled, deny: { microphone: true } });
  try {
    await enterAndWarm(room);
    assert.equal(room.cameraStreams.length, 1);
    assert.equal(room.microphoneStreams.length, 0);
    await room.key('d');
    assert.doesNotMatch(room.text(), /Camera unavailable/);
  } finally { await room.close(); }
});

void test('a camera that is unplugged is retried rather than mourned', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    assert.equal(room.cameraStreams.length, 1);
    // Pull the cable. An unattended gallery machine has to come back by itself.
    room.cameraStreams[0].getVideoTracks()[0].end();
    await room.settle(10);
    await room.tick();
    await room.key('d');
    assert.match(room.text(), /disconnected|retry|failed|unavailable/i);
    await room.settle(2_600);
    assert.equal(room.cameraStreams.length, 2, 'the camera must be reopened without an operator');
  } finally { await room.close(); }
});

/**
 * The setting reaches the renderer, and a machine that cannot honour it still
 * draws.
 *
 * `renderer-startup.test.ts` establishes the decision; this establishes that the
 * component is actually asking it. The fixture's browser has no WebGPU, which is
 * also the gallery machine's most likely answer, so this is the fallback path in
 * the place it will really happen — and the console has to say so rather than
 * leaving an operator looking at a wall that is not what they selected.
 */
void test('selecting WebGPU where there is none falls back and says so', async () => {
  const room = await mountInstallation(h(RoomInstallation), {
    config: { ...settled, rendererBackend: 'webgpu' },
  });
  try {
    await enterAndWarm(room);
    await room.key('o');
    const text = room.text();
    assert.match(text, /WebGPU was selected but is unavailable/);
    assert.match(text, /running WebGL2 instead/);
  } finally { await room.close(); }
});

/**
 * The supervisor reads counters, not rates, and the counters have to move.
 *
 * `supervisor-beat.ts` establishes the payload; this establishes that the room
 * is actually counting. A rate can be reported by a loop that has stopped — the
 * frozen wall with a responsive browser is the failure the whole mechanism
 * exists for — and a counter that never advances is the same lie in the other
 * direction.
 */
void test('the native supervisor is told what has actually advanced', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    const beats = () => room.fetched
      .filter((request) => request.url === '/supervisor/heartbeat')
      .map((request) => JSON.parse(request.body) as Record<string, number | boolean>);
    assert.ok(beats().length > 0, 'the room must report to a supervisor on loopback');
    const first = beats().at(-1)!;
    assert.deepEqual(
      Object.keys(first).sort(),
      ['engineTick', 'entered', 'renderFrame', 'sensorFrame'],
      'the supervisor refuses any field it does not know',
    );
    assert.equal(first.entered, true);

    await room.advance(60, 40);
    await room.settle(5);
    const latest = beats().at(-1)!;
    assert.ok(
      (latest.engineTick as number) > (first.engineTick as number),
      'the world model advanced and did not say so',
    );
    assert.ok(
      (latest.renderFrame as number) > (first.renderFrame as number),
      'frames were presented and did not say so',
    );
  } finally { await room.close(); }
});

void test('the operator console opens on its key and closes on the same one', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    assert.equal(room.query('.operator-sheet'), null);
    await room.key('o');
    assert.ok(room.query('.operator-sheet'), 'O must open the console');
    assert.match(room.text(), /Surface conditions/);
    await room.key('O');
    assert.equal(room.query('.operator-sheet'), null, 'the same key must close it, in either case');
  } finally { await room.close(); }
});

void test('blackout and mute are reachable without the console, and are reversible', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: { ...settled, masterVolume: 0.4 } });
  try {
    await enterAndWarm(room);
    await room.key('o');
    const volume = () => room.queryAll('.slider-row')
      .find((row) => row.querySelector('span')?.textContent === 'Master volume')
      ?.querySelector('output')?.textContent;
    const blackout = () => room.queryAll('.toggle-row')
      .find((row) => row.querySelector('strong')?.textContent === 'Blackout')
      ?.querySelector('[role=switch]')?.getAttribute('aria-checked');

    assert.equal(blackout(), 'false');
    await room.key('b');
    assert.equal(blackout(), 'true', 'B must black the room out');
    await room.key('b');
    assert.equal(blackout(), 'false', 'and must bring it back');

    assert.equal(volume(), '0.4');
    await room.key('m');
    assert.equal(volume(), '0');
    // Unmuting must restore the level the operator had set, not a default.
    await room.key('m');
    assert.equal(volume(), '0.4');
  } finally { await room.close(); }
});

void test('resetting the room needs the whole gesture, not a stray R', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    await room.key('o');
    const lastEvent = () => room.query('.last-event')?.textContent ?? '';
    const before = lastEvent();
    await room.key('r');
    await room.key('r', { altKey: true });
    await room.key('r', { shiftKey: true });
    await room.settle(5);
    await room.tick();
    assert.equal(lastEvent(), before, 'a partial gesture must not empty the room');

    await room.key('r', { altKey: true, shiftKey: true });
    await room.settle(20);
    await room.tick();
    assert.notEqual(lastEvent(), before, 'the full gesture must actually reset');
    assert.match(lastEvent(), /erased|forgot|reset/i);
  } finally { await room.close(); }
});

void test('the console can erase the room, and asks first', async () => {
  // The one irreversible control in the piece. It is behind a confirmation, so
  // the confirmation is part of what has to work: a dialog that opens and whose
  // action does nothing leaves an operator believing the room was cleared.
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    await room.key('o');
    const lastEvent = () => room.query('.last-event')?.textContent ?? '';
    const before = lastEvent();
    await room.click(room.button(/Reset room memory/));
    await room.click(room.button(/Keep memory/));
    await room.settle(20);
    await room.tick();
    assert.equal(lastEvent(), before, 'declining the confirmation must keep the memory');

    await room.click(room.button(/Reset room memory/));
    await room.click(room.button(/Forget everything/));
    await room.settle(20);
    await room.tick();
    assert.match(lastEvent(), /erased|forgot|reset/i);
  } finally { await room.close(); }
});

void test('calibration needs a body on the marker, counts four, and can be abandoned', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    await room.key('o');
    await room.click(room.button(/Begin spatial calibration/));
    assert.ok(room.button(/Capture marker 1 with Space/), 'the operator must be told which marker they are on');

    // Four camera-to-projector pairs are only meaningful if each was taken
    // while somebody was standing on the marker. An empty room must not
    // silently record the origin four times and call the result a mapping.
    await room.key(' ', { code: 'Space' });
    await room.tick();
    assert.match(room.query('.last-event')?.textContent ?? '', /needs one visible body/);
    assert.ok(room.button(/Capture marker 1 with Space/), 'an empty capture must not advance the count');

    // Walk somebody in, and step through the remaining markers.
    for (let step = 0; step < 30; step += 1) {
      room.look(figure(0.35 + step * 0.006));
      await room.advance(120);
    }
    await room.tick();
    for (const marker of [1, 2, 3]) {
      await room.key(' ', { code: 'Space' });
      assert.ok(room.button(new RegExp(`Capture marker ${marker + 1} with Space`)), `marker ${marker} did not advance`);
    }
    // Escape abandons it rather than leaving a half-captured mapping in force.
    await room.key('Escape');
    assert.ok(room.button(/Begin spatial calibration/), 'Escape must abandon calibration');
    await room.key('d');
    await room.tick();
    assert.match(room.text(), /Calibrated\s*identity/, 'an abandoned calibration must not be applied');
  } finally { await room.close(); }
});


void test('the tracking overlay is its own key, so it can be checked from the wall', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    // The overlay is drawn, not rendered, so what is observable from here is
    // that the key is handled at all and the loop keeps running under it.
    await room.key('t');
    await room.advance(120, 3);
    assert.ok(room.pendingFrames > 0, 'the draw loop must survive the overlay being turned on');
    await room.key('t');
    await room.advance(120, 3);
    assert.ok(room.pendingFrames > 0);
  } finally { await room.close(); }
});

void test('demo motion answers the pointer when there is no camera', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: { ...settled, demoMode: true }, deny: { camera: true } });
  try {
    await room.click(room.button(/Enter the room/));
    await room.settle(10);
    await room.advance(120, 20);
    // Move continuously: one event expires after 180 ms of analysis time.
    for (let step = 0; step < 10; step += 1) {
      await room.pointer(400 + step, 300);
      await room.advance(120);
    }
    await room.tick();
    await room.key('d');
    await room.tick();
    // With no camera at all the room must still have something to answer, or
    // the fallback is a setting that does nothing.
    assert.match(room.text(), /input: demo/);
    const bodies = room.text().match(/Bodies(\d+)/)?.[1];
    assert.equal(bodies, '1', 'the pointer must reach the room as a body');
  } finally { await room.close(); }
});

void test('the gallery day can be opened and closed from the console', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    await room.key('o');
    const cycle = () => room.queryAll('.status-item')
      .find((node) => node.textContent?.includes('Gallery cycle'))?.textContent ?? '';
    await room.click(room.button(/Close gallery day/));
    await room.settle(5);
    await room.tick();
    assert.match(cycle(), /closing/, 'closing must be visible while it happens');
    await room.click(room.button(/Open gallery day/));
    await room.settle(5);
    await room.tick();
    assert.match(cycle(), /day \d+ · (open|active)/);
  } finally { await room.close(); }
});

void test('two visitors are tracked as two, not merged into one or split into a crowd', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    await room.key('d');
    // Well apart, so neither the column-merge rule nor box overlap can join
    // them, and both moving, so both are confirmed. Under-counting is the
    // silent failure: two people reported as one produces exactly what a
    // quieter gallery produces, and half the room's repertoire needs two.
    for (let step = 0; step < 40; step += 1) {
      room.look(figures(0.2 + step * 0.004, 0.75 - step * 0.004));
      await room.advance(120);
    }
    await room.tick();
    const text = room.text();
    assert.equal(text.match(/Bodies(\d+)/)?.[1], '2', 'two figures were not two bodies');
    assert.equal(text.match(/Tracks(\d+) live/)?.[1], '2');
  } finally { await room.close(); }
});


void test('closing the room lets go of the camera, the loop and its timers', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    assert.ok(room.pendingFrames > 0);
    assert.equal(room.cameraStreams[0].getTracks().every((track) => track.stopped), false);
  } finally {
    await room.close();
  }
  // Asserted after close on purpose: an installation that keeps the camera
  // open after the page has gone is a light on a camera in an empty gallery.
  assert.equal(room.pendingFrames, 0, 'unmount must retire the draw loop');
  assert.ok(room.cameraStreams.every((stream) => stream.getTracks().every((track) => track.stopped)),
    'unmount must release the camera');
  assert.ok(room.microphoneStreams.every((stream) => stream.getTracks().every((track) => track.stopped)),
    'unmount must release the microphone');
});

/** A path across the room, as a ghost holds one. */
const walk = (id: string, day = 1) => ({
  id,
  // Recent: `trimExpired` discards anything older than the operator's retention
  // window, and a ghost dated to the epoch is discarded before it is ever seen.
  createdAt: Date.now() - 60_000,
  lastReplayedAt: 0,
  path: Array.from({ length: 24 }, (_, step) => ({ x: 0.15 + step * 0.03, y: 0.45 + Math.sin(step / 3) * 0.06, t: step * 200 })),
  dwellSeconds: 6,
  intensity: 0.5,
  strength: 0.5,
  fidelity: 1,
  recallCount: 0,
  lineage: [id],
  falseMemory: false,
  day,
});

void test('the room comes back holding what it remembered before the page closed', async () => {
  const room = await mountInstallation(h(RoomInstallation), {
    config: settled,
    remembered: {
      field: Array.from({ length: 64 * 36 }, (_, index) => (index % 7 === 0 ? 0.4 : 0)),
      ghosts: [walk('first'), walk('second')],
      whispers: [{
        id: 'voice', createdAt: Date.now() - 60_000, lastReplayedAt: 0, envelope: [0.2, 0.6, 0.3, 0.1],
        duration: 900, brightness: 0.4, position: { x: 0.4, y: 0.5 }, strength: 0.4, fidelity: 1, recallCount: 0,
        lineage: ['voice'], day: 1,
      }],
      installationStartedAt: 1,
      savedAt: 2,
      day: 3,
      lifecycle: 'active',
      debugEvents: [],
    },
  });
  try {
    await enterAndWarm(room);
    await room.key('o');
    const cycle = room.queryAll('.status-item').find((node) => node.textContent?.includes('Gallery cycle'))?.textContent;
    assert.match(cycle ?? '', /day 3/, 'the gallery day must survive a restart');
    const forms = room.queryAll('.status-item').find((node) => node.textContent?.includes('Remembered forms'))?.textContent ?? '';
    // At least the two that were saved: a visitor who arrives during the test
    // can leave a third, and what is being held here is that nothing was lost.
    assert.ok(Number(forms.match(/(\d+) paths/)?.[1]) >= 2, forms);
    assert.match(forms, /· 1 sounds/, 'the held whisper did not come back');
    // The field came back too: a room that reloads to a blank wall has
    // forgotten everybody who visited today.
    await room.key('o');
    await room.key('d');
    await room.tick();
    assert.doesNotMatch(room.text(), /Memory field64×36 · 0\.0%/, 'the memory field came back empty');
  } finally { await room.close(); }
});

void test('a room full of memory surfaces one of its paths to a visitor who stays', async () => {
  const room = await mountInstallation(h(RoomInstallation), {
    config: { ...settled, ghostFrequency: 1 },
    remembered: {
      field: Array.from({ length: 64 * 36 }, () => 0.2),
      ghosts: [walk('first'), walk('second')],
      whispers: [],
      installationStartedAt: Date.now() - 60_000,
      savedAt: Date.now(),
      day: 1,
      lifecycle: 'active',
      debugEvents: [],
    },
  });
  try {
    await enterAndWarm(room);
    // Arrive, then stay. Recall is rolled against wall-clock time rather than
    // per analysis tick, which is what keeps the room's pace the same on every
    // hardware profile — so this is a stretch of time, not a count of frames.
    for (let step = 0; step < 20; step += 1) {
      room.look(figure(0.3 + step * 0.008));
      await room.advance(150);
    }
    room.look(figure(0.46));
    await room.advance(200, 400);
    await room.tick();
    await room.key('o');
    assert.match(
      room.query('.last-event')?.textContent ?? '',
      /resurfaced|stillness|remember|trace|recall|convergence/i,
      'a room holding two paths, with somebody in it, showed neither',
    );
    // Whatever surfaced is rendered as a body, not as a marker: the only text
    // the projection may carry is one of the room's own lines, and even that is
    // rare. Anything else on the stage would be a caption for the work.
    const spoken = room.query('.room-utterance')?.textContent;
    if (spoken) {
      const vocabulary = Object.values(VOICE_LINES).flat();
      assert.ok(vocabulary.includes(spoken), `the projection carried text the room has no line for: ${spoken}`);
    }
    assert.equal(
      room.queryAll('.projection-stage > :not(canvas):not(.projection-swarm):not(.room-utterance)').length,
      0,
      'nothing but the surfaces and the room\'s own line may be on the stage',
    );
    // `.projection-swarm` is on that list because it is a surface: a positioned
    // wrapper whose canvas `GpuSurface` replaces, since a canvas is consumed by
    // the first graphics API it is asked for. It is allowed to be on the stage
    // for exactly that reason and for no other, so it may hold nothing else.
    assert.deepEqual(
      room.queryAll('.projection-swarm > *').map((node) => node.nodeName),
      room.queryAll('.projection-swarm > canvas').map((node) => node.nodeName),
      'the particle field\'s wrapper may hold canvases and nothing else',
    );
  } finally { await room.close(); }
});


void test('a recorded session can be exported, replayed, and imported back', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: { ...settled, recordDebugEvents: true } });
  try {
    await enterAndWarm(room);
    // Record a walk. Events are sampled at most once a second.
    for (let step = 0; step < 60; step += 1) {
      room.look(figure(0.25 + step * 0.008));
      await room.advance(300);
    }
    await room.tick();
    await room.key('o');
    const exportButton = room.button(/Export JSON/) as HTMLButtonElement;
    assert.equal(exportButton.disabled, false, 'a recorded session must be exportable');
    await room.click(exportButton);
    await room.tick();
    assert.match(room.query('.last-event')?.textContent ?? '', /exported/);

    await room.click(room.button(/Replay events/));
    await room.tick();
    assert.match(room.query('.last-event')?.textContent ?? '', /replay/i);
    // A replay drives the room from the recording rather than from the camera.
    room.look(() => 40);
    await room.advance(120, 10);
    await room.key('d');
    await room.tick();
    assert.match(room.text(), /input: replay/, 'the replay must displace the live camera, not add to it');
  } finally { await room.close(); }
});

void test('an imported replay is validated before it is allowed to drive the room', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    await room.key('o');
    const input = room.query('.import-button input') as HTMLInputElement;
    const importFile = async (body: string) => {
      const file = new room.window.File([body], 'events.json', { type: 'application/json' });
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      await room.change(input);
      await room.settle(20);
      await room.tick();
    };

    // Coordinates from a file are data, never instructions. A malformed or
    // hostile file must be refused rather than replayed.
    await importFile('not json at all');
    assert.match(room.query('.last-event')?.textContent ?? '', /could not|invalid|refus|not a/i);
    await importFile(JSON.stringify({ version: 1, kind: 'something-else', events: [] }));
    assert.match(room.query('.last-event')?.textContent ?? '', /could not|invalid|refus|not a/i);

    await importFile(JSON.stringify({
      version: 1,
      kind: 'anonymous-room-events',
      events: [{ t: 0, people: [['a', 0.3, 0.5, 0.01, 0, 0.02, 0]] }, { t: 1000, people: [['a', 0.6, 0.5, 0.01, 0, 0.02, 0]] }],
    }));
    assert.match(room.query('.last-event')?.textContent ?? '', /replay|import/i);
  } finally { await room.close(); }
});

void test('a machine with no WebGL2 draws the room on the fallback surface', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled, gpu: false });
  try {
    await enterAndWarm(room);
    for (let step = 0; step < 20; step += 1) {
      room.look(figure(0.3 + step * 0.008));
      await room.advance(120);
    }
    const overlay = room.query('.projection-traces') as HTMLCanvasElement;
    assert.ok(room.painted.some((call) => call.canvas === overlay && call.method === 'fillRect'),
      'with no GPU the room must still be drawn, not left black');
    await room.key('d');
    await room.tick();
    assert.match(room.text(), /Canvas 2D/, 'and must say which renderer it fell back to');
  } finally { await room.close(); }
});

void test('blackout clears the wall and leaving it starts drawing again', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled, gpu: false });
  try {
    await enterAndWarm(room);
    await room.advance(120, 5);
    const overlay = room.query('.projection-traces') as HTMLCanvasElement;

    await room.key('b');
    room.painted.length = 0;
    await room.advance(120, 5);
    const during = room.painted.filter((call) => call.canvas === overlay);
    assert.ok(during.length > 0, 'the loop must keep running under blackout');
    assert.ok(!during.some((call) => call.method === 'fillRect' && call.args[0] !== 0),
      'nothing but the clear may reach the wall during a blackout');

    await room.key('b');
    room.painted.length = 0;
    await room.advance(120, 5);
    assert.ok(room.painted.some((call) => call.canvas === overlay && call.method === 'fillRect'),
      'leaving blackout must bring the room back');
  } finally { await room.close(); }
});

void test('the simulation drives a whole gallery day without a camera', async () => {
  const room = await mountInstallation(h(RoomInstallation), {
    config: { ...settled, simulationRate: 720 },
    deny: { camera: true },
  });
  try {
    await room.click(room.button(/Enter the room/));
    await room.settle(10);
    await room.advance(120, 60);
    await room.key('d');
    await room.tick();
    assert.match(room.text(), /input: simulation/);
    // A simulated visitor is a visitor as far as everything downstream is
    // concerned, which is what makes the twelve-hour burn-in mean anything.
    assert.ok(Number(room.text().match(/Bodies(\d+)/)?.[1]) >= 1, 'the simulation put nobody in the room');
  } finally { await room.close(); }
});

void test('the sensing log can be exported for a session that is not going well', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    for (let step = 0; step < 30; step += 1) {
      room.look(figure(0.3 + step * 0.008));
      await room.advance(300);
    }
    await room.key('o');
    await room.key('d');
    await room.tick();
    const exportLog = room.button(/Export sensing log/);
    assert.ok(exportLog, 'the instrument must be able to hand the operator its samples');
    assert.match(exportLog.textContent ?? '', /\d+ samples/);
    await room.click(exportLog);
    await room.tick();
    assert.match(room.query('.last-event')?.textContent ?? '', /log|export/i);
  } finally { await room.close(); }
});

void test('auditioning says so when the room is holding no voices at all', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    await room.key('o');
    await room.click(room.button(/Play remembered whispers/));
    await room.tick();
    // Waiting never answers "is there anything in there"; silence has to.
    assert.match(room.query('.last-event')?.textContent ?? '', /no voice recordings/i);
  } finally { await room.close(); }
});

void test('the fallback surface draws recalls, trails, ambient drift and the closing montage', async () => {
  // Everything the room puts on the wall other than the particle field is
  // drawn here, by the 2D renderer, and none of it was ever executed by a
  // test: a recall's body and trail, the ambient drift of an empty gallery,
  // the tracking overlay, the calibration markers, and the montage that closes
  // a gallery day. A throw in any of them takes the whole installation with it
  // and leaves a dark room, which is what a dark room looks like.
  const room = await mountInstallation(h(RoomInstallation), {
    config: { ...settled, ghostFrequency: 1, whisperFrequency: 1, visualEngine: 'traces' },
    gpu: false,
    remembered: {
      field: Array.from({ length: 64 * 36 }, (_, index) => 0.1 + (index % 11) * 0.02),
      ghosts: [walk('first'), walk('second'), walk('third')],
      whispers: [],
      installationStartedAt: Date.now() - 600_000,
      savedAt: Date.now(),
      day: 2,
      lifecycle: 'active',
      debugEvents: [],
    },
  });
  try {
    await enterAndWarm(room);
    const overlay = room.query('.projection-traces') as HTMLCanvasElement;
    const drawn = () => room.painted.filter((call) => call.canvas === overlay).length;

    // A visitor arrives, walks, and stays: recalls are rolled against
    // wall-clock time, so this is a stretch of gallery time.
    for (let step = 0; step < 24; step += 1) {
      room.look(figure(0.28 + step * 0.008));
      await room.advance(150);
    }
    room.look(figure(0.48));
    const before = drawn();
    await room.advance(200, 300);
    assert.ok(drawn() > before, 'the wall must keep being painted while somebody is in the room');

    // The tracking overlay and the calibration markers are drawn over the top
    // of all of that.
    await room.key('t');
    await room.advance(150, 10);
    await room.key('o');
    await room.click(room.button(/Begin spatial calibration/));
    await room.advance(150, 10);
    assert.ok(room.button(/Capture marker 1 with Space/));

    // Four markers complete the mapping, and the room says so.
    for (const marker of [0, 1, 2, 3]) {
      room.look(figure(0.3 + marker * 0.12, 0.35 + marker * 0.08));
      await room.advance(150, 12);
      await room.key(' ', { code: 'Space' });
    }
    await room.tick();
    assert.match(room.query('.last-event')?.textContent ?? '', /aligned|calibrat/i);
    assert.ok(room.button(/Begin spatial calibration/), 'a completed calibration leaves calibration mode');
    await room.key('d');
    await room.tick();
    assert.doesNotMatch(room.text(), /Calibrated\s*identity/, 'four markers must produce a real mapping');

    // Closing the day surfaces one of its own memories as a montage.
    await room.key('d');
    await room.click(room.button(/Close gallery day/));
    await room.advance(200, 60);
    await room.tick();
    assert.match(room.query('.last-event')?.textContent ?? '', /closing/);
    assert.ok(drawn() > before, 'the montage must reach the wall');
  } finally { await room.close(); }
});

void test('an empty gallery keeps drawing rather than going dark', async () => {
  const room = await mountInstallation(h(RoomInstallation), {
    config: { ...settled, visualEngine: 'traces' },
    gpu: false,
    remembered: {
      field: Array.from({ length: 64 * 36 }, () => 0.15),
      ghosts: [walk('first')],
      whispers: [],
      installationStartedAt: Date.now() - 900_000,
      savedAt: Date.now(),
      day: 1,
      lifecycle: 'active',
      debugEvents: [],
    },
  });
  try {
    await enterAndWarm(room);
    const overlay = room.query('.projection-traces') as HTMLCanvasElement;
    room.painted.length = 0;
    // Nobody in the room, for several minutes of gallery time. This is the
    // state the piece is in for most of its life, and it is the state a
    // stopped renderer is indistinguishable from.
    await room.advance(250, 200);
    const calls = room.painted.filter((call) => call.canvas === overlay);
    assert.ok(calls.length > 0, 'an empty gallery must still be painted');
    assert.ok(calls.some((call) => call.method === 'fillRect'), 'and the memory it holds must be on the wall');
  } finally { await room.close(); }
});

void test('a microphone disconnect reopens audio without reopening the camera', async () => {
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    room.microphoneStreams[0].getAudioTracks()[0].end();
    await room.settle(2_600);
    await room.tick();
    assert.equal(room.microphoneStreams.length, 2);
    assert.equal(room.cameraStreams.length, 1);
    assert.equal(room.microphoneStreams[1].getAudioTracks()[0].stopped, false);
  } finally { await room.close(); }
  assert.ok(room.microphoneStreams.every(stream => stream.getTracks().every(track => track.stopped)));
});

void test('every microphone a gallery day drops is released, not just the last one', async () => {
  // The single-drop case above passes even when the dead stream is abandoned,
  // because unmount stops whatever `microphoneStreamRef` happens to hold. Only
  // a second drop separates "the current stream is released" from "every stream
  // is", and a USB microphone in a twelve-hour room drops more than once.
  const room = await mountInstallation(h(RoomInstallation), { config: settled });
  try {
    await enterAndWarm(room);
    for (let drop = 0; drop < 3; drop += 1) {
      const live = room.microphoneStreams.at(-1)!;
      live.getAudioTracks()[0].end();
      await room.settle(2_600);
      await room.tick();
      assert.equal(room.microphoneStreams.length, drop + 2, `drop ${drop + 1} did not reopen`);
      // Each dead stream is released as it dies, rather than banked until close.
      assert.ok(
        live.getTracks().every((track) => track.stopped),
        `the stream dropped at ${drop + 1} was left open`,
      );
      assert.equal(room.microphoneStreams.at(-1)!.getAudioTracks()[0].stopped, false);
    }
    // A microphone dropping must never reopen the camera.
    assert.equal(room.cameraStreams.length, 1);
  } finally { await room.close(); }
  assert.ok(
    room.microphoneStreams.every((stream) => stream.getTracks().every((track) => track.stopped)),
    'a microphone was still open after the room closed',
  );
});

/** A room that was already holding a voice when the page opened. */
const withOneWhisper = (whisperFrequency: number) => ({
  config: { ...settled, whisperFrequency },
  remembered: {
    field: Array.from({ length: 64 * 36 }, () => 0),
    ghosts: [],
    whispers: [{
      id: 'voice', createdAt: Date.now() - 600_000, lastReplayedAt: 0, envelope: [0.2, 0.6, 0.3, 0.1],
      duration: 900, brightness: 0.4, position: { x: 0.4, y: 0.5 }, strength: 0.4, fidelity: 1,
      recallCount: 0, lineage: ['voice'], day: 1,
    }],
    installationStartedAt: 1,
    savedAt: 2,
    day: 1,
    lifecycle: 'active' as const,
    debugEvents: [],
  },
});

void test('a room switched off says so instead of simply staying quiet', async () => {
  // The failure this exists for: whispers held, the console's audition button
  // playing them on demand, and the piece never surfacing one by itself. Both
  // whisper counters read healthy throughout, so the instrument has to name the
  // refusal or there is nothing to tell an operator apart from silence.
  const room = await mountInstallation(h(RoomInstallation), withOneWhisper(0));
  try {
    await enterAndWarm(room);
    await room.key('d');
    await room.advance(120, 20);
    await room.tick();
    assert.match(room.text(), /frequency is zero/);
  } finally { await room.close(); }
});

void test('a room that is merely waiting does not report itself as switched off', async () => {
  // At a live setting the same panel must say something else, or the notice is
  // decoration. A whisper restored from storage has a texture and no voice —
  // the PCM never leaves RAM — so the honest answer here is that nothing is
  // ripe, which the room could not previously say either.
  const room = await mountInstallation(h(RoomInstallation), withOneWhisper(0.4));
  try {
    await enterAndWarm(room);
    await room.key('d');
    await room.advance(120, 20);
    await room.tick();
    const text = room.text();
    assert.doesNotMatch(text, /frequency is zero/);
    assert.match(text, /nothing ripe yet|not this time/);
  } finally { await room.close(); }
});

void test('a selected camera is requested exactly and failure identifies the selection', async () => {
  const room = await mountInstallation(h(RoomInstallation), {
    config: { ...settled, cameraDeviceId: 'gallery-camera' }, deny: { camera: true },
  });
  try {
    await room.click(room.button(/Enter the room/));
    await room.settle(10);
    await room.key('o');
    await room.tick();
    // Asserted before it is read: without the request there is no `video` to
    // reach through, and "cannot read deviceId of undefined" names the symptom
    // rather than the cause — that the camera was never asked for at all.
    const videoRequest = room.constraints.find((request) => request.video);
    assert.ok(videoRequest, 'no camera was requested');
    assert.deepEqual((videoRequest.video as MediaTrackConstraints).deviceId, { exact: 'gallery-camera' });
    assert.match(room.text(), /Camera unavailable/);
    assert.equal(room.cameraStreams.length, 0);
  } finally { await room.close(); }
});

void test('a restored older snapshot supplies defaults for absent day and lifecycle', async () => {
  const room = await mountInstallation(h(RoomInstallation), {
    config: settled,
    remembered: { field: [], ghosts: [], whispers: [], installationStartedAt: 0, savedAt: 1 },
  });
  try {
    await room.settle(10);
    await room.key('o');
    await room.tick();
    assert.match(room.text(), /day 1 · after-hours/);
    assert.match(room.text(), /older memory restored/);
  } finally { await room.close(); }
});
