import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import { mount, click, act, dom } from './test-doubles/dom.ts';
import { OperatorConsole } from '../components/operator-console.tsx';
import { DEFAULT_CONFIG, type RoomConfig, type RuntimeStatus } from './room-types.ts';
import { healthyStatus } from './test-doubles/status.ts';

/**
 * The console the operator actually uses, driven through its own controls.
 *
 * Every setting here reaches the running installation through one callback,
 * and a control wired to the wrong key — or to nothing — renders exactly like
 * a working one. The console had no test of its own: its markup was covered
 * by whatever happened to render it, and eleven percent of its functions were
 * ever called, which meant every slider, select, switch and button in it was a
 * claim nothing checked.
 *
 * Nothing here touches a camera, a microphone or storage. The status is the
 * synthetic one.
 */

type Recorded = {
  patches: Array<Partial<RoomConfig>>;
  calls: string[];
  imported: File[];
};

async function openConsole(overrides: {
  config?: Partial<RoomConfig>;
  status?: Partial<RuntimeStatus>;
  calibrationStep?: number | null;
  cameras?: Array<{ deviceId: string; label: string }>;
} = {}) {
  const recorded: Recorded = { patches: [], calls: [], imported: [] };
  const record = (name: string) => () => { recorded.calls.push(name); };
  let config = { ...DEFAULT_CONFIG, ...overrides.config };
  let rerender: (() => Promise<void>) | null = null;
  const props = () => ({
    open: true,
    onOpenChange: (next: boolean) => { recorded.calls.push(`open:${next}`); },
    config,
    status: { ...healthyStatus(), ...overrides.status },
    // The console is a controlled surface: it draws whatever config it is
    // handed. Feeding the patch back is what the installation does, and it is
    // the only way a bound reached from below reads as a bound rather than as
    // a change that happens to repeat.
    onConfig: (patch: Partial<RoomConfig>) => {
      recorded.patches.push(patch);
      config = { ...config, ...patch };
      void rerender?.();
    },
    onReset: record('reset'),
    onRelearnMotion: record('relearn'),
    calibrationStep: overrides.calibrationStep ?? null,
    onStartCalibration: record('calibrate'),
    onOpenDay: record('openDay'),
    onCloseDay: record('closeDay'),
    onExportDebug: record('export'),
    onReplayDebug: record('replay'),
    onImportDebug: (file: File) => { recorded.imported.push(file); },
    onAuditionWhispers: record('audition'),
    cameras: overrides.cameras ?? [],
  });
  const view = await mount(h(OperatorConsole, props()));
  rerender = async () => { await view.render(h(OperatorConsole, props())); };
  return { view, recorded, config: () => config };
}

const panel = () => document.querySelector('.operator-sheet')!;
const buttons = () => [...panel().querySelectorAll('button')];
const button = (text: RegExp) => buttons().find((node) => text.test(node.textContent ?? ''))!;
const rowFor = (label: string) => [...panel().querySelectorAll('label')].find((node) => node.querySelector('span')?.textContent === label)!;

/**
 * Move a slider with the keyboard.
 *
 * The keyboard is the honest way to drive one here: dragging needs measured
 * geometry, and a slider an operator can only drag is one they cannot set
 * precisely in a dark gallery anyway. Base UI puts the value on a visually
 * hidden input, which is what takes the key.
 */
