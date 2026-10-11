import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { RoomInstallation } from '../components/room-installation.tsx';
import { overrideGlobals, FakeIndexedDb } from './test-doubles/browser.ts';
import { fakeWebGl } from './test-doubles/webgl.ts';
import { saveConfig } from './persistence.ts';
import { DEFAULT_CONFIG } from './room-types.ts';

for (const surface of ['room', 'paper'] as const) {
  for (const available of [true, false]) {
    void test(`${surface}: startup, blackout and context recovery keep scheduling visible rendering (GPU ${available})`, async t => {
      const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
      const w = dom.window;
      const frames = new Map<number, FrameRequestCallback>();
      let sequence = 0;
      const gpu = fakeWebGl();
      const paints: Array<{ canvas: HTMLCanvasElement; method: string }> = [];
      const restore = overrideGlobals({ window: w, document: w.document, navigator: w.navigator,
        HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, localStorage: w.localStorage,
        indexedDB: new FakeIndexedDb(), IS_REACT_ACT_ENVIRONMENT: true,
        requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++sequence, fn); return sequence; },
        cancelAnimationFrame: (id: number) => frames.delete(id),
        fetch: async () => ({ ok: false }),
      });
      const context2D = (canvas: HTMLCanvasElement) => new Proxy({ canvas }, {
        get(target, key) {
          if (key in target) return Reflect.get(target, key);
          if (key === 'createImageData') return (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) });
          return () => { paints.push({ canvas, method: String(key) }); };
        },
        set(target, key, value) { Reflect.set(target, key, value); return true; },
      });
      t.mock.method(w.HTMLCanvasElement.prototype, 'getContext', function(this: HTMLCanvasElement, kind: string) {
        if (kind === 'webgl2') {
          if (!available) return null;
          Object.assign(gpu.gl, { canvas: this });
          return gpu.gl;
        }
        return context2D(this);
      } as never);
      saveConfig({ ...DEFAULT_CONFIG, hardwareProfile: 'CHEAP', projectionMode: surface, visualEngine: 'swarm' });
      const root = createRoot(w.document.getElementById('root')!);
      const advance = async (now: number) => act(async () => {
        const pending = [...frames.values()]; frames.clear();
        for (const callback of pending) callback(now);
      });
      const key = async (value: string) => act(async () => { w.dispatchEvent(new w.KeyboardEvent('keydown', { key: value })); });
      try {
        await act(async () => root.render(createElement(RoomInstallation)));
        await advance(1000);
        const overlay = w.document.querySelector('.projection-traces');
        assert.ok(frames.size > 0, 'startup must schedule another frame without camera permission');
        if (available) {
          assert.deepEqual(gpu.calls.filter(c => c.name === 'drawArrays').at(-1)?.args, ['POINTS', 0, 65536]);
          assert.ok(paints.some(c => c.canvas === overlay && c.method === 'clearRect'), 'overlay must expose the GPU surface');
          assert.equal(gpu.calls.filter(c => c.name === 'uniform1i' && c.args[0] === 'uPaper').at(-1)?.args[1], surface === 'paper' ? 1 : 0);
        } else {
          assert.ok(paints.some(c => c.canvas === overlay && c.method === 'fillRect'), 'no GPU must draw the trace surface');
        }
        await key('b'); await advance(1100);
        if (available) assert.deepEqual(gpu.calls.filter(c => c.name === 'clearColor').at(-1)?.args, [0, 0, 0, 1]);
        await key('b'); await advance(1200);
        assert.ok(frames.size > 0, 'leaving blackout must resume the loop');
        if (available) {
          // The element under `.projection-swarm`, not the wrapper itself: the
          // particle field's canvas is created and replaced by `GpuSurface`
          // rather than by the render tree, because a canvas is consumed by the
          // first graphics API it is asked for and a rebuild has to be able to
          // come back on a different backend. `webglcontextlost` does not
          // bubble, so this has to be the canvas that holds the context.
          const canvas = w.document.querySelector('.projection-swarm canvas')!;
          const loss = new w.Event('webglcontextlost', { cancelable: true });
          await act(async () => { canvas.dispatchEvent(loss); });
          assert.ok(loss.defaultPrevented, 'context restoration must be requested');
          const draws = gpu.calls.filter(c => c.name === 'drawArrays').length;
          paints.length = 0; await advance(1300);
          assert.equal(gpu.calls.filter(c => c.name === 'drawArrays').length, draws);
          assert.ok(paints.some(c => c.canvas === overlay && c.method === 'fillRect'), 'context loss must expose fallback');
          await act(async () => { canvas.dispatchEvent(new w.Event('webglcontextrestored')); });
          await advance(1400);
          assert.ok(gpu.calls.filter(c => c.name === 'drawArrays').length > draws, 'restored context must actually draw again');
          assert.equal(gpu.calls.filter(c => c.name === 'uniform1i' && c.args[0] === 'uPaper').at(-1)?.args[1], surface === 'paper' ? 1 : 0);
        }
      } finally {
        await act(async () => root.unmount());
        assert.equal(frames.size, 0, 'unmount must retire the draw loop');
        dom.window.close(); restore();
      }
    });
  }
}
