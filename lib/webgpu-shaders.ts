import { MAX_BODIES } from './swarm-frame.ts';

/**
 * The room's WGSL.
 *
 * Kept in its own module so it is text a test can read, search and assert
 * about without a GPU. `ENGINEERING-STANDARDS.md` requires that the artistic
 * rules not be hidden inside opaque shader code, and a shader that only a
 * browser can look at is exactly that.
 *
 * ## Buffer layouts
 *
 * Every binding below is declared once here and once in `webgpu-renderer.ts`,
 * with `webgpu-shaders.test.ts` checking that the two agree about sizes. The
 * numbers are bytes.
 *
 * | group.binding | what | kind | size |
 * | --- | --- | --- | --- |
 * | 0.0 | uniforms | uniform | `UNIFORM_BYTES` |
 * | 0.1 | particles | storage | 32 per particle |
 * | 0.2 | bodies | storage, read | 32 per body, `MAX_BODIES` of them |
 * | 0.3 | memory field | texture, r8unorm | 64 x 36 |
 * | 0.4 | presence mask | texture, r8unorm | 40 x 23 |
 * | 0.5 | sampler | linear, clamped | |
 * | 1.0 | gradient | texture, rgba8unorm | 256 x 1 |
 *
 * ## Why there is no ping-pong
 *
 * The WebGL backend ping-pongs two pairs of float textures because a fragment
 * shader cannot write to the texture it is sampling. A compute invocation here
 * owns exactly one particle and reads no other, so it can read and write the
 * same storage buffer with no hazard at all. Ping-ponging would double the
 * memory and copy the whole population every frame to protect against a
 * dependency that does not exist. This is the one place the WebGPU port is
 * genuinely simpler rather than differently shaped.
 *
 * ## Determinism
 *
 * The compute shader has no randomness of its own: `hash` is a pure function of
 * a particle's seed and age, and the seeds are written once at initialisation
 * from the caller's generator. Two machines given the same seeds and the same
 * `dt` sequence produce the same field to within their GPUs' floating point.
 * The room's *behaviour* is not decided here in any case — the engine chooses
 * what is recalled and who is interesting; this only decides how that looks.
 *
 * ## What "parity with WebGL" means and does not
 *
 * Particle *identity* is not preserved across backends and cannot be: the two
 * run different population sizes and address their respawn hash differently —
 * WebGL by texel coordinate in a square texture, this by linear index. The
 * claim the gates make is about the field: the same forces, the same gradient,
 * the same response to a body, the same fraction of the wall alive and moving.
 * A per-particle diff between the two backends would be comparing two draws
 * from one distribution and calling the difference a defect.
 */

/** Bytes in the uniform block. Must stay a multiple of 16. */
export const UNIFORM_BYTES = 80;

/** Bytes per body in the storage buffer. */
export const BODY_BYTES = 32;

/** Bytes per particle. Mirrors `PARTICLE_BYTES` in `webgpu-capability.ts`. */
export const PARTICLE_BYTES = 32;

/**
 * Field offsets in the uniform block, in 4-byte words.
 *
 * Written out rather than computed, because the shader's struct order is the
 * contract and a silently shifted offset renders a plausible wrong field.
 */
export const UNIFORM = Object.freeze({
  dt: 0,
  time: 1,
  memoryFlow: 2,
  ambientCurl: 3,
  damping: 4,
  life: 5,
  bodyRadius: 6,
  bodyPush: 7,
  bodySwirl: 8,
  drift: 9,
  unrest: 10,
  silhouettePull: 11,
  pointScale: 12,
  presenceBoost: 13,
  intensity: 14,
  resolutionX: 15,
  resolutionY: 16,
  bodyCount: 17,
  particleCount: 18,
  paper: 19,
});

/**
 * Declarations both pipelines share.
 *
 * One copy, so the compute stage and the vertex stage cannot come to disagree
 * about what a particle is — which is a class of bug that renders rather than
 * failing to compile.
 */
