/**
 * The room's interest, decided once per sensing frame, optionally in Rust.
 *
 * This is the same shape as `tracking-runtime.ts` and for the same reasons: a
 * WASM engine drives the room only while a live TypeScript companion agrees
 * with it, and a trap, a malformed frame or a disagreement retires WASM and
 * leaves the companion — which has been advancing on the same evidence all
 * along — holding a complete, unbroken spell. Interest is rare and lasts
 * sixty-four seconds; restarting it empty mid-spell would be visible as the
 * room losing its train of thought, which is the one thing this subsystem
 * exists to suggest it has.
 *
 * It also absorbs `EvidenceGate`. In Rust the gate lives *inside*
 * `AttentionEngine` — the twenty-second spacing is the engine's rule, not a
 * caller's courtesy — so a shell that kept its own gate and filed dwell
 * directly would be holding half the subsystem on the other side of the
 * boundary and would find the two halves disagreeing about which frame a
 * filing landed on.
 *
 * # Interest is a per-frame decision, not a curve sampled at will
 *
 * `RoomAttention.focus(now)` recomputes the attack/hold/fade curve at whatever
 * instant the caller passes. That cannot be made to agree with an engine on
 * the other side of a boundary, which decides once per frame and hands back a
 * number: the caller would be comparing a value from this instant against a
 * value from the last frame and would retire WASM on the difference.
 *
 * So the read model here is explicit. The room decides on a sensing frame and
 * `decision()` reports what it decided; `depositScale` and `favours` read that
 * and take no clock at all. This is a deliberate change from sampling the
 * curve at each call site, and the size of it is bounded and small: within one
 * sensing frame the weight moves by at most `dt / INTEREST_ATTACK_MS`, which
 * at 24 Hz is 0.0105, and it moves at all only during the four-second attack
 * and the fifteen-second fade — during the forty-five-second hold the weight
 * is exactly 1 either way. The largest effect on the artwork is a deposit
 * multiplier of at most 1.45 being at most 0.0047 out, for one visitor, for a
 * few seconds, a few times a day. In exchange the two implementations agree by
 * construction rather than approximately.
 *
 * It is also the model the engine should have had. Coupling a simulation's
 * correctness to when a caller happens to ask is exactly what an explicit `dt`
 * is for avoiding.
 */
import {
  type AttentionEvidence,
  type Decision,
  type FileableEvidence,
  type RoomInterest,
  ATTENDED_DEPOSIT_GAIN,
  RoomAttention,
} from './attention.ts';
import { EvidenceGate } from './attention-evidence.ts';
import {
  type AttentionFrame,
  type Filing,
  decodeAttentionFrame,
  encodeAttentionFrame,
  MAX_FILINGS,
} from './attention-bridge.ts';
import { trackSequence as sequenceOf } from './track-bridge.ts';
import type { VisitorTrack } from './room-types.ts';

export interface WasmAttention {
  step(frame: Float64Array): Float64Array;
  clear(): void;
  free(): void;
}

/** Nobody, in the room's own spelling of the state. */
const NOBODY: Decision = Object.freeze({ trackId: null, weight: 0 });


/**
 * How far the two weights may differ before WASM is retired.
 *
 * Exported so the test that brackets it reads this value rather than a copy of
 * it. A bracket written against a literal is two constants the compiler folds
 * into `true`, which is a tautology wearing an assertion's clothes: change the
 * tolerance and the brackets silently stop straddling it while the test still
 * passes. The parity harness uses the same absolute figure.
 */
export const INTEREST_PARITY_TOLERANCE = 1e-6;

/** A disagreement is a decision, so both parts are compared exactly. */
function agrees(wasm: Decision, companion: Decision): boolean {
  return wasm.trackId === companion.trackId
    && Math.abs(wasm.weight - companion.weight) <= INTEREST_PARITY_TOLERANCE;
}

export class AttentionRuntime implements RoomInterest {
  private readonly room = new RoomAttention();
  private readonly gate = new EvidenceGate();
  private buffered: Filing[] = [];
  private decided: Decision = NOBODY;
  private disposed = false;
  // A plain field rather than a parameter property: the burn-in runs this
  // module under Node's strip-only TypeScript, which does not support them,
  // and the twelve-hour gate is worth more than the shorter constructor.
  private wasm: WasmAttention | null;
  label: string;

  constructor(wasm: WasmAttention | null = null, reason?: string) {
    this.wasm = wasm;
    this.label = wasm ? 'Rust/WASM interest (verified against TS)'
      : reason ? `TypeScript interest — ${reason}` : 'TypeScript interest';
  }

  /**
   * A revisit or a crossing, at the instant it happened.
   *
   * The companion is told immediately; WASM is told on the next frame, with
   * this instant attached, because a crossing is filed *after* the frame that
   * found it and the two must age the evidence from the same moment.
   */
  observe(kind: FileableEvidence, trackId: string, now: number) {
    if (this.disposed) throw new Error('attention runtime is disposed');
    if (!trackId) return;
    this.room.observe(kind, trackId, now);
    if (!this.wasm) return;
    // Bounded, and refused rather than trimmed. The shell files one crossing
    // and at most a handful of revisits per frame, so reaching this is a defect
    // upstream, and quietly dropping the overflow would send the two engines
    // different evidence and retire WASM on the disagreement instead — the
    // same outcome, reported as the wrong fault.
    if (this.buffered.length >= MAX_FILINGS) {
      this.retire('more filings in one frame than the engine accepts');
      return;
    }
    this.buffered.push({ kind, trackId, at: now });
  }

