/**
 * WebGL2 particle field.
 *
 * Written against the raw API on purpose: the runtime boundary in
 * ENGINEERING-STANDARDS.md keeps the shipped exhibit dependency-free, so no
 * WebGL helper library is pulled in.
 *
 * Particle state lives in two float textures that are ping-ponged through a
 * fragment shader each frame:
 *
 *   state = (x, y, vx, vy)      position and velocity in room coordinates
 *   meta  = (age, life, seed, depth)
 *
 * Nothing here ever receives camera pixels. Its only sensor inputs are the
 * ephemeral 40x23 motion-cell mask and the anonymous track positions the world
 * model already produces, and neither is written anywhere.
 */

import {
  buildSwarmGradientLut,
  SWARM_DYNAMICS,
  SWARM_LUT_WIDTH,
  type SwarmDynamics,
  swarmTextureSide,
} from './swarm.ts';
import { paletteFor } from './palette.ts';

import { MAX_BODIES, type SwarmFrame } from './swarm-frame.ts';
import type { RoomRenderer } from './room-renderer.ts';
export { MAX_BODIES, type SwarmBody, type SwarmFrame } from './swarm-frame.ts';

const QUAD_VERTEX = `#version 300 es
in vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }`;

const SIMULATE_FRAGMENT = `#version 300 es
precision highp float;

uniform sampler2D uState;
uniform sampler2D uMeta;
uniform sampler2D uMemory;    // 64x36 accumulated memory field, R in .r
uniform sampler2D uPresence;  // 40x23 ephemeral motion cells, R in .r

uniform float uDt;
uniform float uTime;
uniform vec2 uSide;
uniform float uMemoryFlow;
uniform float uAmbientCurl;
uniform float uDamping;
uniform float uLife;
uniform float uBodyRadius;
uniform float uBodyPush;
uniform float uBodySwirl;
uniform float uDrift;
uniform float uUnrest;
uniform float uSilhouettePull;
uniform int uBodyCount;
uniform vec4 uBodies[${MAX_BODIES}];      // xy position, zw velocity
uniform float uBodyStill[${MAX_BODIES}];
uniform float uBodyStrength[${MAX_BODIES}];
uniform float uBodyHeat[${MAX_BODIES}];

layout(location = 0) out vec4 outState;
layout(location = 1) out vec4 outMeta;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

// Curl of a scalar noise field: divergence-free, so the swarm stirs without
// piling up in sinks.
vec2 curlNoise(vec2 p) {
  float e = 0.035;
  float n1 = valueNoise(p + vec2(0.0, e));
  float n2 = valueNoise(p - vec2(0.0, e));
  float n3 = valueNoise(p + vec2(e, 0.0));
  float n4 = valueNoise(p - vec2(e, 0.0));
  // Scaled rather than divided by the sample step. Dividing by 2e turns a
  // 0.1-ish difference into a force of 3 and lets ambient noise overpower the
  // bodies it is supposed to sit underneath.
  return vec2(n1 - n2, n4 - n3) * 12.0;
}

float memoryAt(vec2 p) {
  return texture(uMemory, clamp(p, 0.001, 0.999)).r;
}

float presenceAt(vec2 p) {
  return texture(uPresence, clamp(p, 0.001, 0.999)).r;
}

/**
 * Pull toward occupied motion cells. Inside a visitor's outline the mask is
 * flat, so the gradient is zero and nothing drags particles further in; they
 * arrive from outside and settle on the boundary. The result is a luminous
 * edge in the shape of whoever is standing there.
 *
 * This reads the coarse 40x23 motion grid, never camera pixels, so a visitor
 * sees their own outline without the installation ever handling their image.
 */
vec2 silhouettePull(vec2 p) {
  float e = 0.012;
  float dx = presenceAt(p + vec2(e, 0.0)) - presenceAt(p - vec2(e, 0.0));
  float dy = presenceAt(p + vec2(0.0, e)) - presenceAt(p - vec2(0.0, e));
  return vec2(dx, dy) * 30.0;
}

// Particles run along memory ridges rather than into them, so the room's
// accumulation reads as current instead of as a heap.
vec2 memoryCurl(vec2 p) {
  float e = 0.01;
  float dx = memoryAt(p + vec2(e, 0.0)) - memoryAt(p - vec2(e, 0.0));
  float dy = memoryAt(p + vec2(0.0, e)) - memoryAt(p - vec2(0.0, e));
  // Same reasoning as curlNoise, and it matters more here: dividing by 2e made
  // the memory term reach a force of ~40 against a body push of 7.5, so the
  // swarm collapsed onto a few filaments and the room stopped answering anyone.
  return vec2(-dy, dx) * 45.0;
}

vec2 respawn(vec2 seed) {
  // Mildly weighted toward remembered ground. The bias has to stay gentle: a
  // strong one empties the rest of the wall, and an empty wall is the opposite
  // of what this renderer exists to do.
  vec2 best = vec2(hash(seed), hash(seed.yx + 7.3));
  float bestWeight = memoryAt(best) + 0.55;
  for (int i = 1; i < 3; i++) {
    vec2 candidate = vec2(hash(seed + float(i) * 13.7), hash(seed.yx + float(i) * 29.1));
    float weight = memoryAt(candidate) + 0.55;
    if (weight > bestWeight) { best = candidate; bestWeight = weight; }
  }
  return best;
}

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  vec4 state = texelFetch(uState, texel, 0);
  vec4 meta = texelFetch(uMeta, texel, 0);

  vec2 p = state.xy;
  vec2 v = state.zw;
  float age = meta.x + uDt;
  float life = meta.y;
  float seed = meta.z;

  vec2 force = memoryCurl(p) * uMemoryFlow;
  force += curlNoise(p * 2.6 + uTime * 0.06) * uAmbientCurl * uDrift;
  force += curlNoise(p * 11.0 - uTime * 0.21) * uUnrest * 0.5;
  force += silhouettePull(p) * uSilhouettePull;

  // Living bodies. This is the loop that has to make a visitor certain, within
  // a second, that the room is answering them.
  float bodyHeat = 0.0;
  for (int i = 0; i < ${MAX_BODIES}; i++) {
    if (i >= uBodyCount) break;
    vec2 toParticle = p - uBodies[i].xy;
    float distance = length(toParticle) + 1e-4;
    if (distance > uBodyRadius) continue;
    vec2 direction = toParticle / distance;
    float u = distance / uBodyRadius;
    float falloff = 1.0 - u;
    float shaped = falloff * falloff;
    float still = uBodyStill[i];
    float strength = uBodyStrength[i];

    // Push out of the core but pull in from the outer band, so a body gathers a
    // bright shell around itself instead of punching a hole in the field. Pure
    // repulsion measured as a 62% drop in local brightness: the room answered,
    // but it answered by going dark where the visitor was standing.
    float radial = u < 0.42 ? 1.0 : -0.7;
    force += direction * uBodyPush * shaped * radial * mix(1.0, 0.45, still) * strength;
    force += vec2(-direction.y, direction.x) * uBodySwirl * shaped * (1.0 + still) * strength;
    force += uBodies[i].zw * shaped * 2.2 * strength;
    bodyHeat += shaped * 0.95 * strength * uBodyHeat[i];
  }

  v += force * uDt;
  v *= pow(uDamping, uDt);
  p += v * uDt;

  bool escaped = p.x < -0.05 || p.x > 1.05 || p.y < -0.05 || p.y > 1.05;
  if (age > life || escaped) {
    p = respawn(vec2(seed, age + float(texel.x) * 0.017 + float(texel.y) * 0.031));
    v = vec2(0.0);
    age = 0.0;
    life = uLife * (0.45 + hash(vec2(seed, uTime)) * 1.1);
  }

  // How alive this spot is, which is what colours the particle. Body proximity
  // is added directly rather than being left to the presence texture: the
  // sensor mask is coarse and lags, and a visitor must run hot the instant they
  // are tracked, not a frame or two later.
  float depth = clamp(
    memoryAt(p) * 2.0
      + texture(uPresence, clamp(p, 0.0, 1.0)).r * 0.5
      + bodyHeat,
    0.0, 1.0);

  outState = vec4(p, v);
  outMeta = vec4(age, life, seed, mix(meta.w, depth, min(1.0, uDt * 6.0)));
}`;