async function nudge(label: string, key: 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End') {
  const thumb = rowFor(label).querySelector('input') as HTMLElement;
  assert.ok(thumb, `no slider for ${label}`);
  await act(async () => { thumb.focus(); });
  await act(async () => {
    thumb.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

async function choose(label: string, value: string) {
  const select = rowFor(label).querySelector('select') as HTMLSelectElement;
  assert.ok(select, `no select for ${label}`);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}

void test('the console reports the room back to the operator, in units they can act on', async () => {
  const { view } = await openConsole({
    status: {
      people: 3, fps: 24.25, renderLoad: 91.5, storageBytes: 2_500_000, emptySeconds: 125,
      currentDay: 4, lifecycle: 'closing', ghostCount: 11, whisperCount: 2, camera: 'failed',
    },
  });
  try {
    const text = panel().textContent!;
    assert.match(text, /day 4 · closing/);
    assert.match(text, /11 paths · 2 sounds/);
    assert.match(text, /24\.3 fps/, 'frame rate is rounded for reading, not truncated');
    assert.match(text, /91\.5%/);
    assert.match(text, /2\.4 MB/, 'bytes are reported in a unit an operator can judge');
    assert.match(text, /2 min/, 'an empty room is reported in minutes once it passes one');

    // The status dot is the only thing separating working from broken at a
    // glance, so it must track the value beside it rather than always being lit.
    const items = [...panel().querySelectorAll('.status-item')];
    const camera = items.find((node) => node.textContent?.includes('Camera'))!;
    assert.equal(camera.querySelector('.status-dot')?.className.includes('is-good'), false);
    const load = items.find((node) => node.textContent?.includes('Render load'))!;
    assert.equal(load.querySelector('.status-dot')?.className.includes('is-good'), false, '91.5% load is not good');
  } finally { await view.close(); }
});

void test('small durations and sizes are reported in their own units, not rounded to nothing', async () => {
  const { view } = await openConsole({
    status: { storageBytes: 900, emptySeconds: 12.7, fps: 60, renderLoad: 12 },
  });
  try {
    const text = panel().textContent!;
    assert.match(text, /900 B/, 'a small store is bytes, not 0 KB');
    assert.match(text, /12 sec/, 'under a minute is seconds, not 0 min');
    const items = [...panel().querySelectorAll('.status-item')];
    assert.ok(items.find((node) => node.textContent?.includes('Frame rate'))?.querySelector('.is-good'));
  } finally { await view.close(); }
});

void test('a kilobyte-scale store reports as kilobytes', async () => {
  const { view } = await openConsole({ status: { storageBytes: 2048 } });
  try {
    assert.match(panel().textContent!, /2 KB/);
  } finally { await view.close(); }
});

void test('every slider writes to its own configuration key', async () => {
  // A slider bound to the wrong key looks and behaves identically. The whole
  // set is walked because a defect in one of these is a defect in the pattern.
  const expected: Array<[string, keyof RoomConfig]> = [
    ['Movement sensitivity', 'motionSensitivity'],
    ['Scene-change limit', 'sceneChangeCoverage'],
    ['Memory half-life', 'memoryMinutes'],
    ['Surface intensity', 'visualIntensity'],
    ['Forgetting time', 'forgettingMinutes'],
    ['Ghost frequency', 'ghostFrequency'],
    ['Whisper threshold', 'microphoneThreshold'],
    ['Whisper frequency', 'whisperFrequency'],
    ['Master volume', 'masterVolume'],
    ['Crop', 'crop'],
    ['Keystone — horizontal', 'keystoneX'],
    ['Keystone — vertical', 'keystoneY'],
    ['Projection rotation', 'rotation'],
    ['Automatic expiration', 'persistenceDays'],
  ];
  const { view, recorded } = await openConsole();
  try {
    for (const [label, key] of expected) {
      recorded.patches.length = 0;
      await nudge(label, 'ArrowRight');
      assert.equal(recorded.patches.length, 1, `${label} reported ${recorded.patches.length} changes`);
      const [patch] = recorded.patches;
      assert.deepEqual(Object.keys(patch), [key], `${label} wrote ${Object.keys(patch).join()}`);
      assert.equal(typeof patch[key], 'number', `${label} sent a ${typeof patch[key]}`);
      assert.ok(Number.isFinite(patch[key] as number));
    }
  } finally { await view.close(); }
});

void test('a slider labelled for more of something sends more of it', async () => {
  // The label→key test above cannot see this: a control whose label means the
  // opposite of its value reads correctly, writes the right key, and quietly
  // inverts the operator. Both of these were labelled "rarity" while holding a
  // frequency, so an operator who wanted whispers *less rare* dragged toward
  // zero — and zero is not "as rare as possible", it is off. Nothing in the
  // room says so, and the audition button keeps working, so the symptom is
  // whispers that exist, play on demand, and never surface on their own.
  const rising: Array<[string, keyof RoomConfig]> = [
    ['Ghost frequency', 'ghostFrequency'],
    ['Whisper frequency', 'whisperFrequency'],
    ['Master volume', 'masterVolume'],
    ['Movement sensitivity', 'motionSensitivity'],
  ];
  const { view, recorded, config } = await openConsole();
  try {
    for (const [label, key] of rising) {
      const before = config()[key] as number;
      recorded.patches.length = 0;
      await nudge(label, 'ArrowRight');
      const after = recorded.patches[0][key] as number;
      assert.ok(after > before, `${label} moved right and ${key} went from ${before} to ${after}`);
    }
  } finally { await view.close(); }
});

void test('a frequency held at zero says so, rather than going quiet', async () => {
  // Silence is what this room produces when it is working and when it is
  // switched off, so the off state has to be legible from the console.
  const { view } = await openConsole({ config: { whisperFrequency: 0, ghostFrequency: 0 } });
  try {
    const text = panel().textContent ?? '';
    assert.match(text, /never surfaces a whisper on its own/);
    assert.match(text, /never recalls a ghost on its own/);
  } finally { await view.close(); }
});

void test('a frequency above zero carries no off notice', async () => {
  const { view } = await openConsole({ config: { whisperFrequency: 0.4, ghostFrequency: 0.55 } });
  try {
    const text = panel().textContent ?? '';
    assert.doesNotMatch(text, /never surfaces a whisper on its own/);
    assert.doesNotMatch(text, /never recalls a ghost on its own/);
  } finally { await view.close(); }
});

void test('a slider will not take a setting past the bounds it is given', async () => {
  // The bounds are the only thing stopping an operator from setting a memory
  // half-life of zero on a running installation.
  const { view, recorded } = await openConsole({ config: { masterVolume: 0.35 } });
  try {
    await nudge('Master volume', 'Home');
    assert.deepEqual(recorded.patches.at(-1), { masterVolume: 0 });
    await nudge('Master volume', 'End');
    assert.deepEqual(recorded.patches.at(-1), { masterVolume: 0.7 }, 'the top of the range is the configured maximum');
    recorded.patches.length = 0;
    await nudge('Master volume', 'End');
    assert.deepEqual(recorded.patches, [], 'already at the top, there is nothing to report');
  } finally { await view.close(); }
});

void test('every switch writes a boolean to its own key, in both directions', async () => {
  const expected: Array<[string, keyof RoomConfig]> = [
    ['Spoken voice', 'speech'],
    ['Strict privacy', 'privacyMode'],
    ['Mirror camera map', 'mirrorCamera'],
    ['Demo motion', 'demoMode'],
    ['Blackout', 'blackout'],
    ['Record anonymous events', 'recordDebugEvents'],
  ];
  for (const start of [false, true]) {
    const config = Object.fromEntries(expected.map(([, key]) => [key, start])) as Partial<RoomConfig>;
    const { view, recorded } = await openConsole({ config });
    try {
      for (const [label, key] of expected) {
        recorded.patches.length = 0;
        const row = [...panel().querySelectorAll('.toggle-row')]
          .find((node) => node.querySelector('strong')?.textContent === label)!;
        const control = row.querySelector('[role=switch], button, input[type=checkbox]') as HTMLElement;
        assert.ok(control, `no switch for ${label}`);
        await click(control);
        assert.deepEqual(recorded.patches, [{ [key]: !start }], `${label} did not flip to ${!start}`);
      }
    } finally { await view.close(); }
  }
});

void test('every select writes the value the option carries, with its own type', async () => {
  const { view, recorded } = await openConsole({
    cameras: [{ deviceId: 'cam-1', label: 'Ceiling camera' }, { deviceId: 'cam-2', label: 'USB camera' }],
  });
  try {
    assert.match(panel().textContent!, /Ceiling camera/, 'granted devices must be offered by name');

    // Camera rotation and the simulation rate are numbers in the config and
    // strings in the DOM. A select that forwards the string writes "90" where
    // the sensing pipeline compares against 90 and never matches.
    await choose('Camera rotation', '270');
    assert.deepEqual(recorded.patches.at(-1), { cameraRotation: 270 });
    assert.equal(typeof recorded.patches.at(-1)!.cameraRotation, 'number');

    await choose('Gallery simulation', '720');
    assert.deepEqual(recorded.patches.at(-1), { simulationRate: 720 });
    assert.equal(typeof recorded.patches.at(-1)!.simulationRate, 'number');

    await choose('Camera', 'cam-2');
    assert.deepEqual(recorded.patches.at(-1), { cameraDeviceId: 'cam-2' });
    await choose('Visual engine', 'traces');
    assert.deepEqual(recorded.patches.at(-1), { visualEngine: 'traces' });
    // Which GPU API drives the field, and which renderer draws at all, are two
    // settings on purpose. An operator who selects WebGPU and then wonders why
    // the wall is still lines should find the answer in the other control.
    await choose('Graphics backend', 'webgpu');
    assert.deepEqual(recorded.patches.at(-1), { rendererBackend: 'webgpu' });
    await choose('Graphics backend', 'auto');
    assert.deepEqual(recorded.patches.at(-1), { rendererBackend: 'auto' });
    await choose('Projection surface', 'paper');
    assert.deepEqual(recorded.patches.at(-1), { projectionMode: 'paper' });
    await choose('Hardware profile', 'CHEAP');
    assert.deepEqual(recorded.patches.at(-1), { hardwareProfile: 'CHEAP' });
  } finally { await view.close(); }
});

void test('the console shows what the sensing pipeline is doing, cell by cell', async () => {
  const { view, recorded } = await openConsole({
    status: {
      motion: {
        width: 4, height: 2, mask: [0, 1, 2, 0, 2, 0, 0, 1], changedPercent: 6.25,
        candidateCells: 2, activeCells: 2, sceneChangeLimitPercent: 85, coveragePercent: 25,
        rejectedFraction: 0, blobCount: 1, meanLightShift: -1.5, cellsPerBody: 7,
        state: 'scene-change', source: 'camera', visibleTracks: 2, occludedTracks: 1,
      },
    },
  });
  try {
    const cells = panel().querySelectorAll('.motion-mask rect');
    // One background plus one rect per non-zero cell: the zeros are the room
    // the camera is seeing nothing in, and drawing them would fill the mask.
    assert.equal(cells.length, 1 + 4);
    assert.equal(panel().querySelectorAll('.motion-cell-accepted').length, 2);
    assert.equal(panel().querySelectorAll('.motion-cell-candidate').length, 2);
    const accepted = panel().querySelector('.motion-cell-accepted')!;
    assert.equal(accepted.getAttribute('x'), '2', 'index 2 of a four-wide grid is column 2');
    assert.equal(accepted.getAttribute('y'), '0');
    assert.equal(panel().querySelector('.motion-mask')?.getAttribute('viewBox'), '0 0 4 2');

    const text = panel().textContent!;
    assert.match(text, /scene-change/, 'a rejected frame must be visible, not silent');
    assert.match(text, /2 live · 1 hidden/);
    assert.match(text, /-1\.5/, 'the light shift is signed: a darkening room is not a brightening one');
    assert.match(text, /6\.25%|6\.3%/);

    await click(button(/Relearn empty room/));
    assert.deepEqual(recorded.calls, ['relearn']);
  } finally { await view.close(); }
});

void test('the calibration button says what to do next once calibration has begun', async () => {
  const idle = await openConsole({ calibrationStep: null });
  try {
    assert.ok(button(/Begin spatial calibration/));
    await click(button(/Begin spatial calibration/));
    assert.deepEqual(idle.recorded.calls, ['calibrate']);
  } finally { await idle.view.close(); }

  // Markers are counted from one for the person standing on them.
  for (const step of [0, 1, 2, 3]) {
    const running = await openConsole({ calibrationStep: step });
    try {
      assert.ok(button(new RegExp(`Capture marker ${step + 1} with Space`)), `step ${step} mislabelled`);
    } finally { await running.view.close(); }
  }
});

void test('the day, audition and debug actions each reach their own handler', async () => {
  const { view, recorded } = await openConsole({ status: { debugEvents: 12, audio: { ...healthyStatus().audio, held: 3 } } });
  try {
    assert.match(button(/Play remembered whispers/).textContent!, /\(3\)/, 'an operator must see whether there is anything to play');
    for (const [label, expected] of [
      [/Play remembered whispers/, 'audition'],
      [/Open gallery day/, 'openDay'],
      [/Close gallery day/, 'closeDay'],
      [/Replay events/, 'replay'],
      [/Export JSON/, 'export'],
    ] as const) {
      recorded.calls.length = 0;
      await click(button(label));
      assert.deepEqual(recorded.calls, [expected], `${label} called ${recorded.calls.join()}`);
    }
  } finally { await view.close(); }
});

void test('replay and export are unavailable while there is nothing recorded', async () => {
  const { view, recorded } = await openConsole({ status: { debugEvents: 0 } });
  try {
    for (const label of [/Replay events/, /Export JSON/] as const) {
      const control = button(label) as HTMLButtonElement;
      assert.equal(control.disabled, true, `${label} offered with nothing to act on`);
      await click(control);
    }
    assert.deepEqual(recorded.calls, [], 'a disabled control must do nothing, not merely look inert');
  } finally { await view.close(); }
});

void test('importing a replay hands over the file and then forgets it', async () => {
  const { view, recorded } = await openConsole();
  try {
    const input = panel().querySelector('.import-button input') as HTMLInputElement;
    assert.ok(input);
    assert.equal(input.accept, 'application/json,.json');
    const file = new dom.window.File(['{"events":[]}'], 'session.json', { type: 'application/json' });
    // jsdom has no DataTransfer, and a file input's `files` is read-only.
    // Defining it directly is how a chosen file is put in front of the handler.
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.equal(recorded.imported.length, 1);
    assert.equal(recorded.imported[0].name, 'session.json');
    // Cleared, so choosing the same file again is a new import rather than
    // silently nothing — which reads as a broken button.
    assert.equal(input.value, '');
  } finally { await view.close(); }
});

void test('choosing nothing in the file picker imports nothing', async () => {
  const { view, recorded } = await openConsole();
  try {
    const input = panel().querySelector('.import-button input') as HTMLInputElement;
    await act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    assert.deepEqual(recorded.imported, []);
  } finally { await view.close(); }
});

void test('forgetting the room asks first, and keeping memory does not forget it', async () => {
  const { view, recorded } = await openConsole();
  try {
    await click(button(/Reset room memory/));
    const confirm = document.querySelector('[role=alertdialog]')!;
    assert.ok(confirm, 'a destructive action must ask');
    assert.match(confirm.textContent!, /Let the room forget everything\?/);
    assert.match(confirm.textContent!, /permanently/);

    await click([...confirm.querySelectorAll('button')].find((node) => node.textContent === 'Keep memory')!);
    assert.deepEqual(recorded.calls, [], 'cancelling must not reset anything');
    assert.equal(document.querySelector('[role=alertdialog]'), null);

    await click(button(/Reset room memory/));
    const again = document.querySelector('[role=alertdialog]')!;
    await click([...again.querySelectorAll('button')].find((node) => node.textContent === 'Forget everything')!);
    assert.deepEqual(recorded.calls, ['reset']);
  } finally { await view.close(); }
});

void test('a closed console renders nothing at all', async () => {
  const recorded: string[] = [];
  const view = await mount(h(OperatorConsole, {
    open: false,
    onOpenChange: (next: boolean) => { recorded.push(`open:${next}`); },
    config: DEFAULT_CONFIG,
    status: healthyStatus(),
    onConfig: () => {}, onReset: () => {}, onRelearnMotion: () => {},
    calibrationStep: null, onStartCalibration: () => {}, onOpenDay: () => {}, onCloseDay: () => {},
    onExportDebug: () => {}, onReplayDebug: () => {}, onImportDebug: () => {},
    onAuditionWhispers: () => {}, cameras: [],
  }));
  try {
    // The console carries the room's own labels. It is not a visitor-facing
    // surface and must not be in the document, or the accessibility tree, when
    // it is closed.
    assert.equal(document.querySelector('.operator-sheet'), null);
    assert.doesNotMatch(document.body.textContent ?? '', /Surface conditions/);
  } finally { await view.close(); }
});
