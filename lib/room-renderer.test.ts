import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseRendererBackend, type RendererCapability } from './room-renderer.ts';

const capable: RendererCapability = {
  webgpu: { available: true, reason: '', particleCount: 360_000 },
  webgl2: true,
  abandoned: false,
};

void test('WebGL2 is the exhibition default even where WebGPU would run', () => {
  const choice = chooseRendererBackend('auto', capable);
  assert.equal(choice.backend, 'webgl');
  // The policy, not an accident of ordering: WebGPU becomes the default when it
  // has passed visual, recovery and burn-in parity on gallery hardware, which is
  // a decision with evidence behind it rather than a capability check.
  assert.match(choice.why, /parity/);
});

void test('an operator who asks for WebGPU gets it, and is told what it will run', () => {
  const choice = chooseRendererBackend('webgpu', capable);
  assert.equal(choice.backend, 'webgpu');
  assert.match(choice.why, /360k/);
});

/**
 * Silently doing something other than what was asked is how an operator spends
 * an afternoon debugging the wrong layer.
 */
void test('a backend this machine cannot provide falls back and says why', () => {
  const choice = chooseRendererBackend('webgpu', {
    ...capable,
    webgpu: { available: false, reason: 'no WebGPU adapter is available on this machine' },
  });
  assert.equal(choice.backend, 'webgl');
  assert.match(choice.why, /no WebGPU adapter/);
  assert.match(choice.why, /WebGL2 instead/);
});

void test('with neither GPU backend the room still draws', () => {
  for (const preference of ['auto', 'webgl', 'webgpu'] as const) {
    const choice = chooseRendererBackend(preference, {
      webgpu: { available: false, reason: 'this browser has no WebGPU implementation' },
      webgl2: false,
      abandoned: false,
    });
    assert.equal(choice.backend, 'traces', `${preference} should still draw something`);
    assert.ok(choice.why.length > 20, 'and should say why it is drawing lines');
  }
});

/**
 * `renderer-health.ts` gives up on the swarm after repeated context losses,
 * because rebuilding reseeds the field and several recoveries a minute read as
 * a fault rather than as the work. That verdict has to outrank every preference,
 * including an explicit one — otherwise the operator's own setting puts the room
 * back into the loop it just escaped.
 */
void test('a GPU that keeps losing its context is not asked again, whatever was selected', () => {
  for (const preference of ['auto', 'webgl', 'webgpu'] as const) {
    const choice = chooseRendererBackend(preference, { ...capable, abandoned: true });
    assert.equal(choice.backend, 'traces', `${preference} must not reopen a dead GPU`);
  }
  assert.match(
    chooseRendererBackend('webgpu', { ...capable, abandoned: true }).why,
    /lost its context repeatedly/,
  );
});

void test('every choice carries a sentence an operator can act on', () => {
  const capabilities: RendererCapability[] = [
    capable,
    { ...capable, abandoned: true },
    { ...capable, webgpu: { available: false, reason: 'no adapter' } },
    { webgpu: { available: false, reason: 'no adapter' }, webgl2: false, abandoned: false },
  ];
  for (const capability of capabilities) {
    for (const preference of ['auto', 'webgl', 'webgpu'] as const) {
      const { why } = chooseRendererBackend(preference, capability);
      assert.ok(
        why.length >= 30 && !/^unavailable$/i.test(why),
        `"${why}" is a status, not something to act on`,
      );
    }
  }
});