const COMMON = /* wgsl */ `
struct Particle {
  position: vec2<f32>,
  velocity: vec2<f32>,
  age: f32,
  life: f32,
  seed: f32,
  depth: f32,
}

struct Body {
  position: vec2<f32>,
  velocity: vec2<f32>,
  stillness: f32,
  /** 0..1 presence envelope. A living body is 1; a recall swells and subsides. */
  strength: f32,
  /** Colour temperature. 1 is alive. A composite memory never warms. */
  heat: f32,
  pad: f32,
}

struct Uniforms {
  dt: f32,
  time: f32,
  memoryFlow: f32,
  ambientCurl: f32,
  damping: f32,
  life: f32,
  bodyRadius: f32,
  bodyPush: f32,
  bodySwirl: f32,
  drift: f32,
  unrest: f32,
  silhouettePull: f32,
  pointScale: f32,
  presenceBoost: f32,
  intensity: f32,
  resolutionX: f32,
  resolutionY: f32,
  bodyCount: u32,
  particleCount: u32,
  paper: u32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
`;

/**
 * The simulation.
 *
 * A line-for-line port of `SIMULATE_FRAGMENT` in `swarm-renderer.ts`, including
 * every scale factor whose value is explained there by a measurement. The
 * comments that record *why* a number is what it is live in that file; the ones
 * here record only where the two languages differ.
 */
