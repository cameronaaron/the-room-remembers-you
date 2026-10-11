/**
 * What jsdom is missing, and what it is slow at.
 *
 * Every patch here supplies an answer jsdom already gives, or would give if it
 * implemented the member at all. None of them models layout, animation or the
 * top layer, and no test may assert anything that depends on one of them being
 * more than a stand-in.
 *
 * Test support, not installation code.
 */
import type { DOMWindow } from 'jsdom';

/** No-op observers. Nothing here measures anything, because nothing has a size. */
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/**
 * jsdom implements no fullscreen element, no modal dialog and no open popover,
 * so `false` is what it returns for all three — but it reaches that answer
 * through nwsapi, which walks the document for each one. Measured opening a
 * single popover: 110,613,467 `:fullscreen` matches and twenty seconds,
 * entirely inside the selector engine. The answer is unchanged; only the walk
 * is gone. Nothing may test fullscreen or top-layer behaviour through this.
 */
const TOP_LAYER = new Set([':fullscreen', ':modal', ':popover-open']);

/** Apply every quirk fix to one jsdom window. Safe to call twice. */
export function patchJsdom(w: DOMWindow) {
  // jsdom has no PointerEvent. Preserve the mouse fields Base UI's synthetic
  // click forwarding reads, without pretending to model layout.
  class PointerEvent extends w.MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(kind: string, init: PointerEventInit = {}) {
      super(kind, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? 'mouse';
    }
  }
  Object.defineProperty(w, 'PointerEvent', { value: PointerEvent, configurable: true });
  w.matchMedia = (query: string) => Object.assign(new w.EventTarget(), {
    matches: w.innerWidth < 768, media: query, onchange: null,
  }) as MediaQueryList;

  // Libraries measuring their own layout reach for the observers through the
  // window their element belongs to, not through globalThis.
  Object.defineProperty(w, 'ResizeObserver', { value: Observer, configurable: true });
  Object.defineProperty(w, 'IntersectionObserver', { value: Observer, configurable: true });

  const nativeMatches = Reflect.get(w.Element.prototype, 'matches') as (this: Element, selector: string) => boolean;
  Object.defineProperty(w.Element.prototype, 'matches', {
    configurable: true,
    writable: true,
    value: function (this: Element, selector: string) {
      if (TOP_LAYER.has(selector)) return false;
      return nativeMatches.call(this, selector);
    },
  });

  // jsdom runs no animations, so an empty list is the true answer — but it does
  // not implement the method, and a scroll area asks for it from a timer where
  // a TypeError takes down the process rather than failing a test. Supplying it
  // is also what makes Base UI wait for an exit animation that will never play
  // here, so its own escape hatch says there is nothing to wait for.
  w.Element.prototype.getAnimations = function () { return []; };
  (globalThis as Record<string, unknown>).BASE_UI_ANIMATIONS_DISABLED = true;

  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.scrollTo = function () {};

  return { Observer };
}

/** The globals a jsdom window has that Node does not, ready for overrideGlobals. */
export function browserGlobals(w: DOMWindow) {
  return {
    HTMLElement: w.HTMLElement, HTMLInputElement: w.HTMLInputElement, HTMLTextAreaElement: w.HTMLTextAreaElement,
    Element: w.Element, Node: w.Node, DocumentFragment: w.DocumentFragment, MutationObserver: w.MutationObserver,
    DOMRect: w.DOMRect, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, PointerEvent: w.PointerEvent,
    Event: w.Event, NodeFilter: w.NodeFilter, DataTransfer: w.DataTransfer, Blob: w.Blob, File: w.File,
    getComputedStyle: w.getComputedStyle.bind(w),
    ResizeObserver: Observer, IntersectionObserver: Observer,
  };
}
