/**
 * What the room noticed, decided once per sensing frame, optionally in Rust.
 *
 * The same shape as `tracking-runtime.ts` and `attention-runtime.ts`, and for
 * the same reasons: a WASM engine drives the room only while a live TypeScript
 * companion agrees with it, and a trap, a malformed frame or a disagreement
 * retires WASM and leaves the companion — which has been advancing on the same
 * tracks all along — holding an unbroken history.
 *
 * Continuity matters more here than the duplication costs. Every detector is a
 * claim about seconds or minutes of history, and the cooldowns run to a minute;
 * a watcher restarted empty mid-session would go quiet for as long as its
 * longest window and then announce things it had already said. A behaviour the
 * room announces wrongly is worse than one it misses, and saying the same thing
 * twice is a wrong announcement.
 *
 * # What the two sides must agree about
 *
 * The event list, in order: kind, both subjects, and where the room addresses
 * it. Positions are compared against a tolerance because they are arithmetic
 * over the same inputs in two languages; everything else is compared exactly,
 * because a kind or a subject that differs is not a rounding difference, it is
 * two rooms noticing two different things.
 */
import { BehaviorWatcher, type BehaviorEvent, type BehaviorKind } from './behaviors.ts';
import {
  decodeBehaviorFrame,
  encodeBehaviorFrame,
  type ObservedTrack,
} from './behavior-bridge.ts';
import { trackSequence } from './track-bridge.ts';
import type { VisitorTrack } from './room-types.ts';

export interface WasmBehavior {
  step(frame: Float64Array): Float64Array;
  clear(): void;
  free(): void;
}

/**
 * How far the two engines' addressing may differ before WASM is retired.
 *
 * Exported so the test that brackets it reads this value rather than a copy of
 * it. A bracket written against a literal is two constants the compiler folds
 * into `true`, which is a tautology wearing an assertion's clothes. The parity
 * harness uses the same absolute figure.
 *
 * A room coordinate is 0..1 across a wall a few metres wide, so a millionth of
 * one is well under a micrometre of projected light — far below anything a
 * visitor or a projector can resolve, and far above the last-place differences
 * two `hypot` implementations produce.
 */
export const BEHAVIOR_PARITY_TOLERANCE = 1e-6;

/** A disagreement is a different observation, so everything but place is exact. */
function agrees(wasm: readonly BehaviorEvent[], companion: readonly BehaviorEvent[]): boolean {
  if (wasm.length !== companion.length) return false;
  return wasm.every((event, index) => {
    const other = companion[index];
    return event.kind === other.kind
      && event.subjects.length === other.subjects.length
      && event.subjects.every((subject, at) => subject === other.subjects[at])
      && Math.abs(event.at.x - other.at.x) <= BEHAVIOR_PARITY_TOLERANCE
      && Math.abs(event.at.y - other.at.y) <= BEHAVIOR_PARITY_TOLERANCE;
  });
}

export class BehaviorRuntime {
  private readonly watcher: BehaviorWatcher;
  private disposed = false;
  // A plain field rather than a parameter property: the burn-in runs this
  // module under Node's strip-only TypeScript, which does not support them.
  private wasm: WasmBehavior | null;
  label: string;

  constructor(wasm: WasmBehavior | null = null, reason?: string) {
    this.wasm = wasm;
    this.watcher = new BehaviorWatcher();
    this.label = wasm
      ? 'Rust/WASM behaviour (verified against TS)'
      : reason ? `TypeScript behaviour — ${reason}` : 'TypeScript behaviour';
  }

  /**
   * Feed the current frame and receive anything newly noticed.
   *
   * `stable` is whether sensing has settled. While it has not, history is still
   * recorded on both sides — the detectors need continuity across the boundary
   * — but nothing is reported.
   */
  update(tracks: readonly VisitorTrack[], now: number, stable = true): BehaviorEvent[] {
    if (this.disposed) throw new Error('behaviour runtime is disposed');
    const companion = this.watcher.update([...tracks], now, stable);
    if (!this.wasm) return companion;
    try {
      return this.stepWasm(this.wasm, tracks, now, stable, companion);
    } catch {
      // Deliberately without the thrown payload: the boundary is not an
      // authorised channel for observation coordinates or arbitrary data.
      this.retire('WASM failed or diverged; continued with live TS behaviour');
      return companion;
    }
  }

