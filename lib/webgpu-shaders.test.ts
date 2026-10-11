import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BODY_BYTES,
  PARTICLE_BYTES,
  RENDER_SHADER,
  UNIFORM,
  UNIFORM_BYTES,
  simulateShader,
} from './webgpu-shaders.ts';
import { MAX_BODIES } from './swarm-frame.ts';
import { PARTICLE_BYTES as CAPABILITY_PARTICLE_BYTES } from './webgpu-capability.ts';

const SIMULATE = simulateShader(256);
const WGSL = `${SIMULATE}\n${RENDER_SHADER}`;

/**
 * The WebGL shaders, as text.
 *
 * Read from source rather than imported: `swarm-renderer.ts` reaches for a
 * canvas at module scope only inside its class, but importing it pulls in the
 * whole GL backend for what is a string comparison. This test is about two
 * pieces of shader text agreeing, and text is what it needs.
 */
const GLSL = readFileSync(
  fileURLToPath(new URL('./swarm-renderer.ts', import.meta.url)),
  'utf8',
);

/**
 * The numbers that carry an artistic rule, and what each one decides.
 *
 * Every one of these is explained by a measurement in `swarm-renderer.ts` — the
 * curl scale that stopped the swarm collapsing onto filaments, the inner radius
 * that stopped a visitor punching a dark hole in the field. The WGSL is a port,
 * so a constant tuned on one backend and not the other is a silent divergence
 * in what the piece looks like, and this is the check that makes it loud.
 */
const SHARED_RULES: Array<[string, string]> = [
  ['12.0', 'ambient curl scale'],
  ['45.0', 'memory curl scale: the one that collapsed the swarm onto filaments when it was larger'],
  ['30.0', 'silhouette gradient scale'],
  ['0.035', 'curl noise sample step'],
  ['0.012', 'silhouette sample step'],
  ['0.55', 'respawn bias toward remembered ground — gentle on purpose'],
  ['13.7', 'respawn candidate offset'],
  ['29.1', 'respawn candidate offset'],
  ['7.3', 'respawn candidate offset'],
  ['0.42', 'inner radius: push out inside it, pull in outside'],
  ['0.7', 'outward/inward ratio, so a body gathers a shell instead of a hole'],
  ['0.45', 'stillness damping of the radial push, and the lower bound of a life'],
  ['2.2', 'how much a body drags the field along with it'],
  ['0.95', 'how much a body heats the particles around it'],
  ['1.05', 'escape bound'],
  ['2.6', 'ambient noise frequency'],
  ['0.06', 'ambient noise drift rate'],
  ['11.0', 'unrest noise frequency'],
  ['0.21', 'unrest drift rate'],
  ['1.1', 'life spread'],
  ['127.1', 'hash constant'],
  ['311.7', 'hash constant'],
  ['43758.5453123', 'hash constant'],
  ['0.65', 'point size floor'],
  ['1.6', 'point size growth with speed'],
  ['9.0', 'point size ceiling'],
  ['0.7', 'alpha growth with speed'],
  ['0.08', 'paper pigment at full heat'],
  ['3.14159265', 'the life envelope'],
];

void test('every number that decides what the piece looks like is in both shaders', () => {
  const missing = SHARED_RULES
    .filter(([value]) => !WGSL.includes(value) || !GLSL.includes(value))
    .map(([value, meaning]) => `${value} (${meaning})`);
  assert.deepEqual(missing, [], `tuned on one backend only: ${missing.join('; ')}`);
});

void test('the two shaders agree about how a body is answered', () => {
  // Not a number this time but a shape: a body contributes a radial push, a
  // tangential swirl and its own velocity, and heats what it passes. Four
  // terms, in both languages, or the response a visitor feels is different.
  for (const [source, name] of [[SIMULATE, 'WGSL'], [GLSL, 'GLSL']] as const) {
    assert.match(source, /bodyPush|uBodyPush/, `${name} lost the radial push`);
    assert.match(source, /bodySwirl|uBodySwirl/, `${name} lost the swirl`);
    assert.match(source, /bodyHeat \+=/, `${name} lost the heat`);
  }
});

