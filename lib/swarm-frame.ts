import type { ProjectionMode } from './palette.ts';

export const MAX_BODIES = 12;

/**
 * Anything the field treats as a presence. A living visitor and a memory the
 * room is replaying are the same kind of thing here, deliberately: the piece
 * depends on not being able to tell them apart.
 */
export type SwarmBody = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 0 moving, 1 completely still. Still bodies gather rather than scatter. */
  stillness: number;
  /** 0..1 presence envelope. Living bodies are 1; a recall swells and subsides. */
  strength: number;
  /**
   * Colour temperature, 1 being a living body. The one thing that separates a
   * fabricated memory from a real one: it moves like a person and never warms.
   */
  heat: number;
};

export type SwarmFrame = {
  projectionMode?: ProjectionMode;
  deltaSeconds: number;
  /** Overall brightness, from the operator's visual intensity. */
  intensity: number;
  /** Scales ambient motion and turbulence with the room's personality. */
  drift: number;
  unrest: number;
  /** Extra life given to living bodies. */
  presence: number;
  bodies: SwarmBody[];
};

