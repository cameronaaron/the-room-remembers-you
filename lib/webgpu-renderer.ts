import { paletteFor } from './palette.ts';
import type { RoomRenderer } from './room-renderer.ts';
import { SWARM_DYNAMICS, type SwarmDynamics, buildSwarmGradientLut, SWARM_LUT_WIDTH } from './swarm.ts';
import { MAX_BODIES, type SwarmFrame } from './swarm-frame.ts';
import { assessWebGpu, dispatchCount, type WebGpuLimits } from './webgpu-capability.ts';
import {
  BODY_BYTES,
  PARTICLE_BYTES,
  RENDER_SHADER,
  UNIFORM,
  UNIFORM_BYTES,
  simulateShader,
} from './webgpu-shaders.ts';

/**
 * The WebGPU particle field.
 *
 * Written against the raw API, like the WebGL backend and for the same reason:
 * the shipped exhibit stays dependency-free.
 *
 * Nothing here ever receives camera pixels. Its sensor inputs are the ephemeral
 * 40x23 occupancy grid and the anonymous body positions the world model already
 * produces, neither of which is written anywhere. The privacy boundary is not
 * different on this backend, because the boundary is the `SwarmFrame` type and
 * not the API underneath it.
 *
 * ## Device loss
 *
 * A lost device is an ordinary runtime event on an installation machine: the
 * display sleeps, the projector renegotiates, a driver resets. WebGPU reports
 * it through a promise rather than an event, and everything built from the
 * device is gone the moment it resolves. So this object does what the WebGL one
 * does — it holds every resource in fields built by its factory and goes
 * `alive: false` instead of trying to repair itself. Rebuilding is the honest
 * recovery, and `renderer-health.ts` already holds the policy for how often
 * that is worth doing before the room falls back.
 *
 * A canvas that has held a WebGPU context cannot later hold a WebGL one, so
 * falling back needs a fresh canvas. That is the caller's problem and it is
 * stated here because it is not obvious.
 */

/** Sensible ceiling on the simulation step, matching the WebGL backend. */
const MAX_STEP_SECONDS = 0.05;

/** Field texture sizes. The memory field and the motion grid, as they arrive. */
type FieldTexture = { texture: GPUTexture; width: number; height: number };

export type WebGpuRendererOptions = {
  /** Particles asked for. What is actually run is `particleCount`. */
  budget: number;
  dynamics?: SwarmDynamics;
  /**
   * Source of the initial scatter. Injected so a regression run can seed a
   * reproducible field; the room's own behaviour does not depend on it.
   */
  random?: () => number;
  /** Called once when the device is lost, with the browser's own reason. */
  onDeviceLost?: (reason: string) => void;
  /**
   * A device the caller has already acquired.
   *
   * The shell owns device acquisition — that is the division of labour the
   * whole architecture rests on, because `getUserMedia`, permissions and
   * `requestAdapter` are things browsers are already excellent at and the
   * engine has no business knowing about. Supplying one here means a caller
   * that holds a device can hand it over rather than making this class go and
   * find a second one.
   *
   * It is also what makes two of the promotion gates checkable at all: a
   * harness that owns the device can destroy it to produce a real device loss,
   * and can count what the renderer allocates through it. A gate that cannot
   * be run is not a gate.
   *
   * The renderer does not take ownership: a supplied device is not destroyed
   * by `destroy()`, because the caller may still be using it.
   */
  device?: GPUDevice;
  /**
   * Called for every error the driver reports that nothing else caught.
   *
   * WebGPU does not throw from `submit`: a command buffer that fails validation
   * is silently dropped, the canvas keeps whatever it had, and the room shows a
   * frozen frame that looks exactly like a quiet gallery. This renderer was
   * built with two pipelines sharing one bind group by mistake, and that is
   * precisely how it presented — a static black wall in paper mode and no error
   * anywhere. An installation that cannot see this class of failure cannot
   * recover from it.
   */
  onError?: (message: string) => void;
};

