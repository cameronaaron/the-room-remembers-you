import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERSISTED_ROOM_KEYS,
  type PersistedRoom,
  clearRoom,
  loadConfig,
  loadRoom,
  readSavedConfig,
  saveConfig,
  saveRoom,
} from './persistence.ts';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from './room-types.ts';
import { FakeIndexedDb, FakeStorage } from './test-doubles/browser.ts';

/**
 * What reaches disk, and what happens when the disk refuses.
 *
 * `persistence.test.ts` proves the allowlist strips a polluted snapshot. It
 * cannot reach the store itself, so the round trip, the failure paths and the
 * schema gate were untested — and every one of them fails quietly. A gallery
 * machine whose IndexedDB is unavailable loses the room's whole memory between
 * days while looking, from the front, exactly like a room that has forgotten.
 */

const scope = globalThis as Record<string, unknown>;

function withStore(options: { failOpen?: boolean; failRequests?: boolean } = {}) {
  const database = new FakeIndexedDb();
  database.failOpen = options.failOpen ?? false;
  database.failRequests = options.failRequests ?? false;
  const previous = scope.indexedDB;
  scope.indexedDB = database;
  return {
    database,
    restore() {
      if (previous === undefined) delete scope.indexedDB;
      else scope.indexedDB = previous;
    },
  };
}

function withStorage() {
  const storage = new FakeStorage();
  const previous = scope.localStorage;
  scope.localStorage = storage;
  return {
    storage,
    restore() {
      if (previous === undefined) delete scope.localStorage;
      else scope.localStorage = previous;
    },
  };
}

const room: PersistedRoom = {
  field: [0, 0.5, 1],
  ghosts: [],
  whispers: [],
  installationStartedAt: 1000,
  savedAt: 2000,
  day: 3,
  lifecycle: 'active',
  debugEvents: [],
};

void test('a room survives being written and read back', async () => {
  const store = withStore();
  try {
    assert.equal(await loadRoom(), null, 'an installation with no history starts empty');
    await saveRoom(room);
    assert.deepEqual(await loadRoom(), room);
  } finally {
    store.restore();
  }
});

void test('the database is closed after every operation', async () => {
  // A gallery day is twelve hours of saves. A connection left open per save
  // would accumulate for as long as the installation runs.
  const store = withStore();
  try {
    await saveRoom(room);
    await loadRoom();
    await clearRoom();
    assert.equal(store.database.closes, store.database.opens, 'every open must be closed');
    assert.ok(store.database.opens >= 3);
  } finally {
    store.restore();
  }
});

void test('only the allowlist reaches disk, whatever it is handed', async () => {
  const store = withStore();
  try {
    // The ephemeral motion mask now travels further through the app than it
    // used to, so a future refactor handing saveRoom a richer object must not
    // be able to persist sensor-derived imagery by accident.
    await saveRoom({
      ...room,
      mask: [1, 2, 0, 2],
      frame: 'data:image/png;base64,AAAA',
      tracks: [{ id: 'a' }],
    } as unknown as PersistedRoom);

    const written = store.database.contents('state').get('room') as Record<string, unknown>;
    assert.deepEqual(Object.keys(written).sort(), [...PERSISTED_ROOM_KEYS].sort());
    assert.ok(!('mask' in written), 'the motion mask must never be written');
    assert.ok(!('frame' in written));
    assert.ok(!('tracks' in written));
  } finally {
    store.restore();
  }
});

void test('clearing the room leaves nothing behind', async () => {
  const store = withStore();
  try {
    await saveRoom(room);
    await clearRoom();
    assert.equal(await loadRoom(), null);
  } finally {
    store.restore();
  }
});

void test('a store that will not open rejects rather than resolving to an empty room', async () => {
  // The caller catches this and reports "memory store unavailable". Resolving
  // to null instead would look identical to a first run, and the room would
  // quietly start the day with no history and overwrite what it could not read.
  const store = withStore({ failOpen: true });
  try {
    await assert.rejects(loadRoom());
    await assert.rejects(saveRoom(room));
    await assert.rejects(clearRoom());
  } finally {
    store.restore();
  }
});

void test('a write that fails is reported, not silently dropped', async () => {
  const store = withStore({ failRequests: true });
  try {
    await assert.rejects(saveRoom(room));
    await assert.rejects(clearRoom());
  } finally {
    store.restore();
  }
});

