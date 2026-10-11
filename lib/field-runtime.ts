/**
 * The memory field, advanced once per batch, optionally in Rust.
 *
 * Third and last of the ported engines to go live, after `tracking-runtime.ts`
 * and `attention-runtime.ts`, and the same shape for the same reasons: a WASM
 * engine drives the room only while a live TypeScript companion agrees with it,
 * and a trap, a malformed snapshot or a disagreement retires WASM and leaves
 * the companion — which has been advancing on the same deposits all along —
 * holding the field the renderer is already pointed at.
 *
 * That last clause is the difference from the other two. Tracking and interest
 * hand back small records; this owns 2,304 cells that the swarm samples every
 * few frames and that `memoryDensity` reads to choose the room's personality.
 * So the companion's `Float32Array` *is* the field, handed out once and never
 * replaced. WASM's snapshot is compared against it and discarded. A fallback
 * therefore changes nothing any caller is holding, which is what makes it
 * invisible on the wall — and the wall is the only place it would show.
 *
 * # Why the batch, and why decay is a batch of its own
 *
 * `FieldEngine::step` applies every deposit and then decays, so the boundary is
 * crossed once per batch rather than once per visitor. The shell already has a
 * natural batch: deposits accumulate through an analysis frame, and decay
 * happens on the fifteen-second upkeep tick. Sending the pending deposits with
 * whatever decay is due preserves the order TypeScript applies them in —
 * deposits at the instant they arrive, decay at the instant the timer fires —
 * because a deposit is additive and a decay is multiplicative, and
 * `decay(a + b)` is not `decay(a) + b`.
 *
 * # What crosses, and what cannot
 *
 * Four numbers per deposit: x, y, amount, radius. There is no route here for a
 * camera frame, a track id, or anything with a name — the engine's validation
 * would refuse the shape, and the shape is all a deposit has ever been.
 */
import {
  FIELD_HEIGHT,
  FIELD_WIDTH,
  createMemoryField,
  decayMemory,
  depositMemory,
  observedDeposits,
} from './memory-engine.ts';
import type { FieldDecay } from './room-upkeep.ts';
import type { Point, VisitorTrack } from './room-types.ts';

export interface WasmField {
  step(deposits: Float64Array, elapsed: number, halfLife: number, empty: number): Float32Array;
  restore(field: Float32Array): void;
  reset(): void;
  free(): void;
}

/** Four numbers per deposit, as `room_engine::field_engine` declares them. */
export const DEPOSIT_STRIDE = 4;

/**
 * Most deposits one batch may carry, matching `field_engine::MAX_DEPOSITS`.
 *
 * `TRACKS_MAX` (12) visitors plus eight for recalls and remembered voices. A
 * batch past this is refused rather than trimmed: dropping the overflow would
 * send the two engines different work and retire WASM on the disagreement
 * instead — the same outcome, reported as the wrong fault.
 */
export const MAX_DEPOSITS = 20;

/**
 * How far the two fields may differ, per cell, before WASM is retired.
 *
 * Exported so the test that brackets it reads this value rather than a copy.
 * The field is `f32` on both sides and the arithmetic is the same sequence of
 * multiplies and adds, so the measured difference is zero; this is the width of
 * the claim, not a measurement of the error.
 */
export const FIELD_PARITY_TOLERANCE = 1e-6;

const RUNNING = 'Rust/WASM memory field (verified against TS)';

export class FieldRuntime {
  /**
   * The field itself, handed out once.
   *
   * Callers keep this reference — the renderer uploads it as a texture — so it
   * is mutated in place and never reassigned, including through a reset.
   */
  readonly values: Float32Array;
  private pending: number[] = [];
  private disposed = false;
  // A plain field rather than a parameter property: the burn-in runs modules
  // like this one under Node's strip-only TypeScript, which does not support
  // them, and the twelve-hour gate is worth more than the shorter constructor.
  private wasm: WasmField | null;
  label: string;

  constructor(values?: ArrayLike<number>, wasm: WasmField | null = null, reason?: string) {
    this.values = createMemoryField(values);
    this.wasm = wasm;
    this.label = wasm ? RUNNING
      : reason ? `TypeScript memory field — ${reason}` : 'TypeScript memory field';
    if (wasm) this.adopt();
  }

