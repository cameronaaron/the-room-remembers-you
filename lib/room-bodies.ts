import { selectObservedTracks } from './motion-tracker.ts';
import { mapRoomPoint } from './room-projection.ts';
import { disturbanceFrame } from './memory-disturbance.ts';
import { recallBody, RECALL_PRESENTATION } from './swarm.ts';
import { MAX_BODIES, type SwarmBody } from './swarm-frame.ts';
import type { ActiveGhost, RoomConfig, VisitorTrack } from './room-types.ts';

/** Living visitors retain reserved slots; future recalls wait without rendering. */
const MAX_LIVE_BODIES = 9;
export function composeRoomBodies(
  tracks: readonly VisitorTrack[],
  recalls: readonly ActiveGhost[],
  config: RoomConfig,
  now: number,
) {
  const bodies: SwarmBody[] = selectObservedTracks(tracks)
    .slice(0, MAX_LIVE_BODIES)
    .map((track) => {
      const mapped = mapRoomPoint(track.position, config);
      return {
        x: mapped.x,
        y: mapped.y,
        vx: track.velocity.x,
        vy: track.velocity.y,
        stillness: Math.min(1, track.stillFor / 12),
        strength: Math.max(0.35, track.confidence),
        heat: 1,
      };
    });

  const stillRunning: ActiveGhost[] = [];
  for (const active of recalls) {
    // A recall may be scheduled slightly into the future; hold it until
    // its start time rather than dropping it before it has begun.
    if (now < active.startedAt) {
      stillRunning.push(active);
      continue;
    }
    const frame = active.disturbance
      ? disturbanceFrame(
          active.ghost.path,
          (now - active.startedAt) /
            RECALL_PRESENTATION[active.kind].durationMs,
          active.disturbance.loss,
        )
      : null;
    if (frame && frame.fade <= 0) continue;
    const body = recallBody(
      frame?.path ?? active.ghost.path,
      active.kind,
      now - active.startedAt,
      active.ghost.strength * (frame?.fade ?? 1),
    );
    if (!body) continue;
    stillRunning.push(active);
    if (bodies.length < MAX_BODIES) bodies.push({ ...body, stillness: 0 });
  }
  return { bodies, recalls: stillRunning };
}