const RENDER_VERTEX = `#version 300 es
precision highp float;

uniform sampler2D uState;
uniform sampler2D uMeta;
uniform vec2 uSide;
uniform vec2 uResolution;
uniform float uPointScale;
uniform float uPresenceBoost;

out float vDepth;
out float vAlpha;

void main() {
  int index = gl_VertexID;
  int side = int(uSide.x);
  ivec2 texel = ivec2(index % side, index / side);
  vec4 state = texelFetch(uState, texel, 0);
  vec4 meta = texelFetch(uMeta, texel, 0);

  vec2 clip = state.xy * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);

  float speed = length(state.zw);
  // Fade in and out across the particle's life so respawns never pop.
  float phase = clamp(meta.x / max(0.0001, meta.y), 0.0, 1.0);
  float envelope = sin(phase * 3.14159265);

  vDepth = clamp(meta.w, 0.0, 1.0);
  vAlpha = envelope * (0.5 + min(speed * 0.7, 1.0)) * uPresenceBoost;
  gl_PointSize = clamp(uPointScale * (0.65 + speed * 1.6), 1.0, 9.0);
}`;

const RENDER_FRAGMENT = `#version 300 es
precision highp float;

uniform sampler2D uGradient;
uniform float uIntensity;
uniform bool uPaper;

in float vDepth;
in float vAlpha;
out vec4 fragColour;

void main() {
  vec2 offset = gl_PointCoord - 0.5;
  float radial = 1.0 - smoothstep(0.0, 0.5, length(offset));
  if (radial <= 0.0) discard;
  vec3 colour = texture(uGradient, vec2(vDepth, 0.5)).rgb;
  // On paper, accumulate absorption instead of emitted light. A hot body
  // still makes a strong mark rather than disappearing into the white ground.
  vec3 pigment = uPaper ? mix(colour * 0.45, colour * 0.08, vDepth) : colour;
  vec3 contribution = uPaper ? vec3(1.0) - pigment : pigment;
  fragColour = vec4(contribution * vAlpha * radial * uIntensity, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown';
    gl.deleteShader(shader);
    throw new Error(`Shader failed to compile: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Unable to create program');
  const vertexShader = compile(gl, gl.VERTEX_SHADER, vertex);
  const fragmentShader = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown';
    gl.deleteProgram(program);
    throw new Error(`Program failed to link: ${log}`);
  }
  return program;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

