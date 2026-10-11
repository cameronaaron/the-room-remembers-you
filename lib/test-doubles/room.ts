import type { VisitorTrack, Ghost } from '../room-types.ts';
import { TRACK_CONFIRM_SIGHTINGS } from '../motion-tracker.ts';
const NOW = 100_000;
export const track = (overrides: Partial<VisitorTrack> = {}): VisitorTrack => ({
  id: 'visitor',
  bornAt: NOW - 8_000,
  lastSeen: NOW,
  position: { x: 0.5, y: 0.5, t: NOW },
  previous: { x: 0.48, y: 0.5, t: NOW - 100 },
  velocity: { x: 0.2, y: 0 },
  speed: 0.2,
  stillFor: 0,
  dwellSeconds: 8,
  path: [
    { x: 0.2, y: 0.5, t: NOW - 4_000 },
    { x: 0.35, y: 0.5, t: NOW - 2_000 },
    { x: 0.5, y: 0.5, t: NOW },
  ],
  active: true,
  occluded: false,
  confidence: 1,
  sightings: TRACK_CONFIRM_SIGHTINGS + 2,
  extent: { width: 0.09, height: 0.3 },
  ...overrides,
});

export const ghost = (overrides: Partial<Ghost> = {}): Ghost => ({
  id: 'ghost',
  createdAt: NOW - 60_000,
  lastReplayedAt: 0,
  path: [
    { x: 0.15, y: 0.3, t: 0 },
    { x: 0.5, y: 0.55, t: 1_000 },
    { x: 0.85, y: 0.35, t: 2_000 },
  ],
  dwellSeconds: 6,
  intensity: 0.5,
  strength: 0.5,
  fidelity: 1,
  recallCount: 0,
  lineage: ['ghost'],
  falseMemory: false,
  day: 1,
  ...overrides,
});