  /**
   * Advance one sensing frame. `tracks` is the confirmed, currently observed
   * set — the same gate everything downstream of sensing uses.
   */
  update(tracks: readonly VisitorTrack[], now: number): Decision {
    if (this.disposed) throw new Error('attention runtime is disposed');
    // The companion runs in the shell's order: filings already in, then the
    // gate's own, then the decision. That order settles a tie between two
    // visitors who qualify on the same frame.
    for (const evidence of this.gate.observe(tracks, now)) {
      this.room.observe(evidence.kind, evidence.trackId, now);
    }
    this.room.update(tracks.map((track) => track.id), now);
    const focus = this.room.focus(now);
    const companion: Decision = focus
      ? { trackId: focus.trackId, weight: focus.weight }
      : NOBODY;

    const filings = this.buffered;
    this.buffered = [];
    if (!this.wasm) {
      this.decided = companion;
      return companion;
    }
    try {
      this.decided = this.stepWasm(this.wasm, filings, tracks, now, companion);
    } catch {
      // Deliberately without the thrown payload: the boundary is not an
      // authorised channel for observation coordinates or arbitrary data.
      this.retire('WASM failed or diverged; continued with live TS interest');
      this.decided = companion;
    }
    return this.decided;
  }

  private stepWasm(
    wasm: WasmAttention,
    filings: readonly Filing[],
    tracks: readonly VisitorTrack[],
    now: number,
    companion: Decision,
  ): Decision {
    // Ids cross as numbers, so the shell's spelling is translated out and back.
    // Built from this frame's tracks, so it is bounded by the room's capacity
    // and cannot retain anyone who has left.
    const spelling = new Map<number, string>();
    const present = tracks.map((track) => {
      const sequence = sequenceOf(track.id);
      if (sequence === null) throw new Error('unrecognised track id');
      spelling.set(sequence, track.id);
      return { id: `t-${sequence}`, dwellSeconds: track.dwellSeconds, stillFor: track.stillFor };
    });
    const sent = filings.map((filing) => {
      const sequence = sequenceOf(filing.trackId);
      if (sequence === null) throw new Error('unrecognised track id');
      return { kind: filing.kind, trackId: `t-${sequence}`, at: filing.at };
    });

    const frame: AttentionFrame = decodeAttentionFrame(
      wasm.step(encodeAttentionFrame(now, sent, present)),
    );
    const decided: Decision = { trackId: null, weight: frame.weight };
    if (frame.trackId !== null) {
      const sequence = sequenceOf(frame.trackId);
      // An attended track the room cannot name is a boundary that has drifted,
      // not a visitor. Falling back is the honest response; guessing is not.
      const spelled = sequence === null ? undefined : spelling.get(sequence);
      if (!spelled) throw new Error('attended a track this frame did not carry');
      decided.trackId = spelled;
    }
    if (!agrees(decided, companion)) throw new Error('parity');
    return decided;
  }

  decision(): Decision {
    return this.decided;
  }

  depositScale(trackId: string): number {
    return this.decided.trackId === trackId
      ? 1 + ATTENDED_DEPOSIT_GAIN * this.decided.weight
      : 1;
  }

  favours(trackId: string | undefined): number {
    if (!trackId) return 0;
    return this.decided.trackId === trackId ? this.decided.weight : 0;
  }

  /** Cleared with the rest of the room. Nothing here is ever persisted. */
  reset() {
    this.room.reset();
    this.gate.reset();
    this.buffered = [];
    this.decided = NOBODY;
    try { this.wasm?.clear(); }
    catch { this.retire('WASM reset failed; continued with TS interest'); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.room.reset();
    this.gate.reset();
    this.buffered = [];
    this.decided = NOBODY;
    this.release();
  }

  private retire(reason: string) {
    this.label = `TypeScript interest — ${reason}`;
    this.buffered = [];
    this.release();
  }

  private release() {
    const previous = this.wasm;
    this.wasm = null;
    // A trapped destructor must not prevent fallback or component cleanup.
    try { previous?.free(); } catch { /* already retired */ }
  }
}

/** Kept as a runtime URL so frontend builds need no generated WASM files. */
export async function loadWasmAttention(): Promise<WasmAttention> {
  const url = '/wasm/room_wasm.js';
  const bindings = await import(/* @vite-ignore */ url);
  await bindings.default();
  return new bindings.WasmAttentionEngine();
}

/** Startup is bounded. A slow import can finish after fallback or unmount;
 * its engine is then freed, never installed into a running TS session. */
export async function startAttention(
  search: string,
  load: () => Promise<WasmAttention> = loadWasmAttention,
  timeoutMs = 5_000,
): Promise<AttentionRuntime> {
  if (new URLSearchParams(search).get('attention') === 'ts') return new AttentionRuntime();
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
    return new AttentionRuntime(engine);
  } catch {
    abandoned = true;
    return new AttentionRuntime(null, 'WASM unavailable; check the local WASM build');
  } finally {
    clearTimeout(timer);
  }
}

/** Attach once; cleanup also retires a startup that is still awaiting WASM. */
export function mountAttention(
  search: string,
  attach: (runtime: AttentionRuntime | null) => void,
  start: (search: string) => Promise<AttentionRuntime> = startAttention,
): () => void {
  let retired = false;
  let runtime: AttentionRuntime | null = null;
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

/** Re-exported so a caller needs one import for the evidence it may file. */
export type { AttentionEvidence, Decision, FileableEvidence, RoomInterest };
