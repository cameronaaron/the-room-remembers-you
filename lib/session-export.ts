/**
 * Getting a session out of the room, and getting one safely back in.
 *
 * Two exports and one import. The export side is bookkeeping; the import side
 * is the only place in this installation that reads a file a person chose, and
 * it decides what the tracker will then replay as though it were a visitor.
 *
 * The standards are explicit that coordinates from a recording are **data,
 * never instructions**: a replay drives the same track manager that real
 * sensing drives, so a malformed or hostile file must be refused whole rather
 * than partly believed. That validation used to live inline behind a `File`
 * object, which meant the only way to ask what it rejects was to construct a
 * file and run a browser. Here it is a function over parsed JSON, and what it
 * refuses can be enumerated.
 */

import type { AnonymousSensorEvent, RoomConfig, RuntimeStatus, SensingSample } from './room-types.ts';

/**
 * The ring the room holds and the most an import may carry.
 *
 * One second per sample, so 3,600 is an hour — long enough to catch an
 * intermittent fault, bounded so a session cannot grow without limit and a
 * supplied file cannot make the room allocate on demand.
 */
export const DEBUG_EVENT_LIMIT = 3_600;

/** Marks a file as ours, and as which of ours. */
export const SENSING_LOG_KIND = 'sensing-log';
export const DEBUG_EVENTS_KIND = 'anonymous-room-events';

/** A tuple is id, x, y, vx, vy, speed, occluded. */
const PERSON_TUPLE_LENGTH = 7;

/**
 * What the room was set to when a log was recorded.
 *
 * A subset, chosen rather than spread: the full config carries a camera device
 * id, and a session log is a file people attach to messages. Nothing here
 * identifies a machine or a person.
 */
export function exportedConfig(config: RoomConfig) {
  return {
    hardwareProfile: config.hardwareProfile,
    motionSensitivity: config.motionSensitivity,
    sceneChangeCoverage: config.sceneChangeCoverage,
    masterVolume: config.masterVolume,
    speech: config.speech,
    mirrorCamera: config.mirrorCamera,
    demoMode: config.demoMode,
    simulationRate: config.simulationRate,
    visualEngine: config.visualEngine,
    calibrated: Boolean(config.spatialCalibration.calibratedAt),
  };
}

/** The sensing log, as `npm run analyze-session` expects to read it back. */
export function sensingLogPayload(input: {
  config: RoomConfig;
  status: RuntimeStatus;
  samples: readonly SensingSample[];
  recordedAt?: Date;
  userAgent?: string;
}) {
  return {
    version: 1,
    kind: SENSING_LOG_KIND,
    recordedAt: (input.recordedAt ?? new Date()).toISOString(),
    userAgent: input.userAgent ?? '',
    config: exportedConfig(input.config),
    camera: {
      state: input.status.camera,
      resolution: input.status.cameraResolution,
      renderer: input.status.renderer,
    },
    samples: input.samples,
  };
}

/** The anonymous event recording. Aggregate tuples, no imagery, no names. */
export function debugEventsPayload(events: readonly AnonymousSensorEvent[]) {
  return { version: 1, kind: DEBUG_EVENTS_KIND, events };
}

/** A filename a person can sort by, with no colons for a filesystem to refuse. */
export function exportFilename(prefix: string, at: Date = new Date()): string {
  return `${prefix}-${at.toISOString().replaceAll(':', '-')}.json`;
}

/** One recorded person, checked field by field rather than trusted by shape. */
function isPersonTuple(person: unknown): person is AnonymousSensorEvent['people'][number] {
  if (!Array.isArray(person) || person.length !== PERSON_TUPLE_LENGTH) return false;
  if (typeof person[0] !== 'string') return false;
  // Five numbers, then the occlusion flag. `Number.isFinite` is the point:
  // NaN and Infinity both survive `typeof === 'number'` and both poison the
  // tracker's arithmetic silently rather than throwing.
  return person.slice(1, 6).every((value) => Number.isFinite(value));
}

function isEvent(event: unknown): event is AnonymousSensorEvent {
  if (typeof event !== 'object' || event === null) return false;
  const candidate = event as { t?: unknown; people?: unknown };
  if (!Number.isFinite(candidate.t)) return false;
  return Array.isArray(candidate.people) && candidate.people.every(isPersonTuple);
}

/**
 * Read an anonymous event file, or refuse it.
 *
 * Refused whole rather than filtered down to whatever happened to parse: a file
 * that is half-valid is not a recording of anything, and replaying its
 * survivors would show the room a visitor who never existed. Returns null for
 * anything it will not stand behind, so the caller has one case to handle and
 * cannot accidentally proceed on a partial result.
 *
 * The keep is the *last* `DEBUG_EVENT_LIMIT` events, matching the ring the room
 * itself holds: a longer file is a longer session, and its end is its most
 * recent hour.
 */
export function parseDebugEvents(raw: unknown): AnonymousSensorEvent[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const file = raw as { kind?: unknown; events?: unknown };
  if (file.kind !== DEBUG_EVENTS_KIND) return null;
  if (!Array.isArray(file.events) || file.events.length === 0) return null;
  if (!file.events.every(isEvent)) return null;
  return file.events.slice(-DEBUG_EVENT_LIMIT);
}
