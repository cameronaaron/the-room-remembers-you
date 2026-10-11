/**
 * Where a sound is, in the room.
 *
 * The installation places two different things in space and they must agree.
 * A remembered voice is panned to where the room associated it. A spoken line
 * is drawn beside whoever caused it. Before this they used different code
 * paths: the whisper went through a StereoPannerNode, and the room's own
 * sentence went through a bare HTMLAudioElement that takes a volume and knows
 * nothing about position. So the room could put a line on the wall next to
 * someone and say it from the middle of the speaker pair — the text pointed at
 * them and the voice did not.
 *
 * One function, used by both, so a memory and a sentence about the same place
 * come from the same place.
 *
 * **This is a claim about the speakers, not only about the code.** Panning is
 * meaningless on a single enclosure: a television's built-in pair is perhaps
 * 60 cm across and, from three metres back, everything it plays comes from one
 * point. The mapping below only becomes audible with two powered speakers
 * separated across the space, which is the difference between the room saying
 * "you came back" and the television saying it.
 */

/**
 * How far toward one speaker a sound is allowed to go.
 *
 * Not 1.0. A fully panned source is silent in the other channel, so a visitor
 * standing on the far side of the room hears nothing at all — and a memory that
 * is inaudible to the person it is about has failed at the only thing it was
 * for. Three quarters is strongly placed and still present across the room.
 */
export const ROOM_PAN_LIMIT = 0.75;

/**
 * Room x (0 at the left edge of the projection, 1 at the right) to a stereo
 * pan position.
 *
 * The projection and the speakers are assumed to face the room the same way.
 * If they do not, the correction belongs in the installation's physical setup,
 * not here: a sign flip buried in this function would make the calibration
 * step, the tracking overlay and the sound disagree about which way is left.
 */
export function stereoPanFor(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const centred = x * 2 - 1;
  return Math.max(-ROOM_PAN_LIMIT, Math.min(ROOM_PAN_LIMIT, centred));
}
