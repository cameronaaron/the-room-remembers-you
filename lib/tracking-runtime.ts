import { AnonymousTrackManager } from './motion-tracker';
import { decodeTrackFrame, encodeBlobs } from './track-bridge';
import type { MotionBlob, VisitorTrack } from './room-types';

export interface WasmTracker {
  step(blobs: Float64Array, now: number): Float64Array;
  clear(): void;
  free(): void;
}

type Tracks = { active: VisitorTrack[]; ended: VisitorTrack[] };

// The parity harness uses this same absolute tolerance. This live check covers
// discrete decisions too: IDs, flags, counts and array ordering must be exact.
function agrees(actual: unknown, expected: unknown, field = ''): boolean {
  if (field === 'sightings') return actual === expected;
  if (typeof expected === 'number') {
    return typeof actual === 'number' && Number.isFinite(actual)
      && Math.abs(actual - expected) <= 1e-6;
  }
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (actual === null || typeof actual !== 'object') return false;
  const keys = Object.keys(expected);
  if (keys.length !== Object.keys(actual).length) return false;
  return keys.every((key) => agrees(
    (actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], key,
  ));
}

/** A live TS companion preserves history if WASM traps or diverges. No replay
 * log or raw sensor input is retained. Rust output drives the room only while
 * it agrees with the established tracker. This is a migration mode, not a
 * claim that the rest of cognition has moved to Rust. */
export class TrackingRuntime {
  private readonly fallback = new AnonymousTrackManager();
  private disposed = false;
  private recoveries = 0;
  label: string;

  constructor(private wasm: WasmTracker | null = null, reason?: string) {
    this.label = wasm ? 'Rust/WASM tracking (verified against TS)'
      : reason ? `TypeScript tracking — ${reason}` : 'TypeScript tracking';
  }

  update(blobs: MotionBlob[], now: number): Tracks {
    if (this.disposed) throw new Error('tracking runtime is disposed');
    const fallback = this.fallback.update(blobs, now);
    this.recoveries = this.fallback.getFragmentRecoveries();
    if (!this.wasm) return fallback;
    try {
      const frame = decodeTrackFrame(this.wasm.step(encodeBlobs(blobs), now));
      // TS includes birth time in its ephemeral handle; Rust mints only the
      // sequence. Preserve the shell's spelling across failover and reset.
      for (const track of [...frame.active, ...frame.ended]) {
        track.id = `visitor-${track.bornAt.toString(36)}-${track.id.slice(2)}`;
      }
      if (!agrees(frame.active, fallback.active) || !agrees(frame.ended, fallback.ended)
        || frame.fragmentRecoveries !== this.recoveries) {
        throw new Error('parity');
      }
      return { active: frame.active, ended: frame.ended };
    } catch {
      // Deliberately omit the thrown payload: errors from the boundary are not
      // an authorised channel for observation coordinates or arbitrary data.
      this.retire('WASM failed or diverged; continued with live TS state');
      return fallback;
    }
  }

  getFragmentRecoveries() { return this.recoveries; }

  clear() {
    this.fallback.clear();
    this.recoveries = 0;
    try { this.wasm?.clear(); }
    catch { this.retire('WASM reset failed; continued with TS'); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.fallback.clear();
    this.release();
  }

  private retire(reason: string) {
    this.label = `TypeScript tracking — ${reason}`;
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
export async function loadWasmTracker(): Promise<WasmTracker> {
  const url = '/wasm/room_wasm.js';
  const bindings = await import(/* @vite-ignore */ url);
  await bindings.default();
  return new bindings.WasmTrackEngine();
}

/** Startup is bounded. A slow import can finish after fallback or unmount;
 * its engine is then freed, never installed into a running TS session. */
export async function startTracking(
  search: string,
  load: () => Promise<WasmTracker> = loadWasmTracker,
  timeoutMs = 5_000,
): Promise<TrackingRuntime> {
  if (new URLSearchParams(search).get('tracking') === 'ts') return new TrackingRuntime();
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
    return new TrackingRuntime(engine);
  } catch {
    abandoned = true;
    return new TrackingRuntime(null, 'WASM unavailable; check the local WASM build');
  } finally {
    clearTimeout(timer);
  }
}

/** Attach once; cleanup also retires a startup that is still awaiting WASM. */
export function mountTracking(
  search: string,
  attach: (runtime: TrackingRuntime | null) => void,
  start: (search: string) => Promise<TrackingRuntime> = startTracking,
): () => void {
  let retired = false;
  let runtime: TrackingRuntime | null = null;
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