void test('the uniform block is laid out exactly as the shader declares it', () => {
  const struct = /struct Uniforms \{([^}]*)\}/.exec(SIMULATE);
  assert.ok(struct, 'the Uniforms struct is not where this test looks for it');
  const declared = [...struct[1].matchAll(/^\s*(\w+):\s*(f32|u32),/gm)].map((match) => match[1]);
  assert.deepEqual(declared, Object.keys(UNIFORM),
    'the TypeScript writer and the shader disagree about the field order');
  assert.deepEqual(Object.values(UNIFORM), declared.map((_, index) => index),
    'offsets must be contiguous words from zero');
  assert.equal(UNIFORM_BYTES, declared.length * 4);
  assert.equal(UNIFORM_BYTES % 16, 0, 'a uniform block is sized in whole 16-byte units');
});

void test('a particle and a body are the size both sides allocate for them', () => {
  const sizeOf = (name: string) => {
    const struct = new RegExp(`struct ${name} \\{([^}]*)\\}`).exec(SIMULATE);
    assert.ok(struct, `the ${name} struct is not where this test looks for it`);
    return [...struct[1].matchAll(/:\s*(vec2<f32>|f32|u32),/g)]
      .reduce((total, match) => total + (match[1] === 'vec2<f32>' ? 8 : 4), 0);
  };
  assert.equal(sizeOf('Particle'), PARTICLE_BYTES);
  assert.equal(sizeOf('Body'), BODY_BYTES);
  assert.equal(PARTICLE_BYTES, CAPABILITY_PARTICLE_BYTES,
    'the capability check budgets for a particle of a different size than the shader stores');
});

/**
 * The bounds check is the difference between an overhanging workgroup doing
 * nothing and it corrupting particle zero every frame, because WGSL clamps an
 * out-of-range access rather than trapping.
 */
void test('the compute shader refuses to run past the end of the population', () => {
  assert.match(SIMULATE, /if \(index >= uniforms\.particleCount\) \{ return; \}/);
  assert.match(SIMULATE, new RegExp(`i < ${MAX_BODIES}u`),
    'the body loop must be bounded by the buffer as well as by the count');
});

void test('the workgroup size the pipeline dispatches is the one the shader declares', () => {
  for (const size of [32, 64, 256, 1024]) {
    assert.match(simulateShader(size), new RegExp(`@workgroup_size\\(${size}\\)`));
  }
});

/**
 * Bindings are documented in the module header and declared in the shader, and
 * the renderer builds bind groups from the same numbers. Two of the three are
 * checkable here.
 */
void test('every binding the module documents is the binding the shader declares', () => {
  const documented: Array<[string, RegExp]> = [
    ['uniforms', /@group\(0\) @binding\(0\) var<uniform> uniforms/],
    ['particles', /@group\(0\) @binding\(1\) var<storage, read_write> particles/],
    ['bodies', /@group\(0\) @binding\(2\) var<storage, read> bodies/],
    ['memory field', /@group\(0\) @binding\(3\) var memoryField/],
    ['presence mask', /@group\(0\) @binding\(4\) var presenceField/],
    ['sampler', /@group\(0\) @binding\(5\) var fieldSampler/],
  ];
  for (const [what, pattern] of documented) {
    assert.match(SIMULATE, pattern, `${what} is not bound where the header says`);
  }
  assert.match(RENDER_SHADER, /@group\(0\) @binding\(1\) var<storage, read> particles/,
    'the vertex stage must take the particles read-only');
  assert.match(RENDER_SHADER, /@group\(1\) @binding\(0\) var gradient/);
});

/**
 * A compute invocation has no implicit derivatives, so `textureSample` is not
 * merely slower there — it will not compile, and the failure arrives as a
 * pipeline error at startup in a gallery.
 */
void test('the compute stage samples with an explicit level', () => {
  assert.ok(
    !/(?<!Level)\btextureSample\(/.test(SIMULATE),
    'the compute shader must use textureSampleLevel',
  );
  assert.match(RENDER_SHADER, /textureSample\(gradient/, 'the fragment stage may sample normally');
});