/** Why `create` refused. A sentence for the console, not a boolean. */
export class WebGpuUnavailable extends Error {}

export class WebGpuRoomRenderer implements RoomRenderer {
  readonly backend = 'webgpu' as const;
  readonly particleCount: number;
  readonly workgroupSize: number;

  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly dynamics: SwarmDynamics;
  private readonly simulateLayout: GPUBindGroupLayout;
  private readonly particleLayout: GPUBindGroupLayout;
  private readonly gradientLayout: GPUBindGroupLayout;
  private readonly simulatePipeline: GPUComputePipeline;
  /** One pipeline per projection mode: they differ only in their blend state. */
  private readonly renderPipelines: Record<'room' | 'paper', GPURenderPipeline>;
  private readonly particles: GPUBuffer;
  private readonly bodies: GPUBuffer;
  private readonly uniforms: GPUBuffer;
  private readonly uniformData = new ArrayBuffer(UNIFORM_BYTES);
  private readonly uniformFloats: Float32Array;
  private readonly uniformInts: Uint32Array;
  private readonly bodyData = new Float32Array((BODY_BYTES / 4) * MAX_BODIES);
  private readonly sampler: GPUSampler;
  private readonly gradient: GPUTexture;
  private memory: FieldTexture;
  private presence: FieldTexture;
  private simulateBindGroup: GPUBindGroup;
  private readonly renderBindGroup: GPUBindGroup;
  private readonly gradientBindGroup: GPUBindGroup;
  private elapsed = 0;
  private lost = false;
  private destroyed = false;
  /** Whether the device came from the caller. A borrowed one is not destroyed. */
  private readonly borrowedDevice: boolean;

  get alive(): boolean {
    return !this.lost && !this.destroyed;
  }

  /**
   * Probe the machine and build a renderer, or refuse with a reason.
   *
   * Async because acquiring an adapter and a device is, and because pretending
   * otherwise would mean a constructor that returns an object which is not yet
   * able to draw — which is the shape that makes a renderer's first frame a
   * race rather than a frame.
   */
  static async create(
    canvas: HTMLCanvasElement,
    options: WebGpuRendererOptions,
  ): Promise<WebGpuRoomRenderer> {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) throw new WebGpuUnavailable('this browser has no WebGPU implementation');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new WebGpuUnavailable('no WebGPU adapter is available on this machine');

    const assessment = assessWebGpu(adapter.limits as unknown as WebGpuLimits, options.budget);
    if (!assessment.usable) throw new WebGpuUnavailable(assessment.reason);

    // A caller that already holds a device keeps holding it; this class only
    // destroys what it acquired itself. Mixing those up would have a failed
    // startup take down a device the shell was still using.
    const borrowed = options.device !== undefined;
    const device = options.device ?? await adapter.requestDevice();
    const abandon = () => { if (!borrowed) device.destroy(); };

    // Compile before touching the canvas, and report what the driver said. Two
    // reasons, and the second is the important one.
    //
    // A shader that fails to compile otherwise surfaces as a pipeline error
    // several calls later, with a message about a pipeline.
    //
    // And a canvas that has been given a WebGPU context can never hold a WebGL
    // one. Every way this can refuse has to happen before that, or a machine
    // that cannot run WebGPU also loses the renderer it *can* run — falling
    // back would need a whole new canvas element, mid-startup, in a component.
    const simulate = device.createShaderModule({ code: simulateShader(assessment.workgroupSize) });
    const render = device.createShaderModule({ code: RENDER_SHADER });
    for (const [name, module] of [['simulate', simulate], ['render', render]] as const) {
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((message) => message.type === 'error');
      if (errors.length > 0) {
        abandon();
        throw new WebGpuUnavailable(
          `the ${name} shader did not compile: ${errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join('; ')}`,
        );
      }
    }