export function simulateShader(workgroupSize: number): string {
  return /* wgsl */ `${COMMON}
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read> bodies: array<Body>;
@group(0) @binding(3) var memoryField: texture_2d<f32>;
@group(0) @binding(4) var presenceField: texture_2d<f32>;
@group(0) @binding(5) var fieldSampler: sampler;

fn hash(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453123);
}

fn valueNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2<f32>(1.0, 0.0)), u.x),
    mix(hash(i + vec2<f32>(0.0, 1.0)), hash(i + vec2<f32>(1.0, 1.0)), u.x),
    u.y);
}

// Curl of a scalar noise field: divergence-free, so the swarm stirs without
// piling up in sinks. Scaled rather than divided by the sample step, for the
// reason recorded in swarm-renderer.ts.
fn curlNoise(p: vec2<f32>) -> vec2<f32> {
  let e = 0.035;
  let n1 = valueNoise(p + vec2<f32>(0.0, e));
  let n2 = valueNoise(p - vec2<f32>(0.0, e));
  let n3 = valueNoise(p + vec2<f32>(e, 0.0));
  let n4 = valueNoise(p - vec2<f32>(e, 0.0));
  return vec2<f32>(n1 - n2, n4 - n3) * 12.0;
}

// textureSampleLevel, not textureSample: a compute invocation has no implicit
// derivatives, so the level has to be named. Level zero, the only one these
// textures have.
fn memoryAt(p: vec2<f32>) -> f32 {
  return textureSampleLevel(memoryField, fieldSampler, clamp(p, vec2<f32>(0.001), vec2<f32>(0.999)), 0.0).r;
}

fn presenceAt(p: vec2<f32>) -> f32 {
  return textureSampleLevel(presenceField, fieldSampler, clamp(p, vec2<f32>(0.001), vec2<f32>(0.999)), 0.0).r;
}

// Pull toward occupied motion cells. Inside a visitor's outline the mask is
// flat, so the gradient is zero and nothing drags particles further in; they
// arrive from outside and settle on the boundary, which is what makes a visitor
// see their own shape. Reads the coarse occupancy grid, never camera pixels.
fn silhouettePull(p: vec2<f32>) -> vec2<f32> {
  let e = 0.012;
  let dx = presenceAt(p + vec2<f32>(e, 0.0)) - presenceAt(p - vec2<f32>(e, 0.0));
  let dy = presenceAt(p + vec2<f32>(0.0, e)) - presenceAt(p - vec2<f32>(0.0, e));
  return vec2<f32>(dx, dy) * 30.0;
}

// Particles run along memory ridges rather than into them, so the room's
// accumulation reads as current instead of as a heap.
fn memoryCurl(p: vec2<f32>) -> vec2<f32> {
  let e = 0.01;
  let dx = memoryAt(p + vec2<f32>(e, 0.0)) - memoryAt(p - vec2<f32>(e, 0.0));
  let dy = memoryAt(p + vec2<f32>(0.0, e)) - memoryAt(p - vec2<f32>(0.0, e));
  return vec2<f32>(-dy, dx) * 45.0;
}

// Mildly weighted toward remembered ground. The bias stays gentle: a strong one
// empties the rest of the wall, which is the opposite of the point.
fn respawn(seed: vec2<f32>) -> vec2<f32> {
  var best = vec2<f32>(hash(seed), hash(seed.yx + 7.3));
  var bestWeight = memoryAt(best) + 0.55;
  for (var i = 1; i < 3; i = i + 1) {
    let candidate = vec2<f32>(hash(seed + f32(i) * 13.7), hash(seed.yx + f32(i) * 29.1));
    let weight = memoryAt(candidate) + 0.55;
    if (weight > bestWeight) { best = candidate; bestWeight = weight; }
  }
  return best;
}

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  // The dispatch is a whole number of workgroups, so the last one can overhang
  // the population. Bounds are checked rather than assumed; WGSL would clamp
  // the access silently and corrupt particle zero every frame.
  if (index >= uniforms.particleCount) { return; }
  var particle = particles[index];

  var p = particle.position;
  var v = particle.velocity;
  var age = particle.age + uniforms.dt;
  var life = particle.life;
  let seed = particle.seed;

  var force = memoryCurl(p) * uniforms.memoryFlow;
  force += curlNoise(p * 2.6 + uniforms.time * 0.06) * uniforms.ambientCurl * uniforms.drift;
  force += curlNoise(p * 11.0 - uniforms.time * 0.21) * uniforms.unrest * 0.5;
  force += silhouettePull(p) * uniforms.silhouettePull;

  // Living bodies. The loop that has to make a visitor certain, within a
  // second, that the room is answering them.
  var bodyHeat = 0.0;
  for (var i = 0u; i < uniforms.bodyCount && i < ${MAX_BODIES}u; i = i + 1u) {
    let body = bodies[i];
    let toParticle = p - body.position;
    let distance = length(toParticle) + 1e-4;
    if (distance > uniforms.bodyRadius) { continue; }
    let direction = toParticle / distance;
    let u = distance / uniforms.bodyRadius;
    let falloff = 1.0 - u;
    let shaped = falloff * falloff;

    // Push out of the core but pull in from the outer band, so a body gathers a
    // bright shell around itself instead of punching a hole in the field.
    var radial = -0.7;
    if (u < 0.42) { radial = 1.0; }
    force += direction * uniforms.bodyPush * shaped * radial * mix(1.0, 0.45, body.stillness) * body.strength;
    force += vec2<f32>(-direction.y, direction.x) * uniforms.bodySwirl * shaped * (1.0 + body.stillness) * body.strength;
    force += body.velocity * shaped * 2.2 * body.strength;
    bodyHeat += shaped * 0.95 * body.strength * body.heat;
  }

  v += force * uniforms.dt;
  v *= pow(uniforms.damping, uniforms.dt);
  p += v * uniforms.dt;

  let escaped = p.x < -0.05 || p.x > 1.05 || p.y < -0.05 || p.y > 1.05;
  if (age > life || escaped) {
    // WebGL derives this offset from the particle's texel coordinate; there is
    // no texture here, so it comes from the linear index. Different particles
    // land in different places than they would on the other backend, and the
    // distribution is the same, which is the parity the gates check.
    p = respawn(vec2<f32>(seed, age + f32(index % 4096u) * 0.017 + f32(index / 4096u) * 0.031));
    v = vec2<f32>(0.0);
    age = 0.0;
    life = uniforms.life * (0.45 + hash(vec2<f32>(seed, uniforms.time)) * 1.1);
  }

  // How alive this spot is, which is what colours the particle. Body proximity
  // is added directly rather than left to the presence texture: the sensor mask
  // is coarse and lags, and a visitor must run hot the instant they are
  // tracked, not a frame or two later.
  let depth = clamp(
    memoryAt(p) * 2.0
      + textureSampleLevel(presenceField, fieldSampler, clamp(p, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).r * 0.5
      + bodyHeat,
    0.0, 1.0);

  particle.position = p;
  particle.velocity = v;
  particle.age = age;
  particle.life = life;
  particle.depth = mix(particle.depth, depth, min(1.0, uniforms.dt * 6.0));
  particles[index] = particle;
}
`;
}

