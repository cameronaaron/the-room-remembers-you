import assert from 'node:assert/strict';
import test from 'node:test';
import { SwarmRenderer, MAX_BODIES, type SwarmFrame } from './swarm-renderer.ts';
import { fakeWebGl } from './test-doubles/webgl.ts';
import { paletteFor } from './palette.ts';

void test('paper keeps the particle engine and switches from light to ink without reseeding', () => {
  const gpu = fakeWebGl();
  const renderer = new SwarmRenderer(gpu.canvas, 16);
  const scene: SwarmFrame = { deltaSeconds: 1 / 60, intensity: 0.85, drift: 1, unrest: 0, presence: 1, bodies: [] };
  const allocations = gpu.calls.filter(c => c.name === 'createTexture').length;
  for (const projectionMode of ['paper', 'room', 'paper'] as const) {
    renderer.render({ ...scene, projectionMode });
    const paper = projectionMode === 'paper';
    assert.deepEqual(gpu.calls.filter(c => c.name === 'blendFunc').at(-1)?.args,
      paper ? ['ZERO', 'ONE_MINUS_SRC_COLOR'] : ['ONE', 'ONE']);
    assert.deepEqual(gpu.calls.filter(c => c.name === 'clearColor').at(-1)?.args,
      paper ? [...paletteFor('paper').ground.map(c => c / 255), 1] : [0, 0, 0, 1]);
    assert.deepEqual(gpu.calls.filter(c => c.name === 'uniform1i' && c.args[0] === 'uPaper').at(-1)?.args,
      ['uPaper', paper ? 1 : 0]);
    assert.deepEqual(gpu.calls.filter(c => c.name === 'drawArrays').at(-1)?.args, ['POINTS', 0, 16]);
  }
  assert.equal(gpu.calls.filter(c => c.name === 'createTexture').length, allocations);
  // Blackout deliberately uses the default black surface with zero intensity.
  renderer.render({ ...scene, intensity: 0, presence: 0 });
  assert.deepEqual(gpu.calls.filter(c => c.name === 'clearColor').at(-1)?.args, [0, 0, 0, 1]);
  renderer.dispose();
});

const frame: SwarmFrame = { deltaSeconds: 1, intensity: 0.7, drift: 1, unrest: 0.2, presence: 1,
 bodies: Array.from({ length: 20 }, (_, x) => ({ x: x / 20, y: 0.5, vx: 0.1, vy: -0.1, stillness: 2, strength: -1, heat: 0.5 })) };
void test('GPU probe rejects unavailable contexts and releases its temporary context', () => {
  assert.equal(SwarmRenderer.probe({ getContext: () => null } as unknown as HTMLCanvasElement), false);
  for (const extension of [true, false]) {
    const gpu = fakeWebGl({ extension });
    assert.equal(SwarmRenderer.probe(gpu.canvas), extension);
    assert.equal(gpu.calls.filter(c => c.name === 'loseContext').length, 1);
  }
  const gpu = fakeWebGl(); gpu.gl.getExtension = () => null;
  assert.equal(SwarmRenderer.probe(gpu.canvas), false);
});
void test('GPU frames ping-pong targets, bound bodies and steps, and release every resource', () => {
  const gpu = fakeWebGl(); const renderer = new SwarmRenderer(gpu.canvas, 16);
  assert.equal(renderer.particleCount, 16);
  renderer.setMemoryField(new Float32Array([-1, 0.5, 2]), 3, 1);
  assert.deepEqual(gpu.calls.at(-1)?.args.at(-1), [0,128,255]);
  renderer.setPresenceMask([0,1,2,3], 4, 1);
  assert.deepEqual(gpu.calls.at(-1)?.args.at(-1), [0,90,255,255]);
  renderer.resize(1200, 700); renderer.resize(1200,700); renderer.resize(1200,800);
  assert.equal(gpu.canvas.height, 800);
  renderer.render(frame); renderer.render({ ...frame, deltaSeconds: -1, bodies: [] });
  const uniforms = gpu.calls.filter(c => c.name === 'uniform1f');
  assert.deepEqual(uniforms.filter(c => c.args[0] === 'uDt').map(c => c.args[1]), [0.05,0]);
  assert.deepEqual(gpu.calls.filter(c => c.name === 'uniform1i' && c.args[0] === 'uBodyCount').map(c => c.args[1]), [MAX_BODIES,0]);
  assert.equal(gpu.calls.filter(c => c.name === 'drawArrays').length, 4);
  const still = gpu.calls.find(c => c.name === 'uniform1fv' && c.args[0] === 'uBodyStill');
  assert.deepEqual(still?.args[1], Array(MAX_BODIES).fill(1));
  const targets = gpu.calls.filter(c => c.name === 'bindFramebuffer' && c.args[1]).slice(-2);
  assert.notEqual(targets[0].args[1], targets[1].args[1]);
  renderer.dispose(); assert.equal(gpu.live.size, 0);
  const count = gpu.calls.length;
  renderer.dispose(); renderer.render(frame); renderer.resize(1,1); renderer.setMemoryField(new Float32Array(),0,0); renderer.setPresenceMask([],0,0);
  assert.equal(gpu.calls.length, count, 'disposed renderer must never touch GPU resources');
});
void test('GPU initialization reports unavailable capabilities and each allocation failure', () => {
  assert.throws(() => new SwarmRenderer({ getContext: () => null } as unknown as HTMLCanvasElement, 4), /WebGL2/);
  const cases = [
    [{ extension: false }, /EXT_color_buffer_float/],
    [{ fail: 'createProgram' }, /create program/], [{ fail: 'createShader' }, /create shader/],
    [{ compile: false, log: 'bad shader' }, /bad shader/], [{ compile: false }, /unknown/],
    [{ link: false, log: 'bad link' }, /bad link/], [{ link: false }, /unknown/],
    [{ fail: 'createBuffer' }, /geometry/], [{ fail: 'createVertexArray' }, /geometry/], [{ fail: 'createVertexArray', nth: 2 }, /geometry/],
    [{ fail: 'createTexture' }, /state/], [{ fail: 'createTexture', nth: 5 }, /gradient/], [{ fail: 'createTexture', nth: 6 }, /field/],
    [{ fail: 'createFramebuffer' }, /target/], [{ complete: false }, /incomplete/],
  ] as const;
  for (const [options, message] of cases) assert.throws(() => new SwarmRenderer(fakeWebGl(options).canvas, 4), message);
});
