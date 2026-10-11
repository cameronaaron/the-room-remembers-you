import { JSDOM } from 'jsdom';
import { overrideGlobals } from './browser.ts';
import { browserGlobals, patchJsdom } from './jsdom-quirks.ts';
import type { ReactNode } from 'react';

export const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
const w = dom.window;
patchJsdom(w);
export const restoreDom = overrideGlobals({
  ...browserGlobals(w),
  window: w, document: w.document, navigator: w.navigator,
  requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
  IS_REACT_ACT_ENVIRONMENT: true,
});
/**
 * React DOM detects browser event support at import time, and Base UI resolves
 * the document its portals attach to the same way. Both are why this module
 * initializes the DOM before importing either, and why a test file must import
 * this fixture before any component: a component imported first renders into
 * nothing at all, silently, with no error anywhere to say so.
 */
const { createRoot } = await import('react-dom/client');
export const { act } = await import('react');
export async function mount(node: ReactNode) {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(node); });
  return {
    container,
    async render(next: ReactNode) { await act(async () => { root.render(next); }); },
    async close() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}
export async function click(element: Element | null) {
  if (!(element instanceof w.HTMLElement)) throw new Error('Expected a clickable element');
  await act(async () => { element.click(); });
}

/**
 * Tell self-measuring containers how big they are, for one test.
 *
 * A component that sizes itself from a ResizeObserver — a responsive chart, a
 * virtualised list — renders nothing at all when the observer never reports,
 * which is what jsdom does. Answering with a size is the one thing a layout
 * engine would do here, and it is what makes the component's *content*
 * reachable: the labels, the colours, the empty state.
 *
 * It is not a layout model and it does not license an assertion about one.
 * Nothing may check a position, a size or an overflow through it.
 */
export async function withMeasuredLayout<T>(
  size: { width: number; height: number },
  body: () => Promise<T>,
): Promise<T> {
  const saved = Object.getOwnPropertyDescriptor(w, 'ResizeObserver')!;
  class Sized {
    constructor(private readonly report: ResizeObserverCallback) {}
    observe(target: Element) {
      const contentRect = { ...size, top: 0, left: 0, x: 0, y: 0, right: size.width, bottom: size.height };
      this.report([{ target, contentRect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(w, 'ResizeObserver', { configurable: true, value: Sized });
  const restoreGlobal = overrideGlobals({ ResizeObserver: Sized });
  try {
    return await body();
  } finally {
    Object.defineProperty(w, 'ResizeObserver', saved);
    restoreGlobal();
  }
}

/**
 * Type into a field the way a person does.
 *
 * React installs its own `value` setter on the element, so assigning to
 * `input.value` updates what is on screen and leaves React's copy behind —
 * the field shows the text and every handler is told nothing. Writing through
 * the prototype's own setter is what makes the change real.
 */
export async function type(element: Element | null, value: string) {
  if (!(element instanceof w.HTMLInputElement) && !(element instanceof w.HTMLTextAreaElement)) {
    throw new Error('Expected a field to type into');
  }
  const prototype = element instanceof w.HTMLInputElement ? w.HTMLInputElement.prototype : w.HTMLTextAreaElement.prototype;
  const setValue = Reflect.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setValue) throw new Error('The field has no value setter to write through');
  await act(async () => {
    setValue.call(element, value);
    element.dispatchEvent(new w.Event('input', { bubbles: true }));
  });
}

/**
 * Press something the way a pointer does: down, up, then the click.
 *
 * Listbox options and some menu items commit on `pointerup` and treat the
 * click that follows as already handled, so calling `click()` alone leaves
 * them looking pressed and reports nothing to the caller. Anything that
 * responds to a plain click should use `click`; this is for the widgets that
 * genuinely listen to the pointer sequence.
 */
export async function pointerClick(element: Element | null) {
  if (!(element instanceof w.HTMLElement)) throw new Error('Expected a pressable element');
  for (const type of ['pointerdown', 'pointerup']) {
    await act(async () => { element.dispatchEvent(new w.PointerEvent(type, { bubbles: true })); });
  }
  await act(async () => { element.click(); });
}