    const context = canvas.getContext('webgpu');
    if (!context) {
      abandon();
      throw new WebGpuUnavailable('this canvas cannot hold a WebGPU context');
    }
    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    return new WebGpuRoomRenderer(
      canvas,
      context,
      device,
      format,
      { simulate, render },
      assessment.particleCount,
      assessment.workgroupSize,
      options,
    );
  }

  private constructor(
    canvas: HTMLCanvasElement,
    context: GPUCanvasContext,
    device: GPUDevice,
    format: GPUTextureFormat,
    modules: { simulate: GPUShaderModule; render: GPUShaderModule },
    particleCount: number,
    workgroupSize: number,
    options: WebGpuRendererOptions,
  ) {
    this.canvas = canvas;
    this.context = context;
    this.device = device;
    this.borrowedDevice = options.device !== undefined;
    this.particleCount = particleCount;
    this.workgroupSize = workgroupSize;
    this.dynamics = options.dynamics ?? SWARM_DYNAMICS;
    this.uniformFloats = new Float32Array(this.uniformData);
    this.uniformInts = new Uint32Array(this.uniformData);

    void device.lost.then((info) => {
      // Ordinary on a gallery machine, and never something to throw from a
      // frame. `alive` goes false and the caller decides whether to rebuild.
      if (this.destroyed) return;
      this.lost = true;
      options.onDeviceLost?.(info.message || info.reason || 'the GPU device was lost');
    });

    device.addEventListener('uncapturederror', (event) => {
      const error = (event as GPUUncapturedErrorEvent).error;
      options.onError?.(error.message);
    });

    // Explicit layouts, not `layout: 'auto'`.
    //
    // Two pipelines built with `auto` each get their own generated layout, and
    // a bind group made against one is not accepted by the other — so sharing a
    // bind group between the room and paper pipelines silently dropped every
    // paper frame. Declaring the layout once is both the fix and the
    // documentation: these are the bindings, and every pipeline that uses them
    // is using the same ones.
    const simulateLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      ],
    });
    this.particleLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.gradientLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.simulateLayout = simulateLayout;

    this.simulatePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [simulateLayout] }),
      compute: { module: modules.simulate, entryPoint: 'main' },
    });
    const renderLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.particleLayout, this.gradientLayout],
    });
    const renderPipeline = (mode: 'room' | 'paper') => device.createRenderPipeline({
      layout: renderLayout,
      vertex: { module: modules.render, entryPoint: 'vertexMain' },
      fragment: {
        module: modules.render,
        entryPoint: 'fragmentMain',
        targets: [{
          format,
          // Room: additive light. Paper: the mark takes light away, so the
          // destination is multiplied by what the particle did not absorb.
          // The same two blend functions the WebGL backend selects between.
          blend: mode === 'paper'
            ? {
              color: { srcFactor: 'zero', dstFactor: 'one-minus-src', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src', operation: 'add' },
            }
            : {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.renderPipelines = { room: renderPipeline('room'), paper: renderPipeline('paper') };

    this.particles = device.createBuffer({
      size: particleCount * PARTICLE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.bodies = device.createBuffer({
      size: MAX_BODIES * BODY_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.uniforms = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.gradient = this.createGradient();
    this.memory = this.createField(1, 1);
    this.presence = this.createField(1, 1);

    this.seed(options.random ?? Math.random);
    this.simulateBindGroup = this.buildSimulateBindGroup();
    this.renderBindGroup = device.createBindGroup({
      layout: this.particleLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: { buffer: this.particles } },
      ],
    });
    this.gradientBindGroup = device.createBindGroup({
      layout: this.gradientLayout,
      entries: [
        { binding: 0, resource: this.gradient.createView() },
        { binding: 1, resource: this.sampler },
      ],
    });
  }

  private buildSimulateBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.simulateLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: { buffer: this.particles } },
        { binding: 2, resource: { buffer: this.bodies } },
        { binding: 3, resource: this.memory.texture.createView() },
        { binding: 4, resource: this.presence.texture.createView() },
        { binding: 5, resource: this.sampler },
      ],
    });
  }

  private createGradient(): GPUTexture {
    const texture = this.device.createTexture({
      size: { width: SWARM_LUT_WIDTH, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const lut = buildSwarmGradientLut();
    this.device.queue.writeTexture(
      { texture },
      lut,
      { bytesPerRow: SWARM_LUT_WIDTH * 4 },
      { width: SWARM_LUT_WIDTH, height: 1 },
    );
    return texture;
  }

  private createField(width: number, height: number): FieldTexture {
    const texture = this.device.createTexture({
      size: { width, height },
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    return { texture, width, height };
  }

  /** Scatter the initial population so the first frame is already alive. */
  private seed(random: () => number) {
    const data = new Float32Array(this.particleCount * (PARTICLE_BYTES / 4));
    for (let index = 0; index < this.particleCount; index += 1) {
      const base = index * 8;
      data[base] = random();
      data[base + 1] = random();
      // velocity stays zero
      data[base + 4] = random() * this.dynamics.life;
      data[base + 5] = this.dynamics.life * (0.45 + random() * 1.1);
      data[base + 6] = random() * 1000;
      // depth stays zero: an unremembered room is the colour of an empty one
    }
    this.device.queue.writeBuffer(this.particles, 0, data);
  }

  /**
   * Upload a field, reusing the texture when the size has not changed.
   *
   * Sizes are fixed in practice — 64x36 for the memory field, 40x23 for the
   * motion grid — so this allocates twice in a session and never again. That
   * matters: a renderer that creates a texture per frame is a renderer whose
   * GPU memory grows all day, which is the failure this installation is least
   * able to notice.
   *
   * `writeTexture` needs rows padded to 256 bytes, which is the one piece of
   * WebGPU bookkeeping with no WebGL equivalent.
   */
  private uploadField(target: FieldTexture, bytes: Uint8Array<ArrayBuffer>, width: number, height: number): FieldTexture {
    let field = target;
    if (field.width !== width || field.height !== height) {
      field.texture.destroy();
      field = this.createField(width, height);
    }
    const stride = Math.ceil(width / 256) * 256;
    const padded = stride === width ? bytes : new Uint8Array(stride * height);
    if (stride !== width) {
      for (let row = 0; row < height; row += 1) {
        padded.set(bytes.subarray(row * width, row * width + width), row * stride);
      }
    }
    this.device.queue.writeTexture(
      { texture: field.texture },
      padded,
      { bytesPerRow: stride, rowsPerImage: height },
      { width, height },
    );
    return field;
  }

  setMemoryField(field: Float32Array, width: number, height: number) {
    if (!this.alive) return;
    const bytes = new Uint8Array(width * height);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.round(Math.max(0, Math.min(1, field[index])) * 255);
    }
    const before = this.memory;
    this.memory = this.uploadField(before, bytes, width, height);
    if (this.memory !== before) this.simulateBindGroup = this.buildSimulateBindGroup();
  }

  setPresenceMask(mask: ArrayLike<number>, width: number, height: number) {
    if (!this.alive) return;
    const bytes = new Uint8Array(width * height);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = mask[index] >= 2 ? 255 : mask[index] >= 1 ? 90 : 0;
    }
    const before = this.presence;
    this.presence = this.uploadField(before, bytes, width, height);
    if (this.presence !== before) this.simulateBindGroup = this.buildSimulateBindGroup();
  }

  resize(width: number, height: number) {
    if (!this.alive) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  render(frame: SwarmFrame) {
    if (!this.alive) return;
    const dt = Math.min(MAX_STEP_SECONDS, Math.max(0, frame.deltaSeconds));
    this.elapsed += dt;
    const paper = frame.projectionMode === 'paper';
    const dynamics = this.dynamics;

    const bodies = frame.bodies.slice(0, MAX_BODIES);
    this.bodyData.fill(0);
    bodies.forEach((body, index) => {
      const base = index * 8;
      this.bodyData[base] = body.x;
      this.bodyData[base + 1] = body.y;
      this.bodyData[base + 2] = body.vx;
      this.bodyData[base + 3] = body.vy;
      this.bodyData[base + 4] = Math.max(0, Math.min(1, body.stillness));
      this.bodyData[base + 5] = Math.max(0, Math.min(1, body.strength));
      this.bodyData[base + 6] = Math.max(0, Math.min(1, body.heat));
    });
    this.device.queue.writeBuffer(this.bodies, 0, this.bodyData);

    const floats = this.uniformFloats;
    floats[UNIFORM.dt] = dt;
    floats[UNIFORM.time] = this.elapsed;
    floats[UNIFORM.memoryFlow] = dynamics.memoryFlow;
    floats[UNIFORM.ambientCurl] = dynamics.ambientCurl;
    floats[UNIFORM.damping] = dynamics.damping;
    floats[UNIFORM.life] = dynamics.life;
    floats[UNIFORM.bodyRadius] = dynamics.bodyRadius;
    floats[UNIFORM.bodyPush] = dynamics.bodyPush * frame.presence;
    floats[UNIFORM.bodySwirl] = dynamics.bodySwirl;
    floats[UNIFORM.drift] = frame.drift;
    floats[UNIFORM.unrest] = frame.unrest;
    floats[UNIFORM.silhouettePull] = dynamics.silhouettePull;
    floats[UNIFORM.pointScale] = Math.max(1.2, this.canvas.width / 780);
    floats[UNIFORM.presenceBoost] = frame.presence;
    floats[UNIFORM.intensity] = frame.intensity;
    floats[UNIFORM.resolutionX] = this.canvas.width;
    floats[UNIFORM.resolutionY] = this.canvas.height;
    this.uniformInts[UNIFORM.bodyCount] = bodies.length;
    this.uniformInts[UNIFORM.particleCount] = this.particleCount;
    this.uniformInts[UNIFORM.paper] = paper ? 1 : 0;
    this.device.queue.writeBuffer(this.uniforms, 0, this.uniformData);

    const ground = paper ? paletteFor('paper').ground : [0, 0, 0];
    const encoder = this.device.createCommandEncoder();

    const compute = encoder.beginComputePass();
    compute.setPipeline(this.simulatePipeline);
    compute.setBindGroup(0, this.simulateBindGroup);
    compute.dispatchWorkgroups(dispatchCount(this.particleCount, this.workgroupSize));
    compute.end();

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: ground[0] / 255, g: ground[1] / 255, b: ground[2] / 255, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.renderPipelines[paper ? 'paper' : 'room']);
    pass.setBindGroup(0, this.renderBindGroup);
    pass.setBindGroup(1, this.gradientBindGroup);
    pass.draw(6, this.particleCount);
    pass.end();

    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Resolves when the GPU has finished everything submitted so far.
   *
   * `render` records commands and submits; the work happens afterwards, so
   * timing `render` measures how long it took to *describe* a frame, not how
   * long the frame took. Anything measuring frame time needs this, and so
   * would a shell that wanted to detect a GPU that has stopped making progress
   * while the page stays responsive — which §10 names as a distinct failure
   * from a dead page and the supervisor is supposed to tell apart.
   *
   * Resolves immediately on a dead renderer rather than hanging: a caller
   * awaiting a device that has gone would otherwise stall its own loop.
   */
  completed(): Promise<undefined> {
    if (!this.alive) return Promise.resolve(undefined);
    return this.device.queue.onSubmittedWorkDone();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.particles.destroy();
    this.bodies.destroy();
    this.uniforms.destroy();
    this.gradient.destroy();
    this.memory.texture.destroy();
    this.presence.texture.destroy();
    // Unconfiguring first: the context holds a reference to the device, and a
    // destroyed device behind a configured context is what turns a tidy
    // shutdown into a validation error on the next frame.
    this.context.unconfigure();
    // Only what this renderer acquired. A device the caller supplied stays
    // theirs: destroying it here would take down a device the shell may still
    // be using for the renderer it is rebuilding on.
    if (!this.borrowedDevice) this.device.destroy();
  }
}
