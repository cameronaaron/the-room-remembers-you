/**
 * Which of the room's four engines the shell starts, and how they are retired.
 *
 * Tracking, interest, behaviour and the memory field each migrate to Rust on
 * their own terms and behind their own query parameter, and each already owns
 * its startup, its five-second bound, its fallback and its disposal. What was
 * left in the render component was the same four lines four times over, plus
 * four `stop` handles to remember to call — a decision about the installation's
 * composition living in a `useEffect` where nothing could call it directly.
 *
 * So it lives here. The component asks for the engines once and gets one
 * handle back, and the ordering property that matters — every engine is
 * retired, even if an earlier one's disposal throws — is a thing a test can
 * reach rather than a thing a reviewer has to notice.
 *
 * # Why one handle rather than four
 *
 * A cleanup that stops at the first failure leaves the rest of the room's
 * engines mounted behind an unmounted component: a WASM instance never freed,
 * a startup still in flight that will attach into a dead ref. That is the
 * shape of a leak that only appears after the tenth device reconnect of an
 * unattended day, which is exactly the class of failure this installation
 * cannot debug after the fact.
 */
import { type RoomInterest } from './attention.ts';
import { type AttentionRuntime, mountAttention } from './attention-runtime.ts';
import { type BehaviorRuntime, mountBehavior } from './behavior-runtime.ts';
import { FieldRuntime, mountField } from './field-runtime.ts';
import { type TrackingRuntime, mountTracking } from './tracking-runtime.ts';

/** Where each engine is attached as it becomes available, or retired. */
export type EngineMounts = {
  tracking: (runtime: TrackingRuntime | null) => void;
  interest: (runtime: AttentionRuntime | null) => void;
  behaviour: (runtime: BehaviorRuntime | null) => void;
  /**
   * The field is handed in rather than attached.
   *
   * Callers *hold* this one — the swarm uploads its cells as a texture and the
   * room's personality reads their density — so it is a live object from the
   * first frame and a WASM engine is installed into it, not swapped for it.
   */
  field: FieldRuntime;
};

/**
 * The four mounts, for a test that needs to stand in for them.
 *
 * Written as the shape this module actually calls rather than as `typeof
 * mountTracking`: each real mount also takes an injectable starter, and a
 * stand-in should not have to carry a parameter nobody here passes. The real
 * functions satisfy this by structure, so the indirection costs no safety.
 */
export type Mounters = {
  tracking: (search: string, attach: EngineMounts['tracking']) => () => void;
  interest: (search: string, attach: EngineMounts['interest']) => () => void;
  behaviour: (search: string, attach: EngineMounts['behaviour']) => () => void;
  field: (search: string, field: FieldRuntime) => () => void;
};

const LIVE: Mounters = {
  tracking: mountTracking,
  interest: mountAttention,
  behaviour: mountBehavior,
  field: mountField,
};

/**
 * Start every engine, and return the one call that retires all of them.
 *
 * `search` is the shell's query string; each engine reads its own parameter
 * out of it and defaults to its verified Rust/WASM implementation, shadowed
 * by a live TypeScript companion that takes over on any divergence or trap.
 * `=ts` is the explicit per-engine opt-out back to TypeScript alone. Retiring
 * is unconditional: a mount that throws on the way down does not prevent the
 * others from coming down, because a half-unmounted installation is worse
 * than a noisy one.
 */
export function mountEngines(
  search: string,
  attach: EngineMounts,
  mounters: Mounters = LIVE,
): () => void {
  const stops = [
    mounters.tracking(search, attach.tracking),
    mounters.interest(search, attach.interest),
    mounters.behaviour(search, attach.behaviour),
    mounters.field(search, attach.field),
  ];
  return () => {
    for (const stop of stops) {
      try {
        stop();
      } catch { /* one engine's disposal must not strand the others */ }
    }
  };
}

// Re-exported so the shell needs one import for the engines and their handles.
// `FieldRuntime` is a value as well as a type: the shell constructs the field
// itself, because callers hold it from the first frame.
export { FieldRuntime };
export type { AttentionRuntime, BehaviorRuntime, RoomInterest, TrackingRuntime };
