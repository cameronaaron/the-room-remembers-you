import assert from 'node:assert/strict';
import test from 'node:test';
import { commissioningKey, galleryPreflight, COMMISSIONING_CONFIRMATIONS } from './commissioning.ts';
import { DEFAULT_CONFIG, type RuntimeStatus } from './room-types.ts';
import { HARDWARE_PROFILES } from './simulation.ts';
const confirmed = { empty: true, walk: true, alignment: true, sound: true };
const healthy = (): RuntimeStatus => ({ lastRenderAt: Date.now(), lastAnalysisAt: Date.now(), camera: 'ready', microphone: 'ready',
  motion: { state: 'tracking', cellsPerBody: 7 }, audio: { contextState: 'running' },
  fps: 60, analysisHz: 24 } as RuntimeStatus);
const passes = (config = DEFAULT_CONFIG, status = healthy()) => galleryPreflight(config, status, confirmed).every(check => check.passed);

void test('every profile needs measured cadence and explicit human evidence', () => {
  for (const hardwareProfile of ['CHEAP', 'STANDARD', 'FULL'] as const) {
    const config = { ...DEFAULT_CONFIG, hardwareProfile };
    const threshold = 1000 / HARDWARE_PROFILES[hardwareProfile].analysisIntervalMs * 0.8;
    assert.ok(passes(config, { ...healthy(), analysisHz: threshold }));
    assert.equal(passes(config, { ...healthy(), analysisHz: threshold - 0.0001 }), false);
  }
  assert.equal(galleryPreflight(DEFAULT_CONFIG, healthy(), {}).filter(c => !c.passed).length, 4);
  for (const id of Object.keys(confirmed)) {
    assert.equal(galleryPreflight(DEFAULT_CONFIG, healthy(), { ...confirmed, [id]: false }).find(c => c.id === id)?.passed, false);
  }
  assert.deepEqual(Object.keys(COMMISSIONING_CONFIRMATIONS), ['empty', 'walk', 'alignment', 'sound']);
});
void test('simulation, blackouts and silence cannot commission a gallery', () => {
  assert.ok(passes());
  for (const patch of [{ demoMode: true }, { simulationRate: 60 as const }, { blackout: true }, { masterVolume: 0 }, { masterVolume: -1 }]) {
    assert.equal(passes({ ...DEFAULT_CONFIG, ...patch }), false);
  }
  for (const patch of [{ camera: 'failed' }, { microphone: 'failed' }, { fps: 0 }, { fps: -1 }, { fps: NaN }, { fps: Infinity }, { analysisHz: NaN }, { analysisHz: Infinity }]) {
    assert.equal(passes(DEFAULT_CONFIG, { ...healthy(), ...patch } as RuntimeStatus), false);
  }
  for (const state of ['idle', 'warming', 'settling', 'scene-change'] as const) {
    const status = healthy(); status.motion.state = state;
    assert.equal(passes(DEFAULT_CONFIG, status), false);
  }
  for (const cellsPerBody of [null, 0, -1, NaN, Infinity]) {
    const status = healthy(); status.motion.cellsPerBody = cellsPerBody;
    assert.equal(passes(DEFAULT_CONFIG, status), false);
  }
  const status = healthy(); status.audio.contextState = 'suspended';
  assert.equal(passes(DEFAULT_CONFIG, status), false);
});
void test('configuration evidence cannot silently survive a changed installation', () => {
  assert.equal(commissioningKey(DEFAULT_CONFIG), commissioningKey(structuredClone(DEFAULT_CONFIG)));
  for (const patch of [{ crop: 0.1 }, { mirrorCamera: false }, { masterVolume: 0.5 }, { cameraDeviceId: 'another' }]) {
    assert.notEqual(commissioningKey(DEFAULT_CONFIG), commissioningKey({ ...DEFAULT_CONFIG, ...patch }));
  }
  const checks = galleryPreflight(DEFAULT_CONFIG, healthy(), confirmed);
  assert.ok(checks.every(c => c.instruction.length > 20));
  assert.deepEqual(Object.keys(checks[0]).sort(), ['id', 'instruction', 'passed']);
});
void test('each live check has a stable identity and reports its real cadence target', () => {
  const checks = galleryPreflight(DEFAULT_CONFIG, healthy(), confirmed);
  assert.deepEqual(checks.map(check => check.id), ['live', 'camera', 'scale', 'cadence', 'projection', 'audio', 'empty', 'walk', 'alignment', 'sound']);
  assert.match(checks.find(check => check.id === 'cadence')!.instruction, /at least 8.0 sensing frames\/s for CHEAP/);
});
void test('cached healthy rates cannot pass after either loop stops', () => {
  for (const key of ['lastRenderAt', 'lastAnalysisAt'] as const) {
    const now = 100000;
    for (const at of [undefined, NaN, Infinity, now + 1, now - 20000]) {
      const status = { ...healthy(), lastRenderAt: now, lastAnalysisAt: now, [key]: at };
      assert.equal(galleryPreflight(DEFAULT_CONFIG, status, confirmed, now).every(check => check.passed), false);
    }
    const status = { ...healthy(), lastRenderAt: now, lastAnalysisAt: now, [key]: now - 19999 };
    assert.ok(galleryPreflight(DEFAULT_CONFIG, status, confirmed, now).every(check => check.passed));
  }
});
void test('malformed timestamps never masquerade as fresh sensor evidence', () => {
  const now = 100000;
  for (const value of ['100000', null, false]) {
    const status = { ...healthy(), lastAnalysisAt: now, lastRenderAt: value } as unknown as RuntimeStatus;
    assert.equal(galleryPreflight(DEFAULT_CONFIG, status, confirmed, now).find(check => check.id === 'projection')?.passed, false);
  }
});
