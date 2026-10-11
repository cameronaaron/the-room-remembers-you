/**
 * Everything the trace renderer puts on the wall.
 *
 * The fallback surface, not the artwork's main engine: the swarm draws bodies,
 * and these draw lines, because a line is all this engine has. It exists so a
 * machine with no WebGL2 float targets still shows a room that remembers.
 *
 * These were private to the render component, which meant the only way to ask
 * whether a recall had been drawn at all was to run the installation and look.
 * `docs/` holds reference captures for judging how this looks; moving the
 * functions here is about whether they run — the standards record two defects
 * that passed every numerical check and were visible only in a screenshot, and
 * the converse failure, a draw path that throws or silently no-ops, is exactly
 * what a recording context can catch and an eye cannot.
 */

import { disturbanceFrame } from './memory-disturbance.ts';
import { markStyle, markStyleAt, type Mark, type Palette, type PersonalityRender } from './palette.ts';
import { unrestOffset } from './room-canvas.ts';
import { CALIBRATION_TARGETS, mapRoomPoint } from './room-projection.ts';
import type { ActiveGhost, Ghost, RoomConfig, VisitorTrack } from './room-types.ts';
import { RECALL_PRESENTATION, type RecallKind } from './swarm.ts';

/**
 * A mutable holder, which is all `drawRecalls` needs of the ref it is given.
 *
 * Spelled out rather than taken from React so this module depends on nothing
 * that has to be rendered. The list is rewritten in place as recalls finish, so
 * it genuinely has to be a holder and not a plain array.
 */
export type Holder<T> = { current: T };
import { selectObservedTracks, TRACK_CONFIRM_SIGHTINGS } from './motion-tracker.ts';

export function drawTracks(
  context: CanvasRenderingContext2D,
  tracks: readonly VisitorTrack[],
  width: number,
  height: number,
  now: number,
  intensity: number,
  personality: PersonalityRender,
  config: RoomConfig,
  palette: Palette,
) {
  const pathMark = palette.marks.presentPath;
  const bodyMark = palette.marks.presentBody;
  const jitter = personality.unrest * width * 0.0035;
  context.save();
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const track of selectObservedTracks(tracks)) {
    const points = track.path.filter((point) => now - point.t < 20_000);
    if (points.length < 2) continue;
    context.beginPath();
    points.forEach((point, index) => {
      const mapped = mapRoomPoint(point, config);
      const wobble = unrestOffset(index + point.x * 31, now, jitter);
      const x = mapped.x * width + wobble.x;
      const y = mapped.y * height + wobble.y;
      if (!index) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = markStyle(pathMark, intensity * personality.presence * 0.55);
    context.lineWidth = Math.max(1.5, width * (0.0022 + Math.min(track.dwellSeconds, 20) * 0.000025));
    context.stroke();

    // A living body is the brightest thing in the room, and it gets brighter
    // the longer it stays still — presence turning into a deposit of memory.
    const position = mapRoomPoint(track.position, config);
    const radius = Math.max(width, height) * (0.035 + Math.min(0.04, track.stillFor * 0.0015));
    const centreX = position.x * width;
    const centreY = position.y * height;
    const core = intensity * personality.presence * track.confidence;
    const afterimage = context.createRadialGradient(centreX, centreY, 0, centreX, centreY, radius);
    afterimage.addColorStop(0, markStyleAt(bodyMark, bodyMark.alpha * core));
    afterimage.addColorStop(0.4, markStyleAt(bodyMark, bodyMark.alpha * core * 0.28));
    afterimage.addColorStop(1, markStyleAt(bodyMark, 0));
    context.fillStyle = afterimage;
    context.fillRect(centreX - radius, centreY - radius, radius * 2, radius * 2);
  }
  context.restore();
}

export function drawRecentTrails(
  context: CanvasRenderingContext2D,
  ghosts: Ghost[],
  width: number,
  height: number,
  now: number,
  intensity: number,
  palette: Palette,
) {
  const lifetime = 10 * 60_000;
  const mark = palette.marks.recentTrail;
  context.save();
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const ghost of ghosts) {
    const age = now - ghost.createdAt;
    if (age < 0 || age > lifetime || ghost.path.length < 2) continue;
    const fade = (1 - age / lifetime) ** 1.8;
    context.beginPath();
    ghost.path.forEach((point, index) => {
      if (!index) context.moveTo(point.x * width, point.y * height);
      else context.lineTo(point.x * width, point.y * height);
    });
    context.strokeStyle = markStyle(mark, fade * intensity * (0.3 + ghost.strength * 0.4) * 0.3);
    context.lineWidth = Math.max(1, width * 0.0015);
    context.stroke();
  }
  context.restore();
}

