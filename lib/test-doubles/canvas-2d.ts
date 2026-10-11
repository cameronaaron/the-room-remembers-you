/**
 * A 2D context that remembers what it was asked to draw.
 *
 * The trace renderer's failure mode is not a wrong pixel, it is a draw path
 * that quietly does nothing — an early return that fires for every input, a
 * loop over an empty list, a style set on a context nobody then strokes. On a
 * wall that is indistinguishable from an empty gallery, which is precisely the
 * silent failure this installation is built to avoid everywhere else.
 *
 * So this records calls rather than rasterising. It answers "did anything get
 * drawn, and how much" — never "did it look right", which is what the reference
 * captures in `docs/` are for.
 *
 * The installation harness has its own context recorder wired to a camera
 * scene; this is the standalone one, for calling a drawing function directly.
 */

export type Call = { method: string; args: unknown[] };

export type RecordingContext = CanvasRenderingContext2D & {
  /** Every method call, in order. */
  calls: Call[];
  /** Every property assignment — `fillStyle`, `globalAlpha`, and so on. */
  assignments: Array<{ property: string; value: unknown }>;
  /** Calls to one method, in order. */
  callsTo(method: string): Call[];
  /** How many times a method was called. */
  countOf(method: string): number;
  /** Anything that puts marks on the surface, as opposed to setting up state. */
  readonly markCount: number;
  /** Values assigned to a property, in order. */
  valuesOf(property: string): unknown[];
};

/** Calls that actually put something on the surface. */
const MARKING = new Set([
  'fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'strokeText',
  'putImageData', 'drawImage',
]);

/**
 * Methods whose return value is used by the code under test, so they cannot
 * simply record and return undefined.
 */
function builtIn(calls: Call[], key: string) {
  if (key === 'createImageData') {
    return (width: number, height: number) => ({
      width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' as const,
    });
  }
  if (key === 'getImageData') {
    return (_x: number, _y: number, width: number, height: number) => ({
      width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' as const,
    });
  }
  if (key === 'createRadialGradient' || key === 'createLinearGradient') {
    return (...args: unknown[]) => {
      const stops: Array<[number, string]> = [];
      calls.push({ method: key, args });
      return { addColorStop: (at: number, colour: string) => { stops.push([at, colour]); }, stops };
    };
  }
  if (key === 'measureText') {
    // Enough for layout arithmetic to be exercised; not a font metric.
    return (text: string) => ({ width: String(text).length * 6 });
  }
  return null;
}

export function recordingContext(): RecordingContext {
  const calls: Call[] = [];
  const assignments: Array<{ property: string; value: unknown }> = [];
  const own: Record<string, unknown> = {
    calls,
    assignments,
    callsTo: (method: string) => calls.filter((call) => call.method === method),
    countOf: (method: string) => calls.filter((call) => call.method === method).length,
    valuesOf: (property: string) =>
      assignments.filter((entry) => entry.property === property).map((entry) => entry.value),
  };

  return new Proxy(own, {
    get(target, key) {
      if (key === 'markCount') return calls.filter((call) => MARKING.has(call.method)).length;
      if (key in target) return Reflect.get(target, key);
      const special = builtIn(calls, String(key));
      if (special) return special;
      return (...args: unknown[]) => { calls.push({ method: String(key), args }); };
    },
    set(target, key, value) {
      assignments.push({ property: String(key), value });
      Reflect.set(target, key, value);
      return true;
    },
  }) as unknown as RecordingContext;
}