void test('config written under this schema comes back; an older one does not', () => {
  const storage = withStorage();
  try {
    saveConfig({ ...DEFAULT_CONFIG, motionSensitivity: 31 });
    assert.equal(readSavedConfig().motionSensitivity, 31);

    // A setting that changed meaning but kept a plausible value cannot be
    // caught by validating the number: sceneChangeLimit counted pixels and
    // became a coverage threshold under the same key, so a stored 0.32 was
    // reapplied as a 32% coverage limit and rejected a third of every frame.
    storage.storage.setItem(
      'room-config',
      JSON.stringify({ schema: CONFIG_SCHEMA - 1, motionSensitivity: 99 }),
    );
    assert.deepEqual(readSavedConfig(), {}, 'an older schema is discarded whole, not merged');
    assert.equal(loadConfig(DEFAULT_CONFIG).motionSensitivity, DEFAULT_CONFIG.motionSensitivity);
  } finally {
    storage.restore();
  }
});

void test('a config with no schema at all is treated as older', () => {
  const storage = withStorage();
  try {
    storage.storage.setItem('room-config', JSON.stringify({ motionSensitivity: 99 }));
    assert.deepEqual(readSavedConfig(), {});
  } finally {
    storage.restore();
  }
});

void test('corrupt stored config leaves the room on its defaults', () => {
  const storage = withStorage();
  try {
    storage.storage.setItem('room-config', '{not json');
    assert.deepEqual(readSavedConfig(), {});
    assert.deepEqual(loadConfig(DEFAULT_CONFIG), DEFAULT_CONFIG);
  } finally {
    storage.restore();
  }
});

void test('a browser with storage blocked still runs the installation', () => {
  // Private windows and blocked site data throw on access rather than
  // returning null. An unhandled throw here happens before anything is drawn.
  const storage = withStorage();
  try {
    storage.storage.throwOnAccess = true;
    assert.deepEqual(readSavedConfig(), {});
    assert.deepEqual(loadConfig(DEFAULT_CONFIG), DEFAULT_CONFIG);
  } finally {
    storage.restore();
  }
});

void test('calibration is merged field by field rather than replaced wholesale', () => {
  // An operator's saved calibration must survive a new setting being added to
  // the defaults, or adding a field silently uncalibrates every installation.
  const storage = withStorage();
  try {
    const calibrated = {
      ...DEFAULT_CONFIG,
      spatialCalibration: { ...DEFAULT_CONFIG.spatialCalibration, calibratedAt: 1717171717 },
    };
    saveConfig(calibrated);
    const loaded = loadConfig(DEFAULT_CONFIG);
    assert.equal(loaded.spatialCalibration.calibratedAt, 1717171717);
    for (const key of Object.keys(DEFAULT_CONFIG.spatialCalibration)) {
      assert.ok(key in loaded.spatialCalibration, `${key} was dropped from calibration`);
    }
  } finally {
    storage.restore();
  }
});

void test('the stored config records the schema it was written under', () => {
  const storage = withStorage();
  try {
    saveConfig(DEFAULT_CONFIG);
    const raw = JSON.parse(storage.storage.raw('room-config')!);
    assert.equal(raw.schema, CONFIG_SCHEMA, 'without this every load would discard the config');
  } finally {
    storage.restore();
  }
});

void test('a machine that has never run the installation loads its defaults, not a crash', () => {
  // The very first launch in a gallery: nothing saved, getItem returns null.
  // `JSON.parse(null)` yields null, and reading `.schema` off it throws inside
  // the one call every other setting is loaded through.
  const storage = withStorage();
  try {
    assert.equal(storage.storage.raw('room-config'), null, 'nothing has been written yet');
    assert.deepEqual(readSavedConfig(), {});
    assert.deepEqual(loadConfig(DEFAULT_CONFIG), DEFAULT_CONFIG);
  } finally {
    storage.restore();
  }
});

void test('a store that opens and then refuses the read rejects rather than reporting an empty room', async () => {
  // The database opens, and the read fails afterwards — a quota, a corrupted
  // object store, a browser evicting site data mid-session. Resolving to null
  // here is the dangerous answer: it is indistinguishable from a first run, so
  // the room would open the day with no history and then save over what it
  // could not read. The caller must be told, and it is.
  const store = withStore({ failRequests: true });
  try {
    await assert.rejects(loadRoom(), 'a failed read must not look like an empty room');
    await assert.rejects(saveRoom(room));
    await assert.rejects(clearRoom());
    // And every attempt still closed its connection, or a gallery day of
    // failing saves accumulates one open database per save.
    assert.equal(store.database.closes, store.database.opens);
  } finally {
    store.restore();
  }
});