/** Each recall event gets its own colour, duration and gesture. */
export const GHOST_KIND_MARK: Record<RecallKind, keyof Palette['marks']> = {
  ghost: 'ghostRecall',
  empty: 'emptyGhost',
  stillness: 'stillnessRecall',
  return: 'returnEcho',
  convergence: 'convergence',
  false: 'falseMemory',
};

/**
 * The trace renderer's version of a recall. The swarm draws these as bodies;
 * here they stay lines, because a line is all this engine has.
 */
export function drawRecalls(
  context: CanvasRenderingContext2D,
  activeRef: Holder<ActiveGhost[]>,
  width: number,
  height: number,
  now: number,
  intensity: number,
  palette: Palette,
  personality: PersonalityRender,
) {
  const stillRunning: ActiveGhost[] = [];
  for (const active of activeRef.current) {
    if (now < active.startedAt) {
      stillRunning.push(active);
      continue;
    }
    const duration = RECALL_PRESENTATION[active.kind].durationMs;
    const progress = (now - active.startedAt) / duration;
    const frame = active.disturbance ? disturbanceFrame(active.ghost.path, progress, active.disturbance.loss) : null;
    if (progress >= 1 || (frame && frame.fade <= 0)) continue;
    stillRunning.push(active);
    drawRecall(context, frame ? { ...active, ghost: { ...active.ghost, path: frame.path } } : active, progress, width, height, now, intensity * (frame?.fade ?? 1), palette, personality);
  }
  activeRef.current = stillRunning;
}