function uniformsOf(gl: WebGL2RenderingContext, program: WebGLProgram, names: string[]): Uniforms {
  const map: Uniforms = {};
  for (const name of names) map[name] = gl.getUniformLocation(program, name);
  return map;
}

export class SwarmRenderer implements RoomRenderer {
  readonly backend = 'webgl' as const;

  /**
   * Whether this renderer can still draw.
   *
   * `isContextLost` rather than a flag this class maintains: the context can go
   * without any event this object has seen yet, and in a room lit only by the
   * particle field a renderer that has quietly stopped drawing is
   * indistinguishable from ground nobody has walked on.
   */
  get alive(): boolean {
    return !this.disposed && !this.gl.isContextLost();
  }

  /** Whether this machine can run the swarm at all. */
  static probe(canvas: HTMLCanvasElement): boolean {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
    if (!gl) return false;
    const ok = Boolean(gl.getExtension('EXT_color_buffer_float'));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  }

  readonly particleCount: number;
  private readonly gl: WebGL2RenderingContext;
  private readonly side: number;
  private readonly dynamics: SwarmDynamics;
  private readonly simulateProgram: WebGLProgram;
  private readonly renderProgram: WebGLProgram;
  private readonly simulateUniforms: Uniforms;
  private readonly renderUniforms: Uniforms;
  private readonly quad: WebGLBuffer;
  private readonly quadArray: WebGLVertexArrayObject;
  private readonly emptyArray: WebGLVertexArrayObject;
  private readonly gradient: WebGLTexture;
  private readonly memory: WebGLTexture;
  private readonly presence: WebGLTexture;
  private readonly framebuffers: [WebGLFramebuffer, WebGLFramebuffer];
  private readonly stateTextures: [WebGLTexture, WebGLTexture];
  private readonly metaTextures: [WebGLTexture, WebGLTexture];
  private current = 0;
  private elapsed = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, requestedCount: number, dynamics: SwarmDynamics = SWARM_DYNAMICS) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is unavailable');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('EXT_color_buffer_float is unavailable');
    }
    this.gl = gl;
    this.dynamics = dynamics;
    this.side = swarmTextureSide(requestedCount);
    this.particleCount = this.side * this.side;

    this.simulateProgram = link(gl, QUAD_VERTEX, SIMULATE_FRAGMENT);
    this.renderProgram = link(gl, RENDER_VERTEX, RENDER_FRAGMENT);
    this.simulateUniforms = uniformsOf(gl, this.simulateProgram, [
      'uState', 'uMeta', 'uMemory', 'uPresence', 'uDt', 'uTime', 'uSide',
      'uMemoryFlow', 'uAmbientCurl', 'uDamping', 'uLife', 'uBodyRadius',
      'uBodyPush', 'uBodySwirl', 'uDrift', 'uUnrest', 'uBodyCount',
      'uBodies', 'uBodyStill', 'uBodyStrength', 'uBodyHeat', 'uSilhouettePull',
    ]);
    this.renderUniforms = uniformsOf(gl, this.renderProgram, [
      'uState', 'uMeta', 'uSide', 'uResolution', 'uPointScale', 'uPresenceBoost',
      'uGradient', 'uIntensity', 'uPaper',
    ]);

    const quad = gl.createBuffer();
    const quadArray = gl.createVertexArray();
    const emptyArray = gl.createVertexArray();
    if (!quad || !quadArray || !emptyArray) throw new Error('Unable to allocate swarm geometry');
    this.quad = quad;
    this.quadArray = quadArray;
    this.emptyArray = emptyArray;
    gl.bindVertexArray(quadArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.simulateProgram, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.stateTextures = [this.createStateTexture(), this.createStateTexture()];
    this.metaTextures = [this.createStateTexture(), this.createStateTexture()];
    this.framebuffers = [this.createTarget(0), this.createTarget(1)];
    this.gradient = this.createGradientTexture();
    this.memory = this.createFieldTexture();
    this.presence = this.createFieldTexture();
    this.seed();
  }

  private createStateTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Unable to allocate swarm state');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, this.side, this.side);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private createTarget(slot: 0 | 1): WebGLFramebuffer {
    const gl = this.gl;
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error('Unable to allocate swarm target');
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.stateTextures[slot], 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.metaTextures[slot], 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Swarm framebuffer is incomplete');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return framebuffer;
  }

  private createGradientTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Unable to allocate swarm gradient');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SWARM_LUT_WIDTH, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildSwarmGradientLut());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private createFieldTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Unable to allocate swarm field');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /** Scatter the initial population so the first frame is already alive. */
  private seed() {
    const gl = this.gl;
    const state = new Float32Array(this.side * this.side * 4);
    const meta = new Float32Array(this.side * this.side * 4);
    for (let index = 0; index < this.side * this.side; index += 1) {
      state[index * 4] = Math.random();
      state[index * 4 + 1] = Math.random();
      meta[index * 4] = Math.random() * this.dynamics.life;
      meta[index * 4 + 1] = this.dynamics.life * (0.45 + Math.random() * 1.1);
      meta[index * 4 + 2] = Math.random() * 1000;
    }
    for (const slot of [0, 1] as const) {
      gl.bindTexture(gl.TEXTURE_2D, this.stateTextures[slot]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.side, this.side, gl.RGBA, gl.FLOAT, state);
      gl.bindTexture(gl.TEXTURE_2D, this.metaTextures[slot], );
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.side, this.side, gl.RGBA, gl.FLOAT, meta);
    }
  }

  /** Upload the accumulated memory field. Values are 0..1 densities, not pixels. */
  setMemoryField(field: Float32Array, width: number, height: number) {
    if (this.disposed) return;
    const gl = this.gl;
    const bytes = new Uint8Array(width * height);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.round(Math.max(0, Math.min(1, field[index])) * 255);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.memory);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
  }

  /**
   * Upload the ephemeral motion-cell mask. This is the 40x23 grid of changed
   * cells the tracker already computes, never camera pixels, and it is not
   * retained here or anywhere downstream.
   */
  setPresenceMask(mask: ArrayLike<number>, width: number, height: number) {
    if (this.disposed) return;
    const gl = this.gl;
    const bytes = new Uint8Array(width * height);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = mask[index] >= 2 ? 255 : mask[index] >= 1 ? 90 : 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.presence);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
  }

  resize(width: number, height: number) {
    if (this.disposed) return;
    const canvas = this.gl.canvas as HTMLCanvasElement;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  render(frame: SwarmFrame) {
    if (this.disposed) return;
    const gl = this.gl;
    const dt = Math.min(0.05, Math.max(0, frame.deltaSeconds));
    this.elapsed += dt;
    const source = this.current;
    const target = this.current ^ 1;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[target]);
    gl.viewport(0, 0, this.side, this.side);
    gl.disable(gl.BLEND);
    gl.useProgram(this.simulateProgram);
    gl.bindVertexArray(this.quadArray);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTextures[source]);
    gl.uniform1i(this.simulateUniforms.uState, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.metaTextures[source]);
    gl.uniform1i(this.simulateUniforms.uMeta, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.memory);
    gl.uniform1i(this.simulateUniforms.uMemory, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.presence);
    gl.uniform1i(this.simulateUniforms.uPresence, 3);

    const d = this.dynamics;
    gl.uniform1f(this.simulateUniforms.uDt, dt);
    gl.uniform1f(this.simulateUniforms.uTime, this.elapsed);
    gl.uniform2f(this.simulateUniforms.uSide, this.side, this.side);
    gl.uniform1f(this.simulateUniforms.uMemoryFlow, d.memoryFlow);
    gl.uniform1f(this.simulateUniforms.uAmbientCurl, d.ambientCurl);
    gl.uniform1f(this.simulateUniforms.uDamping, d.damping);
    gl.uniform1f(this.simulateUniforms.uLife, d.life);
    gl.uniform1f(this.simulateUniforms.uBodyRadius, d.bodyRadius);
    gl.uniform1f(this.simulateUniforms.uBodyPush, d.bodyPush * frame.presence);
    gl.uniform1f(this.simulateUniforms.uBodySwirl, d.bodySwirl);
    gl.uniform1f(this.simulateUniforms.uDrift, frame.drift);
    gl.uniform1f(this.simulateUniforms.uUnrest, frame.unrest);
    gl.uniform1f(this.simulateUniforms.uSilhouettePull, d.silhouettePull);

    const bodies = frame.bodies.slice(0, MAX_BODIES);
    const packed = new Float32Array(MAX_BODIES * 4);
    const stillness = new Float32Array(MAX_BODIES);
    const strength = new Float32Array(MAX_BODIES);
    const heat = new Float32Array(MAX_BODIES);
    bodies.forEach((body, index) => {
      packed[index * 4] = body.x;
      packed[index * 4 + 1] = body.y;
      packed[index * 4 + 2] = body.vx;
      packed[index * 4 + 3] = body.vy;
      stillness[index] = Math.max(0, Math.min(1, body.stillness));
      strength[index] = Math.max(0, Math.min(1, body.strength));
      heat[index] = Math.max(0, Math.min(1, body.heat));
    });
    gl.uniform1i(this.simulateUniforms.uBodyCount, bodies.length);
    gl.uniform4fv(this.simulateUniforms.uBodies, packed);
    gl.uniform1fv(this.simulateUniforms.uBodyStill, stillness);
    gl.uniform1fv(this.simulateUniforms.uBodyStrength, strength);
    gl.uniform1fv(this.simulateUniforms.uBodyHeat, heat);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Draw the population.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const canvas = gl.canvas as HTMLCanvasElement;
    gl.viewport(0, 0, canvas.width, canvas.height);
    const paper = frame.projectionMode === 'paper';
    const ground = paper ? paletteFor('paper').ground : [0, 0, 0];
    gl.clearColor(ground[0] / 255, ground[1] / 255, ground[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(paper ? gl.ZERO : gl.ONE, paper ? gl.ONE_MINUS_SRC_COLOR : gl.ONE);
    gl.useProgram(this.renderProgram);
    gl.bindVertexArray(this.emptyArray);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTextures[target]);
    gl.uniform1i(this.renderUniforms.uState, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.metaTextures[target]);
    gl.uniform1i(this.renderUniforms.uMeta, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.gradient);
    gl.uniform1i(this.renderUniforms.uGradient, 2);

    gl.uniform2f(this.renderUniforms.uSide, this.side, this.side);
    gl.uniform2f(this.renderUniforms.uResolution, canvas.width, canvas.height);
    gl.uniform1f(this.renderUniforms.uPointScale, Math.max(1.2, canvas.width / 780));
    gl.uniform1f(this.renderUniforms.uPresenceBoost, frame.presence);
    gl.uniform1f(this.renderUniforms.uIntensity, frame.intensity);
    gl.uniform1i(this.renderUniforms.uPaper, paper ? 1 : 0);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);
    gl.bindVertexArray(null);

    this.current = target;
  }

  /** `RoomRenderer`'s name for `dispose`. Both stay: the component and its
   *  tests have called `dispose` since before there was an interface. */
  destroy() {
    this.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteProgram(this.simulateProgram);
    gl.deleteProgram(this.renderProgram);
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.quadArray);
    gl.deleteVertexArray(this.emptyArray);
    gl.deleteTexture(this.gradient);
    gl.deleteTexture(this.memory);
    gl.deleteTexture(this.presence);
    for (const texture of [...this.stateTextures, ...this.metaTextures]) gl.deleteTexture(texture);
    for (const framebuffer of this.framebuffers) gl.deleteFramebuffer(framebuffer);
  }
}
