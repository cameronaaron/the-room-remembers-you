import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { GalleryPreflight } from '../components/gallery-preflight.tsx';
import { DEFAULT_CONFIG, type RuntimeStatus } from './room-types.ts';
import { commissioningKey } from './commissioning.ts';

void test('operator can commission, lose readiness, restart and change configuration', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 100000 });
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const intervalStarts = context.mock.method(globalThis, 'setInterval');
  const intervalStops = context.mock.method(globalThis, 'clearInterval');
  const root = createRoot(dom.window.document.getElementById('root')!);
  let relearns = 0, calibrations = 0, auditions = 0;
  let config = { ...DEFAULT_CONFIG };
  const status = { lastRenderAt: Date.now(), lastAnalysisAt: Date.now(), camera: 'ready', microphone: 'ready', motion: { state: 'tracking', cellsPerBody: 7 }, audio: { contextState: 'running' }, fps: 60, analysisHz: 24 } as RuntimeStatus;
  const render = async () => act(() => root.render(createElement(GalleryPreflight, { key: commissioningKey(config), config, status, onRelearn: () => relearns++, onCalibrate: () => calibrations++, onAudition: () => auditions++ })));
  const inputs = () => [...dom.window.document.querySelectorAll('input')];
  const text = () => dom.window.document.body.textContent!;
  const click = async (element: HTMLElement) => act(() => element.click());
  const button = (name: string) => [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === name)!;
  try {
    await render();
    assert.equal(inputs().length, 1);
    assert.equal(intervalStarts.mock.callCount(), 0);
    await click(inputs()[0]);
    assert.equal(inputs().length, 5);
    assert.equal(dom.window.document.querySelectorAll('.preflight-checks li').length, 6);
    assert.match(text(), /Pass: Use live sensing/);
    assert.match(text(), /Commissioning in progress/);
    for (const checkbox of inputs().slice(1)) await click(checkbox);
    assert.match(text(), /Preflight complete/);
    await act(async () => { context.mock.timers.tick(20000); });
    assert.match(text(), /Commissioning in progress/);
    status.lastRenderAt = Date.now(); status.lastAnalysisAt = Date.now(); await render();
    assert.match(text(), /Preflight complete/);
    await click(inputs()[1]);
    assert.match(text(), /Commissioning in progress/);
    await click(inputs()[1]);
    status.camera = 'failed'; await render();
    assert.match(text(), /Pending: Connect the camera/);
    assert.doesNotMatch(text(), /Preflight complete/);
    status.camera = 'ready'; await render();
    assert.match(text(), /Preflight complete/);
    await click(button('Audition captured whispers')); assert.equal(auditions, 1);
    await click(button('Relearn empty room')); assert.equal(relearns, 1);
    assert.ok(inputs().slice(1).every(input => !input.checked));
    await click(inputs()[1]);
    await click(button('Calibrate projection')); assert.equal(calibrations, 1);
    assert.ok(inputs().slice(1).every(input => !input.checked));
    await click(inputs()[1]); await click(button('Restart commissioning'));
    assert.ok(inputs().slice(1).every(input => !input.checked));
    for (const checkbox of inputs().slice(1)) await click(checkbox);
    config = { ...config, crop: 0.1 }; await render();
    assert.equal(inputs().length, 1);
    config = { ...DEFAULT_CONFIG }; await render();
    await click(inputs()[0]);
    assert.ok(inputs().slice(1).every(input => !input.checked), 'returning to old settings must not restore evidence');
    await click(inputs()[1]); await click(inputs()[0]); await click(inputs()[0]);
    assert.ok(inputs().slice(1).every(input => !input.checked));
    status.lastRenderAt = undefined; status.lastAnalysisAt = undefined; await render();
    assert.match(text(), /Pending: Connect the camera/);
  } finally {
    await act(async () => { root.unmount(); });
    assert.equal(intervalStops.mock.callCount(), intervalStarts.mock.callCount(), 'every active preflight timer must be retired');
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
