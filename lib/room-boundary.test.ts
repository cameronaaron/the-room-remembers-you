import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, act, dom } from './test-doubles/dom.ts';
import { createElement as h } from 'react';
import { RoomBoundary } from '../components/room-boundary.tsx';
import { MAX_REMOUNTS, REMOUNT_DELAY_MS } from './crash-recovery.ts';

void test('render boundary recovers transient faults, limits repeated crashes and cancels timers', async t => {
  const callbacks = new Map<number, () => void>(); let id = 0;
  t.mock.method(dom.window, 'setTimeout', (callback: () => void, delay: number) => {
    assert.equal(delay, REMOUNT_DELAY_MS); callbacks.set(++id, callback); return id;
  });
  t.mock.method(dom.window, 'clearTimeout', (timer: number) => callbacks.delete(timer));
  const logs = t.mock.method(console, 'error', () => {});
  let fail = false;
  function Scene() { if (fail) throw new Error('synthetic render failure'); return h('p', null, 'Live room'); }
  const view = await mount(h(RoomBoundary, null, h(Scene)));
  const tick = async () => act(async () => { const pending = [...callbacks.values()]; callbacks.clear(); for (const callback of pending) callback(); });
  try {
    assert.equal(view.container.textContent, 'Live room');
    fail = true; await view.render(h(RoomBoundary, null, h(Scene)));
    assert.match(view.container.textContent!, /remembering how to see/);
    assert.equal(callbacks.size, 1);
    fail = false; await tick();
    assert.equal(view.container.textContent, 'Live room');
    fail = true; await view.render(h(RoomBoundary, null, h(Scene)));
    for (let attempt = 1; attempt < MAX_REMOUNTS; attempt++) await tick();
    assert.equal(callbacks.size, 0, 'repeated failures must stop remounting');
    assert.match(view.container.textContent!, /remembering how to see/);
    assert.ok(logs.mock.calls.some(call => String(call.arguments[0]).includes('remounting has stopped')));
  } finally { await view.close(); }
  assert.equal(callbacks.size, 0);
});