/**
 * Drawing the population.
 *
 * WebGPU has no point sprites, so where WebGL set `gl_PointSize` and read
 * `gl_PointCoord`, this expands each particle into two triangles whose size in
 * *pixels* is computed from the same expression, and interpolates the same
 * -0.5..0.5 local coordinate across it. Six vertices per instance, one instance
 * per particle, and the particle buffer is read straight from the vertex stage
 * rather than being copied into a vertex buffer.
 */
export const RENDER_SHADER = /* wgsl */ `${COMMON}
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(1) @binding(0) var gradient: texture_2d<f32>;
@group(1) @binding(1) var gradientSampler: sampler;

struct Fragment {
  @builtin(position) clip: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) depth: f32,
  @location(2) alpha: f32,
}

@vertex
fn vertexMain(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> Fragment {
  // The two triangles of the sprite, as corner offsets in -0.5..0.5. Declared
  // as a function-local var rather than a module-scope const, because indexing
  // a const array with a runtime value is not something every implementation
  // accepts.
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5), vec2<f32>(-0.5, 0.5),
    vec2<f32>(-0.5, 0.5), vec2<f32>(0.5, -0.5), vec2<f32>(0.5, 0.5),
  );
  var out: Fragment;
  let particle = particles[instance];
  let corner = corners[vertex];

  // Room space is y-down, as the projector sees the wall; clip space is y-up.
  let clip = particle.position * 2.0 - 1.0;
  let speed = length(particle.velocity);
  let size = clamp(uniforms.pointScale * (0.65 + speed * 1.6), 1.0, 9.0);
  let offset = vec2<f32>(
    corner.x * size * 2.0 / uniforms.resolutionX,
    corner.y * size * 2.0 / uniforms.resolutionY,
  );
  out.clip = vec4<f32>(clip.x + offset.x, -clip.y + offset.y, 0.0, 1.0);
  out.local = corner;

  // Fade in and out across the particle's life so respawns never pop.
  let phase = clamp(particle.age / max(0.0001, particle.life), 0.0, 1.0);
  let envelope = sin(phase * 3.14159265);
  out.depth = clamp(particle.depth, 0.0, 1.0);
  out.alpha = envelope * (0.5 + min(speed * 0.7, 1.0)) * uniforms.presenceBoost;
  return out;
}

@fragment
fn fragmentMain(input: Fragment) -> @location(0) vec4<f32> {
  let radial = 1.0 - smoothstep(0.0, 0.5, length(input.local));
  if (radial <= 0.0) { discard; }
  let colour = textureSample(gradient, gradientSampler, vec2<f32>(input.depth, 0.5)).rgb;
  // On paper, accumulate absorption instead of emitted light, so a hot body
  // makes a strong mark rather than disappearing into the white ground.
  var contribution = colour;
  if (uniforms.paper == 1u) {
    let pigment = mix(colour * 0.45, colour * 0.08, input.depth);
    contribution = vec3<f32>(1.0) - pigment;
  }
  return vec4<f32>(contribution * input.alpha * radial * uniforms.intensity, 1.0);
}
`;
