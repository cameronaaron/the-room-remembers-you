/**
 * The canvas the particle field is drawn on, and the one rule that governs it.
 *
 * **A canvas element is consumed by the first graphics API it is asked for, and
 * nothing gives it back.** Measured in this machine's Chrome rather than taken
 * from the specification, because the specification is weaker than the
 * behaviour and the difference is the whole reason this module exists:
 *
 * | what was done to a canvas | can it then hold a WebGL2 context |
 * | --- | --- |
 * | nothing | yes |
 * | `getContext('webgpu')` and configured | no |
 * | configured, then `unconfigure()` and `device.destroy()` | no |
 * | `getContext('webgpu')` alone, never configured | **no** |
 * | `getContext('webgl2')`, then asked for `'webgpu'` | no, in that direction too |
 *
 * Two of those rows are stronger than what `webgpu-renderer.ts` records. There
 * is no cleanup path — destroying the device does not release the element — and
 * *asking* is enough, so an attempt that refuses after `getContext` has already
 * spent the canvas. The exclusivity also runs both ways, so this is not a
 * WebGPU quirk to be routed around but a property of canvases.
 *
 * `app/globals.css` already knew half of it: the particle field and the trace
 * renderer have separate elements because one canvas cannot hold both a WebGL2
 * and a 2D context. This is the same rule over time rather than at one instant.
 *
 * ## What went wrong without it
 *
 * The installation had one `<canvas>` for the life of the page, so the backend
 * was fixed by whichever API was asked for first, and three things that look
 * unrelated were all this:
 *
 * * An operator changing **Graphics backend** in the console got a fallback and
 *   a sentence explaining it, forever, because the element had already held the
 *   other API. The setting appeared to work and only took effect on a reload.
 * * A WebGPU device loss — a projector renegotiating, a driver resetting, the
 *   ordinary event this installation is built to survive — rebuilt onto the
 *   same element. If the adapter had not come back, WebGL2 was refused by the
 *   canvas rather than by the machine, and the room dropped to Canvas 2D traces
 *   for the rest of the day on hardware that could have run the field.
 * * A WebGPU attempt that failed *after* `getContext` left `startRoomRenderer`
 *   falling back onto a canvas it had already spent.
 *
 * All three are silent. This room is dark by design and lit only by the field,
 * so a thinner renderer looks like a quieter gallery — the same indistinguish-
 * ability `renderer-health.ts` and `diagnoseSensing` exist for one layer up.
 *
 * ## The rule, as code
 *
 * A renderer is never handed an element; it is handed this, and takes a `fresh`
 * one for every construction it attempts. The host is a positioned wrapper that
 * stays put in the render tree, so React owns where the field is and this owns
 * what it is drawn on — which is a resource with a lifetime, not markup.
 */

/** What `startRoomRenderer` needs. A renderer never picks its own element. */
export type RenderSurface = {
  /**
   * A canvas that has never been asked for a graphics context.
   *
   * Retires the previous one, which is why a caller must take it immediately
   * before constructing and must not hold one across attempts.
   */
  fresh(): HTMLCanvasElement;
  /** The element currently mounted, for attaching listeners to. */
  current(): HTMLCanvasElement | null;
  /** Retire whatever is mounted. The room is drawing without a GPU surface. */
  release(): void;
};

/**
 * The class the field's canvases carry.
 *
 * The host keeps `projection-swarm`'s stacking position; the canvas inside it
 * fills it. Both are in `globals.css` and neither is a colour, so this is not
 * the literal `palette.ts` forbids.
 */
export const SURFACE_CLASS = 'projection';

export class GpuSurface implements RenderSurface {
  private readonly host: HTMLElement;
  private readonly make: () => HTMLCanvasElement;
  private mounted: HTMLCanvasElement | null = null;
  /**
   * How many elements this surface has spent.
   *
   * Bounded by construction attempts, not by time: a renderer is built on
   * startup, on a backend change and on a rebuild after a device loss, and
   * `RendererHealth` abandons the GPU after repeated losses rather than
   * recovering forever. Reported because an operator watching this climb is
   * watching a machine lose its GPU over and over, which no single line of
   * status can say.
   */
  spent = 0;

  constructor(host: HTMLElement, make: () => HTMLCanvasElement = defaultCanvas) {
    this.host = host;
    this.make = make;
  }

  fresh(): HTMLCanvasElement {
    this.release();
    const canvas = this.make();
    canvas.className = SURFACE_CLASS;
    // The field is not content. A screen reader announcing a canvas of
    // particles would be reading out the room's memory as an image description.
    canvas.setAttribute('aria-hidden', 'true');
    this.host.appendChild(canvas);
    this.mounted = canvas;
    this.spent += 1;
    return canvas;
  }

  current(): HTMLCanvasElement | null {
    return this.mounted;
  }

  release() {
    const previous = this.mounted;
    this.mounted = null;
    // A spent canvas is unusable but not harmless: it holds a drawing buffer
    // the size of the projection until it is collected, and on a machine
    // losing its GPU repeatedly those accumulate. Detaching is what lets it go.
    previous?.remove();
  }
}

function defaultCanvas(): HTMLCanvasElement {
  return document.createElement('canvas');
}
