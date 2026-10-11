import assert from 'node:assert/strict';
import test from 'node:test';
import { PERSISTED_ROOM_KEYS, readSavedConfig, sanitizeRoom, saveConfig } from './persistence.ts';
import type { PersistedRoom } from './persistence.ts';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from './room-types.ts';

const room = (): PersistedRoom => ({
  field: [0.1, 0.2],
  ghosts: [],
  whispers: [],
  installationStartedAt: 1,
  savedAt: 2,
  day: 3,
  lifecycle: 'active',
  debugEvents: [],
});

void test('sanitizing keeps everything the room legitimately remembers', () => {
  const saved = sanitizeRoom(room());
  for (const key of PERSISTED_ROOM_KEYS) {
    assert.ok(key in saved, `${key} was dropped from the persisted room`);
  }
  assert.deepEqual(saved, room());
});

void test('sensor-derived imagery cannot reach disk even if it is handed over', () => {
  // The 40x23 motion mask now drives a visitor's silhouette on the wall, so it
  // passes through more of the app than it used to. A future refactor that
  // hands saveRoom a richer object must not be able to persist it.
  const polluted = {
    ...room(),
    motion: { mask: [0, 1, 2], width: 40, height: 23 },
    frame: new Uint8Array([1, 2, 3]),
    silhouette: [1, 1, 0],
    audio: new Float32Array([0.5]),
  } as unknown as PersistedRoom;

  const saved = sanitizeRoom(polluted) as Record<string, unknown>;
  for (const leaked of ['motion', 'frame', 'silhouette', 'audio']) {
    assert.ok(!(leaked in saved), `${leaked} reached the persisted room`);
  }
  assert.deepEqual(Object.keys(saved).sort(), [...PERSISTED_ROOM_KEYS].sort());
});

void test('the allowlist stays an allowlist, not a denylist', () => {
  const saved = sanitizeRoom({} as PersistedRoom) as Record<string, unknown>;
  // Absent fields are simply absent; nothing is invented to fill them.
  assert.deepEqual(Object.keys(saved), []);
});

void test('a config saved under an older schema is discarded, not reinterpreted', () => {
  // The failure this exists to prevent, taken from a real installation: the
  // scene-change guard changed from counting changed pixels to counting grid
  // coverage. A saved 0.32 was entirely reasonable as a pixel fraction and
  // catastrophic as a coverage threshold — it rejected a third of all frames.
  // Validating the number cannot catch that; only versioning the meaning can.
  const stale = JSON.stringify({ sceneChangeLimit: 0.32, hardwareProfile: 'CHEAP' });
  const store = new Map<string, string>([['room-config', stale]]);
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  } as unknown as Storage;

  assert.deepEqual(readSavedConfig(), {}, 'a schema-less config must be dropped whole');

  // A config written by the current build survives.
  saveConfig({ ...DEFAULT_CONFIG, hardwareProfile: 'FULL' });
  assert.equal(readSavedConfig().hardwareProfile, 'FULL');
  assert.equal(readSavedConfig().sceneChangeCoverage, DEFAULT_CONFIG.sceneChangeCoverage);
});

void test('a config from a future schema is also dropped rather than half-read', () => {
  const store = new Map<string, string>([
    ['room-config', JSON.stringify({ schema: CONFIG_SCHEMA + 1, hardwareProfile: 'CHEAP' })],
  ]);
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  } as unknown as Storage;
  assert.deepEqual(readSavedConfig(), {});
});
