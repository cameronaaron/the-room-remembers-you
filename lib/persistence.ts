import { CONFIG_SCHEMA } from './room-types.ts';
import type { AnonymousSensorEvent, Ghost, RoomConfig, RoomLifecycle, WhisperMemory } from './room-types';

const DATABASE = 'the-room-remembers';
const STORE = 'state';
const VERSION = 1;

export type PersistedRoom = {
  field: number[];
  ghosts: Ghost[];
  whispers: WhisperMemory[];
  installationStartedAt: number;
  savedAt: number;
  day?: number;
  lifecycle?: RoomLifecycle;
  debugEvents?: AnonymousSensorEvent[];
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadRoom(): Promise<PersistedRoom | null> {
  const database = await openDatabase();
  return new Promise<PersistedRoom | null>((resolve, reject) => {
    const request = database.transaction(STORE, 'readonly').objectStore(STORE).get('room');
    request.onsuccess = () => resolve((request.result as PersistedRoom | undefined) ?? null);
    request.onerror = () => reject(request.error);
  }).finally(() => database.close());
}

/**
 * The only fields allowed to reach disk.
 *
 * The ephemeral motion-cell mask is now drawn on the wall as a visitor's
 * silhouette, not just shown in the operator console, so it travels through
 * more of the app than it used to. Writing the store through an allowlist means
 * a future refactor that hands `saveRoom` a richer object cannot quietly
 * persist sensor-derived imagery: anything not named here is dropped, whether
 * or not anyone remembered to think about it.
 */
export const PERSISTED_ROOM_KEYS = [
  'field',
  'ghosts',
  'whispers',
  'installationStartedAt',
  'savedAt',
  'day',
  'lifecycle',
  'debugEvents',
] as const satisfies ReadonlyArray<keyof PersistedRoom>;

/** Strip anything outside the allowlist before it can be written. */
export function sanitizeRoom(room: PersistedRoom): PersistedRoom {
  const safe: Partial<Record<keyof PersistedRoom, unknown>> = {};
  for (const key of PERSISTED_ROOM_KEYS) {
    if (room[key] !== undefined) safe[key] = room[key];
  }
  return safe as PersistedRoom;
}

export async function saveRoom(room: PersistedRoom) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(sanitizeRoom(room), 'room');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }).finally(() => database.close());
}

export async function clearRoom() {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).delete('room');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }).finally(() => database.close());
}

/**
 * Whatever the operator has actually saved, with no defaults filled in.
 *
 * A config written under an older schema is discarded rather than merged. When
 * a setting changes meaning but keeps a plausible value — a scene-change guard
 * that moved from counting pixels to counting grid coverage, say — no amount of
 * validating the number can tell that it is now wrong.
 */
export function readSavedConfig(): Partial<RoomConfig> {
  try {
    const saved = JSON.parse(localStorage.getItem('room-config') ?? '{}') as
      Partial<RoomConfig> & { schema?: number };
    if ((saved.schema ?? 0) !== CONFIG_SCHEMA) return {};
    return saved;
  } catch {
    return {};
  }
}

export function loadConfig(fallback: RoomConfig): RoomConfig {
  // No try/catch here. `readSavedConfig` already owns every way this can fail —
  // absent storage, a browser that throws on access, unparseable JSON, a stale
  // schema — and returns {}. A second catch around a spread of plain objects
  // could not run, and an unreachable fallback is a claim about safety that
  // nothing backs.
  const saved = readSavedConfig();
  return {
    ...fallback,
    ...saved,
    spatialCalibration: {
      ...fallback.spatialCalibration,
      ...saved.spatialCalibration,
    },
  };
}

export function saveConfig(config: RoomConfig) {
  localStorage.setItem('room-config', JSON.stringify({ ...config, schema: CONFIG_SCHEMA }));
}
