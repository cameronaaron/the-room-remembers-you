/**
 * Surviving the loss of a WebGL context.
 *
 * The sensing pipeline is held to a rule the renderer was not: a camera that
 * sees nothing draws exactly what an empty gallery draws, so every stage has to
 * be observable. The same indistinguishability exists one stage later and is
 * worse. This room is dark by design and lit only by the particle field, so a
 * dead renderer looks precisely like ground nobody has walked on yet. Nothing
 * on the wall, in the console or in the logs would have said otherwise.
 *
 * A context is lost for ordinary reasons on an installation machine: the
 * display sleeps, the projector renegotiates EDID, a driver resets, the GPU is
 * switched. The browser only offers a restore if the `webglcontextlost` event
 * is cancelled, and even then it is an offer, not a promise — so both halves
 * need handling, and so does the case where the offer never arrives.
 *
 * This is the policy, kept apart from the GL code so it can be tested without a
 * GPU. `SwarmRenderer` holds every resource in readonly fields built by its
 * constructor, which makes rebuilding the object the honest recovery and
 * patching a half-dead one the dishonest one.
 */

/** What the room should do about the state of its renderer. */
export type RendererAction =
  /** Nothing to do: keep drawing, or keep waiting for a restore. */
  | 'hold'
  /** Build a new renderer; the old one is unusable. */
  | 'rebuild'
  /**
   * Stop asking. Run the trace engine for the rest of the session — it is the
   * fallback that needs no float render targets, and a room drawing something
   * is worth more than a room waiting for a GPU that keeps going away.
   */
  | 'fallback';

/**
 * How long to wait for a restore that was asked for.
 *
 * Cancelling `webglcontextlost` only requests restoration. A driver that has
 * given up, or a machine that has dropped to a software rasteriser, will never
 * send `webglcontextrestored`, and waiting forever is the silent failure this
 * module exists to prevent.
 */
export const RESTORE_GRACE_MS = 8_000;

/**
 * Losses tolerated inside `LOSS_WINDOW_MS` before the swarm is abandoned.
 *
 * Rebuilding reseeds the particles, so each recovery is a visible flinch in the
 * field. One is a recovery; several a minute is strobing, and strobing reads as
 * a fault rather than as the work. Three allows a genuine one-off — a display
 * waking, a projector resyncing — twice over before concluding the GPU cannot
 * hold a context at all.
 */
export const MAX_LOSSES = 3;
export const LOSS_WINDOW_MS = 5 * 60_000;

export type RendererHealthState = {
  /** Whether a context is currently gone and not yet replaced. */
  lost: boolean;
  /** Losses recorded inside the current window. */
  losses: number;
  /** Whether the swarm has been abandoned for the rest of the session. */
  abandoned: boolean;
  /** Rebuilds actually completed, for the operator console. */
  recoveries: number;
};

export class RendererHealth {
  private lossTimes: number[] = [];
  /**
   * Null rather than 0. A timestamp of zero is a real instant — the first
   * frame, or any caller passing a clock that starts at its own origin — and
   * using it as the sentinel for "holding a context" made a context lost at
   * that instant report itself as healthy and never time out.
   */
  private lostAt: number | null = null;
  private abandoned = false;
  private recoveries = 0;

  /**
   * The context has gone. Always returns 'hold' — the restore has been asked
   * for and has not arrived yet, so there is nothing to build from. The
   * decision to give up is made on restore or on timeout, never here: acting on
   * a loss alone would abandon the swarm on the first display sleep.
   */
  contextLost(now: number): RendererAction {
    this.lostAt = now;
    this.lossTimes.push(now);
    this.prune(now);
    return 'hold';
  }

  /**
   * The browser granted a new context. Rebuild, unless this GPU has lost one
   * too often to be worth following.
   */
  contextRestored(now: number): RendererAction {
    this.lostAt = null;
    this.prune(now);
    if (this.abandoned) return 'fallback';
    if (this.lossTimes.length > MAX_LOSSES) {
      this.abandoned = true;
      return 'fallback';
    }
    this.recoveries += 1;
    return 'rebuild';
  }

  /**
   * Called every frame. Returns 'fallback' once a requested restore has failed
   * to arrive, which is the case a listener alone can never report.
   */
  poll(now: number): RendererAction {
    if (this.abandoned || this.lostAt === null) return 'hold';
    if (now - this.lostAt < RESTORE_GRACE_MS) return 'hold';
    this.lostAt = null;
    this.abandoned = true;
    return 'fallback';
  }

  /** Whether drawing should be skipped entirely this frame. */
  get blocked(): boolean {
    return this.lostAt !== null;
  }

  get state(): RendererHealthState {
    return {
      lost: this.lostAt !== null,
      losses: this.lossTimes.length,
      abandoned: this.abandoned,
      recoveries: this.recoveries,
    };
  }

  /** What the operator console and the sensing instrument should say. */
  describe(): string {
    if (this.abandoned) {
      return `particle field abandoned after ${this.lossTimes.length} context losses — trace engine for the rest of this session`;
    }
    if (this.lostAt !== null) return 'GPU context lost — waiting for the browser to restore it';
    if (this.recoveries) {
      return `recovered from ${this.recoveries} GPU context ${this.recoveries === 1 ? 'loss' : 'losses'}`;
    }
    return 'GPU context held since start';
  }

  private prune(now: number) {
    this.lossTimes = this.lossTimes.filter((at) => now - at <= LOSS_WINDOW_MS);
  }
}