  /**
   * Put an engine behind a field that is already running.
   *
   * The alternative was to build a second runtime once WASM arrives and swap it
   * in, which would hand the renderer a different `Float32Array` mid-session —
   * and the renderer uploads that array as a texture. Attaching keeps one field
   * for the life of the room and makes the engine the only thing that appears.
   * The engine adopts whatever the room has remembered so far rather than
   * starting empty behind a field that is not.
   */
  attach(wasm: WasmField, reason?: string) {
    if (this.disposed || this.wasm) {
      try { wasm.free(); } catch { /* a late engine cannot block anything */ }
      return;
    }
    if (!reason) {
      this.wasm = wasm;
      this.label = RUNNING;
      this.adopt();
      return;
    }
    try { wasm.free(); } catch { /* nothing holds it */ }
    this.label = `TypeScript memory field — ${reason}`;
  }

  /**
   * One deposit, applied to the field now and queued for the engine.
   *
   * Applied immediately because everything downstream reads `values` without
   * asking this object's permission, and queued because the boundary is crossed
   * per batch.
   */
  deposit(point: Pick<Point, 'x' | 'y'>, amount: number, radius = 2) {
    if (this.disposed) throw new Error('field runtime is disposed');
    depositMemory(this.values, point, amount, radius);
    if (!this.wasm) return;
    if (this.pending.length >= MAX_DEPOSITS * DEPOSIT_STRIDE) {
      this.retire('more deposits in one batch than the engine accepts');
      return;
    }
    this.pending.push(point.x, point.y, amount, radius);
  }

  /**
   * Everything the observed visitors deposit this frame.
   *
   * The rule about how much a still visitor leaves against a walking one lives
   * in `memory-engine.ts` and is read from there, never restated here.
   */
  depositObserved(
    tracks: VisitorTrack[],
    project: (point: Point) => Pick<Point, 'x' | 'y'>,
    scale: (track: VisitorTrack) => number = () => 1,
  ) {
    for (const { point, amount, radius } of observedDeposits(tracks, project, scale)) {
      this.deposit(point, amount, radius);
    }
  }

  /** Send the pending deposits. Nothing decayed; this is an analysis frame. */
  flush() {
    this.decayed();
  }

  /**
   * The field has already been decayed by exactly these; catch the engine up.
   *
   * Past tense, and the contract is the whole reason for the name: everything
   * here runs *after* the TypeScript has moved the field, so this compares
   * rather than runs the room. `upkeep` returns what it decayed for this, and
   * a caller that decays the field itself wants `decay` below, which does both.
   */
  decayed(decays: readonly FieldDecay[] = []) {
    if (this.disposed) throw new Error('field runtime is disposed');
    const batch = this.pending;
    this.pending = [];
    const wasm = this.wasm;
    if (!wasm) return;
    // A batch with nothing in it and nothing to decay is not worth a crossing.
    if (!batch.length && !decays.length) return;
    try {
      // The engine applies deposits and then one decay, so several decays in a
      // turn are several calls. The deposits ride with the first, which is the
      // order TypeScript used: they landed before the timer fired.
      const deposits = new Float64Array(batch);
      if (!decays.length) {
        this.check(wasm.step(deposits, 0, MIN_HALF_LIFE, 1));
        return;
      }
      let snapshot: Float32Array | null = null;
      for (const [index, decay] of decays.entries()) {
        snapshot = wasm.step(
          index === 0 ? deposits : EMPTY_BATCH,
          decay.seconds,
          decay.halfLifeMinutes,
          decay.emptyMultiplier,
        );
      }
      // Only the last one. The caller has applied every decay by now, so an
      // intermediate snapshot is the engine partway through a sequence the
      // companion has already finished — comparing against it would report a
      // divergence on the one turn of the year the room decays twice, which is
      // the night, which is when nobody is watching to notice it was wrong.
      if (snapshot) this.check(snapshot);
    } catch {
      // Deliberately without the thrown payload: the boundary is not an
      // authorised channel for observation coordinates or arbitrary data.
      this.retire('WASM failed or diverged; continued with live TS field');
    }
  }

  /** Compare a returned snapshot against the field the room is drawing. */
  private check(snapshot: Float32Array) {
    if (snapshot.length !== this.values.length) throw new Error('wrong field size');
    for (let index = 0; index < snapshot.length; index += 1) {
      const mine = this.values[index] ?? 0;
      const theirs = snapshot[index] ?? 0;
      if (!Number.isFinite(theirs) || Math.abs(mine - theirs) > FIELD_PARITY_TOLERANCE) {
        throw new Error('parity');
      }
    }
  }

  /**
   * Decay the field outside the upkeep loop, recording it the same way.
   *
   * The burn-in and the simulation drive the room without the React timer, so
   * they need the same pair of effects — the field moves, and the engine is
   * told the same thing — from one call.
   */
  decay(seconds: number, halfLifeMinutes: number, emptyMultiplier = 1) {
    decayMemory(this.values, seconds, halfLifeMinutes, emptyMultiplier);
    this.decayed([{ seconds, halfLifeMinutes, emptyMultiplier }]);
  }