export function drawRecall(
  context: CanvasRenderingContext2D,
  active: ActiveGhost,
  progress: number,
  width: number,
  height: number,
  now: number,
  intensity: number,
  palette: Palette,
  personality: PersonalityRender,
) {
  const path = active.ghost.path;
  if (path.length < 2) return;
  const mark: Mark = palette.marks[GHOST_KIND_MARK[active.kind]];
  // A recall is drawn as a travelling head, not a whole line appearing at once:
  // the room is re-walking the path, not displaying a record of it.
  const head = Math.min(1, progress * 1.35);
  const visible = Math.max(2, Math.floor(path.length * head));
  const fade = Math.sin(Math.min(1, progress) * Math.PI);
  // A false memory breathes unevenly. Nothing labels it; it just does not
  // move the way the room's true recollections move.
  const pulse = active.kind === 'false'
    ? 0.62 + 0.38 * Math.abs(Math.sin(now * 0.0021))
    : 1;
  const jitter = personality.unrest * width * 0.002;

  context.save();
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  path.slice(0, visible).forEach((point, index) => {
    const wobble = unrestOffset(index * 1.7 + point.y * 53, now, jitter);
    const x = point.x * width + wobble.x;
    const y = point.y * height + wobble.y;
    if (!index) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = markStyle(mark, fade * intensity * active.ghost.strength * pulse);
  context.lineWidth = width * (active.kind === 'convergence' ? 0.005 : 0.003);
  context.stroke();

  // The point the room has reached, brighter than the trail behind it.
  const headPoint = path[Math.min(path.length - 1, visible - 1)];
  const radius = width * (active.kind === 'convergence' ? 0.02 : 0.012);
  const headX = headPoint.x * width;
  const headY = headPoint.y * height;
  const glow = context.createRadialGradient(headX, headY, 0, headX, headY, radius);
  glow.addColorStop(0, markStyleAt(mark, mark.alpha * fade * pulse));
  glow.addColorStop(1, markStyleAt(mark, 0));
  context.fillStyle = glow;
  context.fillRect(headX - radius, headY - radius, radius * 2, radius * 2);
  context.restore();
}

export function drawAmbient(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  now: number,
  density: number,
  personality: PersonalityRender,
  palette: Palette,
  intensity: number,
) {
  const amount = Math.min(18, Math.floor(density * 900));
  if (!amount) return;
  const mark = palette.marks.ambientDrift;
  context.save();
  context.globalCompositeOperation = mark.composite;
  context.strokeStyle = markStyle(mark, personality.drift * intensity * 0.5);
  context.lineWidth = Math.max(0.7, width * 0.0008);
  for (let index = 0; index < amount; index += 1) {
    const seed = index * 191.73;
    const x = ((Math.sin(seed) + 1) / 2) * width;
    const y = ((Math.cos(seed * 0.71) + 1) / 2) * height;
    const sway = Math.sin(now * 0.0001 + seed) * width * 0.012 * (0.5 + personality.drift);
    context.beginPath();
    context.moveTo(x, y);
    context.bezierCurveTo(x + sway, y - height * 0.025, x - sway, y - height * 0.045, x + sway * 0.4, y - height * 0.07);
    context.stroke();
  }
  context.restore();
}

export function drawClosingMontage(
  context: CanvasRenderingContext2D,
  ghosts: Ghost[],
  width: number,
  height: number,
  elapsed: number,
  palette: Palette,
) {
  if (!ghosts.length) return;
  const progress = Math.min(1, elapsed / 90_000);
  const mark = palette.marks.closingMontage;
  context.save();
  context.lineCap = 'round';
  ghosts.slice(-28).forEach((ghost, ghostIndex) => {
    const phase = Math.max(0, Math.sin(progress * Math.PI * 2 - ghostIndex * 0.17));
    if (phase < 0.08) return;
    context.beginPath();
    ghost.path.forEach((point, index) => {
      if (!index) context.moveTo(point.x * width, point.y * height);
      else context.lineTo(point.x * width, point.y * height);
    });
    context.strokeStyle = markStyle(mark, phase * ghost.strength);
    context.lineWidth = Math.max(1, width * 0.0018);
    context.stroke();
  });
  context.restore();
}

/**
 * An unmistakable ring on every tracked person, drawn straight onto the wall.
 *
 * The artwork's own response is deliberately atmospheric, which makes it hard
 * for one person testing alone to tell whether the room has them at all. This
 * is the opposite: high contrast, hard edges, obviously not part of the piece.
 * Turn it on, walk about, watch the ring follow you, turn it off.
 */
export function drawTrackingOverlay(
  context: CanvasRenderingContext2D,
  tracks: readonly VisitorTrack[],
  width: number,
  height: number,
  now: number,
  config: RoomConfig,
) {
  const observed = selectObservedTracks(tracks);
  context.save();
  context.font = `${Math.max(11, width * 0.009)}px ui-monospace, monospace`;
  context.textBaseline = 'top';

  context.fillStyle = 'rgba(0, 0, 0, 0.55)';
  context.fillRect(0, 0, width, Math.max(26, height * 0.035));
  context.fillStyle = observed.length ? '#7dffb0' : '#ff8f7a';
  context.fillText(
    observed.length
      ? `TRACKING ${observed.length} · T to hide`
      : 'NOT TRACKING ANYONE · press D for why · T to hide',
    width * 0.012,
    Math.max(6, height * 0.008),
  );

  for (const track of tracks) {
    const mapped = mapRoomPoint(track.position, config);
    const x = mapped.x * width;
    const y = mapped.y * height;
    const radius = Math.max(24, Math.min(width, height) * 0.06);
    const pulse = 0.7 + 0.3 * Math.sin(now * 0.005);
    const live = !track.occluded && track.sightings >= TRACK_CONFIRM_SIGHTINGS;

    context.strokeStyle = live ? `rgba(125, 255, 176, ${pulse})` : 'rgba(255, 190, 110, 0.55)';
    context.lineWidth = live ? 3 : 2;
    context.setLineDash(live ? [] : [7, 7]);
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.stroke();

    context.beginPath();
    context.moveTo(x - radius * 1.4, y);
    context.lineTo(x + radius * 1.4, y);
    context.moveTo(x, y - radius * 1.4);
    context.lineTo(x, y + radius * 1.4);
    context.stroke();
    context.setLineDash([]);

    context.fillStyle = live ? 'rgba(125, 255, 176, 0.95)' : 'rgba(255, 190, 110, 0.8)';
    context.fillText(
      `${live ? 'live' : track.occluded ? 'hidden' : 'candidate'} ${mapped.x.toFixed(2)},${mapped.y.toFixed(2)} v${track.speed.toFixed(2)}`,
      x + radius + 8,
      y - 8,
    );
  }
  context.restore();
}

export function drawCalibration(context: CanvasRenderingContext2D, width: number, height: number, step: number, palette: Palette) {
  const mark = palette.marks.calibration;
  context.save();
  context.globalCompositeOperation = mark.composite;
  context.strokeStyle = markStyle(mark, 0.45);
  context.fillStyle = markStyle(mark, 0.9);
  context.lineWidth = 1;
  for (let x = 0; x <= 8; x += 1) {
    context.beginPath(); context.moveTo((x / 8) * width, 0); context.lineTo((x / 8) * width, height); context.stroke();
  }
  for (let y = 0; y <= 4; y += 1) {
    context.beginPath(); context.moveTo(0, (y / 4) * height); context.lineTo(width, (y / 4) * height); context.stroke();
  }
  context.font = `${Math.max(18, width * 0.012)}px monospace`;
  const target = CALIBRATION_TARGETS[step];
  const x = target.x * width;
  const y = target.y * height;
  context.beginPath();
  context.arc(x, y, Math.min(width, height) * 0.04, 0, Math.PI * 2);
  context.strokeStyle = markStyle(mark, 1);
  context.lineWidth = 3;
  context.stroke();
  context.beginPath(); context.moveTo(x - 30, y); context.lineTo(x + 30, y); context.moveTo(x, y - 30); context.lineTo(x, y + 30); context.stroke();
  context.fillText(`STAND ON MARKER ${step + 1} · PRESS SPACE · ESC TO CANCEL`, width * 0.025, height * 0.06);
  context.restore();
}
