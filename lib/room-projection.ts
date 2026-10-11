/**
 * Camera space to projector space, in one place.
 *
 * Every point the room draws, deposits or remembers has to make this journey,
 * and the standards are explicit that it must be the *same* journey: calibrating
 * only the visible renderer while leaving the world model in camera coordinates
 * produces an installation that responds accurately to a visitor standing
 * somewhere they are not. Keeping the two steps — rotation, then homography —
 * behind one function is what makes "the same mapping" checkable rather than a
 * convention twelve call sites are each trusted to follow.
 *
 * It lived inside the render component, where a rotation could be verified only
 * by looking at a wall.
 */

import { mapCalibratedPoint } from './homography.ts';
import type { RoomConfig } from './room-types.ts';

/**
 * Undo how the camera is mounted.
 *
 * A camera turned on its side reports a room turned on its side, and every
 * downstream stage — tracking, memory, projection — would otherwise inherit
 * that. Quarter turns only: a camera is bolted to something, not held.
 *
 * The point is copied rather than mutated, and any extra fields it carries (a
 * timestamp on a path point, most often) travel with it.
 */
export function mapCameraPoint<T extends { x: number; y: number }>(
  point: T,
  rotation: RoomConfig['cameraRotation'],
): T {
  if (rotation === 90) return { ...point, x: 1 - point.y, y: point.x };
  if (rotation === 180) return { ...point, x: 1 - point.x, y: 1 - point.y };
  if (rotation === 270) return { ...point, x: point.y, y: 1 - point.x };
  return { ...point };
}

/**
 * The whole journey: unmount the camera, then land the point on the wall.
 *
 * Order matters and is not commutative. The calibration quad was captured in
 * upright camera space, so rotating after mapping would send every point
 * through a homography fitted to a different frame.
 */
export function mapRoomPoint<T extends { x: number; y: number }>(point: T, config: RoomConfig): T {
  const rotated = mapCameraPoint(point, config.cameraRotation);
  return mapCalibratedPoint(rotated, config.spatialCalibration.source, config.spatialCalibration.target);
}

/**
 * Where the four calibration marks stand, in projector space.
 *
 * Inset from the edges rather than at the corners: an operator has to be able
 * to stand on each one, and a mark in the literal corner of a keystoned
 * projection can land on a skirting board or outside the lit area entirely.
 * Ordered clockwise from the top left, which is the order the homography
 * solver pairs them in — reordering these silently produces a mapping that is
 * mirrored or rotated rather than one that fails.
 */
export const CALIBRATION_TARGETS = [
  { x: 0.12, y: 0.16 },
  { x: 0.88, y: 0.16 },
  { x: 0.88, y: 0.84 },
  { x: 0.12, y: 0.84 },
];