  private stepWasm(
    wasm: WasmBehavior,
    tracks: readonly VisitorTrack[],
    now: number,
    stable: boolean,
    companion: readonly BehaviorEvent[],
  ): BehaviorEvent[] {
    // Ids cross as numbers, so the shell's spelling is translated out and back.
    // Built from this frame's tracks, so it is bounded by the room's capacity
    // and cannot retain anyone who has left.
    const spelling = new Map<number, string>();
    const observed: ObservedTrack[] = tracks.map((track) => {
      const sequence = trackSequence(track.id);
      if (sequence === null) throw new Error('unrecognised track id');
      spelling.set(sequence, track.id);
      return {
        id: `t-${sequence}`,
        x: track.position.x,
        y: track.position.y,
        width: track.extent.width,
        velocityX: track.velocity.x,
        velocityY: track.velocity.y,
        speed: track.speed,
        path: track.path,
      };
    });

    const decoded = decodeBehaviorFrame(wasm.step(encodeBehaviorFrame(now, stable, observed)));
    const events: BehaviorEvent[] = decoded.events.map((event) => ({
      kind: event.kind,
      at: event.at,
      subjects: event.subjects.map((subject) => {
        const sequence = trackSequence(subject);
        // A subject the room cannot name is a boundary that has drifted, not a
        // visitor. Falling back is the honest response; guessing is not.
        const spelled = sequence === null ? undefined : spelling.get(sequence);
        if (!spelled) throw new Error('named a track this frame did not carry');
        return spelled;
      }),
    }));
    if (!agrees(events, companion)) throw new Error('parity');
    return events;
  }

  /**
   * Forget everyone, and every cooldown. Nothing here is ever persisted.
   *
   * Deliberately *not* called by the operator's "reset room memory". That
   * button erases what the room remembers; it does not remove the visitors
   * standing in front of it, and the cooldowns are what stop the room
   * announcing the same thing twice to the same people. Clearing them there
   * would let the room repeat, seconds later, a line it had just said — the
   * one failure the voice rules call worse than silence. This is for
   * restarting sensing, where the tracks themselves are gone.
   */
  reset() {
    this.watcher.reset();
    try {
      this.wasm?.clear();
    } catch {
      this.retire('WASM reset failed; continued with TS behaviour');
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.watcher.reset();
    this.release();
  }

  private retire(reason: string) {
    this.label = `TypeScript behaviour — ${reason}`;
    this.release();
  }

  private release() {
    const previous = this.wasm;
    this.wasm = null;
    // A trapped destructor must not prevent fallback or component cleanup.
    try {
      previous?.free();
    } catch { /* already retired */ }
  }
}

/** Kept as a runtime URL so frontend builds need no generated WASM files. */
export async function loadWasmBehavior(): Promise<WasmBehavior> {
  const url = '/wasm/room_wasm.js';
  const bindings = await import(/* @vite-ignore */ url);
  await bindings.default();
  return new bindings.WasmBehaviorEngine();
}

/**
 * Startup is bounded. A slow import can finish after fallback or unmount; its
 * engine is then freed, never installed into a running TS session.
 */
export async function startBehavior(
  search: string,
  load: () => Promise<WasmBehavior> = loadWasmBehavior,
  timeoutMs = 5_000,
): Promise<BehaviorRuntime> {
  if (new URLSearchParams(search).get('behavior') === 'ts') return new BehaviorRuntime();
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.resolve().then(load).then((engine) => {
    if (abandoned) {
      try { engine.free(); } catch { /* late instance cannot block fallback */ }
      throw new Error('retired');
    }
    return engine;
  });
  try {
    const engine = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return new BehaviorRuntime(engine);
  } catch {
    abandoned = true;
    return new BehaviorRuntime(null, 'WASM unavailable; check the local WASM build');
  } finally {
    clearTimeout(timer);
  }
}

/** Attach once; cleanup also retires a startup that is still awaiting WASM. */
export function mountBehavior(
  search: string,
  attach: (runtime: BehaviorRuntime | null) => void,
  start: (search: string) => Promise<BehaviorRuntime> = startBehavior,
): () => void {
  let retired = false;
  let runtime: BehaviorRuntime | null = null;
  void start(search).then((started) => {
    if (retired) { started.dispose(); return; }
    runtime = started;
    attach(started);
  });
  return () => {
    retired = true;
    runtime?.dispose();
    attach(null);
  };
}

/** Re-exported so a caller needs one import for what the room can notice. */
export type { BehaviorEvent, BehaviorKind };