  /**
   * Whatever just happened to the field, the engine is now holding it too.
   *
   * For the mutations that are not deposits or decays: the opening day's ramp
   * scales every cell, and a restored room replaces the lot. Pushing the
   * companion across is honest about which side is authoritative, and is why
   * those call sites need no engine-shaped rewrite.
   */
  adopt() {
    if (!this.wasm) return;
    this.pending = [];
    try { this.wasm.restore(this.values); }
    catch { this.retire('WASM refused the field; continued with live TS field'); }
  }

  /**
   * The field a saved room was holding, replacing whatever is here.
   *
   * Takes `ArrayLike` because persistence stores a plain array — the same
   * reason `createMemoryField` does — and truncates rather than trusting the
   * length, because a room written by an older build with a different grid is
   * exactly the case `memory-records.ts` exists for one level up.
   */
  restore(values: ArrayLike<number>) {
    this.values.set(Array.from(values).slice(0, this.values.length));
    this.adopt();
  }

  /**
   * Multiply every cell, for the opening day's ramp.
   *
   * The room fades its memory up over the first minutes rather than switching
   * it on, and that is a whole-field operation the engine has no command for.
   * Scaling here and adopting is honest about which side did it.
   */
  scale(factor: number) {
    for (let index = 0; index < this.values.length; index += 1) {
      this.values[index] = (this.values[index] ?? 0) * factor;
    }
    this.adopt();
  }

  /** Cleared with the rest of the room. */
  reset() {
    this.values.fill(0);
    this.pending = [];
    try { this.wasm?.reset(); }
    catch { this.retire('WASM reset failed; continued with TS field'); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = [];
    this.release();
  }

  private retire(reason: string) {
    this.label = `TypeScript memory field — ${reason}`;
    this.pending = [];
    this.release();
  }

  private release() {
    const previous = this.wasm;
    this.wasm = null;
    // A trapped destructor must not prevent fallback or component cleanup.
    try { previous?.free(); } catch { /* already retired */ }
  }
}

/** Allocated once: a batch with no deposits is the common case. */
const EMPTY_BATCH = new Float64Array(0);

/**
 * The half-life sent when nothing is decaying.
 *
 * `FieldEngine::step` validates its decay parameters whether or not it uses
 * them, and refuses a half-life outside one to 1,440 minutes. Zero elapsed
 * means no decay runs, so this number reaches nothing; it is the bottom of the
 * engine's accepted range rather than a value with a meaning.
 */
const MIN_HALF_LIFE = 1;

/** Kept as a runtime URL so frontend builds need no generated WASM files. */
export async function loadWasmField(): Promise<WasmField> {
  const url = '/wasm/room_wasm.js';
  const bindings = await import(/* @vite-ignore */ url);
  await bindings.default();
  return new bindings.WasmFieldEngine();
}

/**
 * Load an engine, bounded.
 *
 * A slow import can finish after fallback or unmount; the engine is then freed
 * rather than installed into a running TypeScript session. Returns the reason
 * instead of throwing, because every caller here has a working room already and
 * needs a sentence for the console rather than an exception.
 */
export async function startField(
  search: string,
  load: () => Promise<WasmField> = loadWasmField,
  timeoutMs = 5_000,
): Promise<{ engine: WasmField | null; reason?: string }> {
  if (new URLSearchParams(search).get('field') === 'ts') return { engine: null };
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
    return { engine };
  } catch {
    abandoned = true;
    return { engine: null, reason: 'WASM unavailable; check the local WASM build' };
  } finally {
    clearTimeout(timer);
  }
}

/** Attach once; cleanup retires a startup that is still awaiting WASM. */
export function mountField(
  search: string,
  runtime: FieldRuntime,
  start: (search: string) => Promise<{ engine: WasmField | null; reason?: string }> = startField,
): () => void {
  let retired = false;
  void start(search).then(({ engine, reason }) => {
    if (retired) {
      try { engine?.free(); } catch { /* nothing holds it */ }
      return;
    }
    if (engine) runtime.attach(engine);
    else if (reason) runtime.attach(NO_ENGINE, reason);
  });
  return () => { retired = true; };
}

/**
 * Stands in for an engine that never arrived, so `attach` has one way in.
 *
 * Nothing calls its methods: `attach` frees it and records the reason. It
 * exists so a failure reports through the same door as a success rather than
 * through a second field nobody can see being set.
 */
const NO_ENGINE: WasmField = {
  step: () => new Float32Array(0),
  restore: () => {},
  reset: () => {},
  free: () => {},
};

export { FIELD_HEIGHT, FIELD_WIDTH };
