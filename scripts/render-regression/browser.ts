import { SwarmRenderer, type SwarmFrame } from '../../lib/swarm-renderer';
import { WebGpuRoomRenderer } from '../../lib/webgpu-renderer';
import { SWARM_BUDGET } from '../../lib/swarm';
import { paletteFor } from '../../lib/palette';

/**
 * What establishes a renderer.
 *
 * Numerical tests cannot see a renderer that draws nothing, draws the same
 * thing forever, or draws it upside down: the standards already record two
 * defects that passed every check that existed and were visible only in a
 * screenshot. So this runs in a real browser against a real GPU and reads real
 * pixels back.
 *
 * Both backends take the same checks. WebGL is the exhibition default and
 * WebGPU is opt-in, and the reason the same suite runs over both is that
 * "WebGPU only becomes the default after it passes visual parity" has to be a
 * gate rather than an intention.
 *
 * Parity here is statistical, not per-pixel, and deliberately so: the two
 * backends run different population sizes and scatter their respawns from
 * different hashes, so they are two draws from one distribution. What must
 * match is how much of the wall is alive, that it keeps moving, that blackout
 * is black and reversible, and that a body appears where the body is.
 */

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

/** A deterministic scatter, so a failure is the same failure twice. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const WIDTH = 240;
const HEIGHT = 150;

type Pixels = { data: Uint8ClampedArray | Uint8Array; width: number; height: number };

/** Fraction of the surface that differs from the ground the palette expects. */
function visibleFraction(pixels: Pixels, ground: readonly number[]): number {
  let visible = 0;
  for (let index = 0; index < pixels.data.length; index += 4) {
    let contrast = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      contrast = Math.max(contrast, Math.abs(ground[channel] - pixels.data[index + channel]));
    }
    if (contrast >= 12) visible += 1;
  }
  return visible / (pixels.width * pixels.height);
}

/** Fraction of the surface that changed between two captures. */
function changedFraction(before: Pixels, after: Pixels): number {
  let changed = 0;
  for (let index = 0; index < after.data.length; index += 4) {
    let delta = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      delta = Math.max(delta, Math.abs(before.data[index + channel] - after.data[index + channel]));
    }
    if (delta >= 8) changed += 1;
  }
  return changed / (after.width * after.height);
}

/**
 * Mean luminance inside a window of the *room*, in room coordinates.
 *
 * Takes the row direction as an argument because the two APIs hand their
 * pixels back in opposite vertical order — `readPixels` from the bottom,
 * a 2D canvas from the top — and a check about where a body appears is exactly
 * the check a y-flip would otherwise sail through.
 */
function luminanceIn(pixels: Pixels, topDown: boolean, x0: number, y0: number, x1: number, y1: number): number {
  let total = 0;
  let count = 0;
  for (let row = 0; row < pixels.height; row += 1) {
    const roomY = topDown ? row / pixels.height : 1 - row / pixels.height;
    if (roomY < y0 || roomY > y1) continue;
    for (let column = 0; column < pixels.width; column += 1) {
      const roomX = column / pixels.width;
      if (roomX < x0 || roomX > x1) continue;
      const index = (row * pixels.width + column) * 4;
      total += 0.2126 * pixels.data[index] + 0.7152 * pixels.data[index + 1] + 0.0722 * pixels.data[index + 2];
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

const results: string[] = [];

/**
 * What one backend did at one budget, in numbers that can be compared to
 * another backend's.
 */
type Measurement = {
  visible: Record<'room' | 'paper', number>;
  changed: Record<'room' | 'paper', number>;
  bodyGain: number;
};

/**
 * Tolerance on the two backends agreeing, in fraction of the surface.
 *
 * They run different population sizes and scatter respawns from different
 * hashes, so this compares two draws from one distribution rather than two
 * copies of one image. Three points of the wall is well inside what a visitor
 * could notice and well outside the sampling difference: measured on this
 * machine the largest gap was 0.6 points, and a gap approaching this number is
 * a finding rather than a reason to move it.
 */
const PARITY_TOLERANCE = 0.03;

/** The suite, over any backend that can be captured. */
function exercise(
  label: string,
  capture: (frame: SwarmFrame) => Pixels,
  topDown: boolean,
): Measurement {
  const measured: Measurement = {
    visible: { room: 0, paper: 0 },
    changed: { room: 0, paper: 0 },
    bodyGain: 0,
  };
  const scene: SwarmFrame = {
    deltaSeconds: 1 / 30,
    intensity: 0.85,
    drift: 0.35,
    unrest: 0.1,
    presence: 0.55,
    bodies: [],
  };
  for (const projectionMode of ['room', 'paper', 'room'] as const) {
    const frame = { ...scene, projectionMode };
    const before = capture(frame);
    let after = before;
    for (let step = 0; step < 3; step += 1) after = capture(frame);
    const ground = projectionMode === 'paper' ? paletteFor('paper').ground : [0, 0, 0];
    const visible = visibleFraction(after, ground);
    const changed = changedFraction(before, after);
    check(visible > 0.05, `${label}/${projectionMode}: field is blank (${visible.toFixed(3)} visible)`);
    check(changed > 0.02, `${label}/${projectionMode}: field is frozen (${changed.toFixed(3)} changed)`);
    measured.visible[projectionMode] = visible;
    measured.changed[projectionMode] = changed;
    results.push(`${label}/${projectionMode}: ${(100 * visible).toFixed(1)}% visible, ${(100 * changed).toFixed(1)}% moving`);

    const black = capture({ ...scene, projectionMode, intensity: 0, presence: 0 });
    if (projectionMode === 'room') {
      check(
        black.data.every((value, index) => index % 4 === 3 || value === 0),
        `${label}: blackout must be completely black`,
      );
    }
    const resumed = capture(frame);
    check(
      visibleFraction(resumed, ground) > 0.02,
      `${label}/${projectionMode}: blackout must be reversible`,
    );
  }

  // Where a body is. The one check a vertical flip cannot pass: a visitor
  // standing at the top of the room must brighten the top of the wall.
  const empty = { ...scene, projectionMode: 'room' as const, bodies: [] };
  for (let step = 0; step < 20; step += 1) capture(empty);
  const quiet = capture(empty);
  const quietTop = luminanceIn(quiet, topDown, 0.3, 0.05, 0.7, 0.3);
  const quietBottom = luminanceIn(quiet, topDown, 0.3, 0.7, 0.7, 0.95);

  const standing = {
    ...scene,
    projectionMode: 'room' as const,
    presence: 1,
    bodies: [{ x: 0.5, y: 0.16, vx: 0, vy: 0, stillness: 0.9, strength: 1, heat: 1 }],
  };
  for (let step = 0; step < 20; step += 1) capture(standing);
  const answered = capture(standing);
  const answeredTop = luminanceIn(answered, topDown, 0.3, 0.05, 0.7, 0.3);
  const answeredBottom = luminanceIn(answered, topDown, 0.3, 0.7, 0.7, 0.95);

  const nearGain = answeredTop - quietTop;
  const farGain = answeredBottom - quietBottom;
  check(nearGain > 1, `${label}: a body must brighten the room where it stands (gain ${nearGain.toFixed(2)})`);
  check(
    nearGain > farGain,
    `${label}: the body brightened the far side more than its own (${nearGain.toFixed(2)} vs ${farGain.toFixed(2)}) — check the vertical flip`,
  );
  measured.bodyGain = nearGain;
  results.push(`${label}/body: +${nearGain.toFixed(1)} where it stands, +${farGain.toFixed(1)} across the room`);
  return measured;
}

/**
 * Three of the four gates that stand between WebGPU and being the default.
 *
 * `docs/ARCHITECTURE.md` lists them: device-loss recovery, GPU memory over a
 * long session, frame pacing, and a soak on the machine the gallery actually
 * uses. The fourth needs that machine and a day; these three need a browser,
 * and a gate that needs a browser and is not run is not a gate.
 *
 * They deliberately do not assert that WebGPU is *fast*. The claim each one
 * makes is the one a gallery cares about: that a lost device comes back, that
 * running all evening does not grow the GPU's footprint, and that frames are
 * paced rather than merely produced.
 */
async function promotionGates(): Promise<void> {
  await deviceLossRecovers();
  await gpuResourcesStayBounded();
  await framePacingIsSteady();
}

/** A scene with something in it, for the gates below. */
const LIVE_FRAME: SwarmFrame = {
  deltaSeconds: 1 / 60,
  intensity: 0.85,
  drift: 0.35,
  unrest: 0.1,
  presence: 0.6,
  projectionMode: 'room',
  bodies: [{ x: 0.5, y: 0.5, vx: 0.1, vy: 0, stillness: 0.2, strength: 1, heat: 1 }],
};

function surface(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.body.appendChild(canvas);
  return canvas;
}

/**
 * Gate: a lost GPU device is a recoverable runtime event, not the end of the
 * evening.
 *
 * Projectors sleep, drivers reset, and a compositor can take the device away
 * for reasons that have nothing to do with this program. `device.destroy()` is
 * the only way to make that happen on demand, and it produces the same state
 * the browser reports for a real loss: `lost` resolves, `alive` goes false,
 * and every later call has to be accepted and ignored rather than throwing
 * into the middle of a frame.
 *
 * Recovery is a rebuild, which `renderer-mount.ts` owns in the shell. What is
 * checked here is the half that needs a GPU: that the loss is *noticed*, that
 * a dead renderer is inert, and that a fresh renderer on a fresh canvas draws
 * the artwork again. A canvas is consumed by the first graphics API it is
 * asked for, permanently, so the rebuild gets a new element — the same rule
 * `gpu-surface.ts` holds for the same reason.
 */
async function deviceLossRecovers(): Promise<void> {
  const canvas = surface();
  let lostReason: string | null = null;
  // The harness owns the device, which is how the loss is made to happen on
  // demand: `destroy()` produces exactly the state the browser reports for a
  // real loss. There is no other way to ask for one.
  const adapter = await navigator.gpu.requestAdapter();
  check(Boolean(adapter), 'no WebGPU adapter to lose');
  const device = await adapter!.requestDevice();
  const renderer = await WebGpuRoomRenderer.create(canvas, {
    budget: SWARM_BUDGET.CHEAP,
    random: seeded(11),
    device,
    onDeviceLost: (reason) => { lostReason = reason; },
  });
  renderer.resize(WIDTH, HEIGHT);
  for (let step = 0; step < 8; step += 1) renderer.render(LIVE_FRAME);
  check(renderer.alive, 'the renderer must be alive before the device is taken');

  device.destroy();
  // `lost` is a promise, so the notification lands on a later task.
  for (let wait = 0; wait < 200 && !lostReason; wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  check(lostReason !== null, 'a lost device must be reported, not discovered by a frozen wall');
  check(!renderer.alive, 'a renderer whose device has gone must say so');
  // The property that keeps a renderer failure from killing the installation:
  // a dead renderer accepts every call and draws nothing.
  renderer.resize(WIDTH, HEIGHT);
  renderer.setMemoryField(new Float32Array(64 * 36), 64, 36);
  renderer.render(LIVE_FRAME);
  renderer.destroy();
  canvas.remove();
  results.push(`device loss: reported as "${String(lostReason)}", renderer inert`);

  // The rebuild. A fresh canvas, because the old one is spent.
  const replacement = surface();
  const rebuilt = await WebGpuRoomRenderer.create(replacement, {
    budget: SWARM_BUDGET.CHEAP,
    random: seeded(11),
  });
  rebuilt.resize(WIDTH, HEIGHT);
  const mirror = document.createElement('canvas');
  mirror.width = WIDTH;
  mirror.height = HEIGHT;
  const context2d = mirror.getContext('2d', { willReadFrequently: true })!;
  for (let step = 0; step < 12; step += 1) rebuilt.render(LIVE_FRAME);
  check(rebuilt.alive, 'a rebuilt renderer must be alive');
  context2d.drawImage(replacement, 0, 0);
  const recovered = context2d.getImageData(0, 0, WIDTH, HEIGHT);
  const visible = visibleFraction({ data: recovered.data, width: WIDTH, height: HEIGHT }, [0, 0, 0]);
  check(visible > 0.05, `a rebuilt renderer must draw the artwork again (${visible.toFixed(3)} visible)`);
  results.push(`device loss: rebuilt and drawing ${(100 * visible).toFixed(1)}% of the wall`);
  rebuilt.destroy();
  replacement.remove();
  mirror.remove();
}

/**
 * Gate: an evening of frames must not grow the GPU's footprint.
 *
 * WebGPU exposes no memory counter, and a browser will not tell a page how
 * much video memory it holds. What *is* observable, and is the thing that
 * actually goes wrong, is allocation: a renderer that creates a buffer, a
 * texture or a bind group inside its frame loop grows without bound until the
 * driver refuses, which on an installation machine happens some hours after
 * anybody was watching. So the device's constructors are counted, and the
 * claim is the strong one — **after the first frame, a steady scene allocates
 * nothing at all**.
 *
 * Resizing is exempt and is checked separately: a resize is supposed to
 * reallocate, and it happens when a projector changes mode, not every frame.
 */
async function gpuResourcesStayBounded(): Promise<void> {
  const adapter = await navigator.gpu.requestAdapter();
  check(Boolean(adapter), 'no WebGPU adapter to measure allocations on');
  const device = await adapter!.requestDevice();
  const counts = { buffer: 0, texture: 0, bindGroup: 0 };
  for (const [kind, method] of [
    ['buffer', 'createBuffer'],
    ['texture', 'createTexture'],
    ['bindGroup', 'createBindGroup'],
  ] as const) {
    const original = device[method].bind(device) as (descriptor: never) => unknown;
    (device as unknown as Record<string, unknown>)[method] = (descriptor: never) => {
      counts[kind] += 1;
      return original(descriptor);
    };
  }

  const canvas = surface();
  const renderer = await WebGpuRoomRenderer.create(canvas, {
    budget: SWARM_BUDGET.CHEAP,
    random: seeded(5),
    device,
  });
  renderer.resize(WIDTH, HEIGHT);
  const field = new Float32Array(64 * 36).fill(0.4);
  const mask = new Uint8Array(32 * 18).fill(1);
  // Everything a frame does, once, so anything lazily created is created.
  for (let step = 0; step < 5; step += 1) {
    renderer.setMemoryField(field, 64, 36);
    renderer.setPresenceMask(mask, 32, 18);
    renderer.render(LIVE_FRAME);
  }
  const settled = { ...counts };

  // An evening, compressed. 3,000 frames is under a minute of gallery time at
  // 60 Hz, and it is enough: a per-frame allocation shows up in the first
  // hundred, and one that does not show up in three thousand is not per-frame.
  for (let step = 0; step < 3_000; step += 1) {
    renderer.setMemoryField(field, 64, 36);
    renderer.setPresenceMask(mask, 32, 18);
    renderer.render({ ...LIVE_FRAME, intensity: 0.5 + 0.35 * Math.sin(step / 40) });
  }
  for (const kind of ['buffer', 'texture', 'bindGroup'] as const) {
    check(
      counts[kind] === settled[kind],
      `3,000 frames created ${counts[kind] - settled[kind]} more ${kind}s — `
      + 'a steady scene must allocate nothing',
    );
  }
  results.push(
    `gpu allocations over 3,000 frames: ${counts.buffer} buffers, `
    + `${counts.texture} textures, ${counts.bindGroup} bind groups, none of them in the loop`,
  );

  // A resize allocates nothing of the renderer's: the canvas dimensions change
  // and the browser reconfigures the swapchain. Worth pinning, because the
  // obvious implementation — rebuild everything when the surface changes —
  // would turn a projector waking up into a reallocation storm.
  const beforeResize = { ...counts };
  renderer.resize(WIDTH * 2, HEIGHT * 2);
  renderer.render(LIVE_FRAME);
  check(
    counts.buffer === beforeResize.buffer && counts.texture === beforeResize.texture,
    'a resize must not reallocate: the swapchain is the browser\'s to rebuild',
  );

  // What *is* allowed to reallocate is a field whose dimensions changed, and
  // it must — the texture is sized to the field, not to the wall. A renderer
  // that stretched the old texture would show yesterday's memory at the wrong
  // scale, and one that rebuilt on every upload would allocate per frame,
  // which is the case the loop above rules out.
  renderer.setMemoryField(new Float32Array(32 * 18).fill(0.3), 32, 18);
  check(
    counts.texture > beforeResize.texture,
    'a memory field of a new size must get a texture of that size',
  );
  const resized = counts.texture;
  for (let step = 0; step < 50; step += 1) {
    renderer.setMemoryField(new Float32Array(32 * 18).fill(0.3), 32, 18);
  }
  check(counts.texture === resized, 'a field of an unchanged size must reuse its texture');
  results.push(`gpu allocations: a resize costs none, a new field size costs one texture`);

  renderer.destroy();
  canvas.remove();
}

/**
 * Gate: frames are paced, not merely produced.
 *
 * A renderer that averages well inside the budget and stalls every twentieth
 * frame reads as a stutter, and an average cannot see it. So this measures the
 * spread: the worst frame in a run against the median of that run.
 *
 * # What is timed, and why not the obvious thing
 *
 * Not `render()`. The first attempt timed exactly that and the gate refused
 * itself: `render` records commands and submits, and the GPU does the work
 * afterwards, so on this machine the median came back as **0.000 ms** —
 * `performance.now()` is clamped to a tenth of a millisecond and there was
 * nothing above the clamp to see. A ratio built on a median of zero is not a
 * measurement of anything, which is why the check below has a floor under it.
 *
 * So each frame is submitted and then *awaited* to completion with
 * `onSubmittedWorkDone`. That serialises the CPU and the GPU, so it is not a
 * measure of throughput — it is a measure of how long one frame takes to
 * finish, which is what a projector running at 60 Hz actually experiences.
 *
 * # What is asserted, and what is only reported
 *
 * The absolute numbers are not a gate. Headless Chrome against ANGLE on a
 * build machine is not the gallery's projector, and asserting milliseconds
 * here would be asserting something about this machine. What is portable is
 * the shape: a renderer whose worst frame is many times its median is doing
 * something per frame that it should not be, on any hardware. The numbers go
 * into the report so a human can compare them against the machine the gallery
 * uses, which is the fourth gate and needs that machine.
 */
async function framePacingIsSteady(): Promise<void> {
  const canvas = surface();
  const renderer = await WebGpuRoomRenderer.create(canvas, {
    budget: SWARM_BUDGET.FULL,
    random: seeded(23),
  });
  renderer.resize(WIDTH, HEIGHT);
  const settle = async () => {
    renderer.render(LIVE_FRAME);
    await renderer.completed();
  };
  for (let step = 0; step < 30; step += 1) await settle();

  const samples: number[] = [];
  // Each sample costs a GPU round trip, so this is a couple of seconds of
  // frames rather than a couple of minutes. Enough to see a periodic stall:
  // anything that happens less often than once in 240 frames is not pacing.
  for (let step = 0; step < 240; step += 1) {
    const start = performance.now();
    renderer.render({ ...LIVE_FRAME, intensity: 0.5 + 0.35 * Math.sin(step / 30) });
    await renderer.completed();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p99 = samples[Math.floor(samples.length * 0.99)];
  const worst = samples[samples.length - 1];
  results.push(
    `frame pacing (${renderer.particleCount} particles, GPU completion): `
    + `median ${median.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, worst ${worst.toFixed(2)} ms`,
  );
  // The floor the first version of this gate lacked. A median the clock cannot
  // see makes every ratio below it meaningless, and a gate that cannot fail is
  // not a gate.
  check(
    median >= 0.2,
    `frames completed in ${median.toFixed(3)} ms, at or under the clock's resolution — `
    + 'the pacing gate measured nothing',
  );
  check(
    worst < median * 8,
    `the worst frame was ${(worst / median).toFixed(1)}x the median `
    + `(${worst.toFixed(2)} ms against ${median.toFixed(2)} ms) — something is happening per frame`,
  );
  renderer.destroy();
  canvas.remove();
}

function webglSuite(): Map<number, Measurement> {
  const measured = new Map<number, Measurement>();
  for (const budget of Object.values(SWARM_BUDGET)) {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const renderer = new SwarmRenderer(canvas, budget);
    renderer.resize(WIDTH, HEIGHT);
    const gl = canvas.getContext('webgl2')!;
    const capture = (frame: SwarmFrame): Pixels => {
      renderer.render(frame);
      const data = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      check(gl.getError() === gl.NO_ERROR, 'WebGL must render without an error');
      return { data, width: canvas.width, height: canvas.height };
    };
    // readPixels starts at the bottom row, so these pixels are bottom-up.
    measured.set(budget, exercise(`webgl:${budget}`, capture, false));
    renderer.destroy();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
  }
  return measured;
}

async function webgpuSuite(reference: Map<number, Measurement>): Promise<string | null> {
  if (!('gpu' in navigator)) return 'this browser has no WebGPU implementation';
  // Only the extremes: the suite is the same at every size, and a headless run
  // that takes a minute is a gate people stop running.
  for (const budget of [SWARM_BUDGET.CHEAP, SWARM_BUDGET.FULL]) {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    document.body.appendChild(canvas);
    // A driver error is not something WebGPU throws. `submit` drops an invalid
    // command buffer, the canvas keeps its last contents, and the wall shows a
    // frozen frame — which is how a shared-bind-group mistake presented while
    // this suite was being written. Collected here so the gate sees it.
    const driverErrors: string[] = [];
    let renderer: WebGpuRoomRenderer;
    try {
      renderer = await WebGpuRoomRenderer.create(canvas, {
        budget,
        random: seeded(7),
        onError: (message) => driverErrors.push(message),
      });
    } catch (error) {
      canvas.remove();
      return error instanceof Error ? error.message : String(error);
    }
    renderer.resize(WIDTH, HEIGHT);
    // A WebGPU canvas cannot be read back directly, and giving the swapchain
    // COPY_SRC for the benefit of a test would change what the exhibit
    // configures. Drawing it into a 2D canvas is the capture path a browser
    // already provides, and it is top-down.
    const mirror = document.createElement('canvas');
    mirror.width = WIDTH;
    mirror.height = HEIGHT;
    const context2d = mirror.getContext('2d', { willReadFrequently: true })!;
    const capture = (frame: SwarmFrame): Pixels => {
      renderer.render(frame);
      check(renderer.alive, 'the WebGPU device must survive the frame');
      check(driverErrors.length === 0, `the driver reported: ${driverErrors.join('; ')}`);
      context2d.clearRect(0, 0, WIDTH, HEIGHT);
      context2d.drawImage(canvas, 0, 0);
      const image = context2d.getImageData(0, 0, WIDTH, HEIGHT);
      return { data: image.data, width: WIDTH, height: HEIGHT };
    };
    const measured = exercise(`webgpu:${renderer.particleCount}`, capture, true);
    results.push(`webgpu:${budget}: ${renderer.particleCount} particles in workgroups of ${renderer.workgroupSize}`);

    // The gate the spec actually asks for: not that each backend draws
    // something, but that they draw the same artwork.
    const webgl = reference.get(budget);
    check(Boolean(webgl), `no WebGL measurement to compare ${budget} against`);
    if (webgl) {
      for (const mode of ['room', 'paper'] as const) {
        for (const property of ['visible', 'changed'] as const) {
          const gap = Math.abs(measured[property][mode] - webgl[property][mode]);
          check(
            gap <= PARITY_TOLERANCE,
            `webgpu:${budget}/${mode}: ${property} differs from WebGL by ${(100 * gap).toFixed(1)} points `
            + `(${(100 * measured[property][mode]).toFixed(1)}% against ${(100 * webgl[property][mode]).toFixed(1)}%)`,
          );
          results.push(`parity ${budget}/${mode}/${property}: ${(100 * gap).toFixed(2)} points apart`);
        }
      }
      // A visitor has to feel answered by the same amount on either backend.
      const bodyGap = Math.abs(measured.bodyGain - webgl.bodyGain) / Math.max(1, webgl.bodyGain);
      check(bodyGap < 0.25, `webgpu:${budget}: a body is answered ${(100 * bodyGap).toFixed(0)}% differently than on WebGL`);
      results.push(`parity ${budget}/body: ${(100 * bodyGap).toFixed(1)}% apart`);
    }
    renderer.destroy();
    check(!renderer.alive, 'a destroyed renderer must report that it cannot draw');
    canvas.remove();
    mirror.remove();
  }
  return null;
}

void (async () => {
  let report: string;
  try {
    const random = seeded(42);
    Math.random = random;
    const reference = webglSuite();
    const skipped = await webgpuSuite(reference);
    if (skipped) results.push(`WEBGPU-SKIPPED: ${skipped}`);
    else await promotionGates();
    report = `PASS\n${results.join('\n')}`;
  } catch (error) {
    report = `FAIL\n${error instanceof Error ? error.stack : String(error)}\n${results.join('\n')}`;
  }
  document.body.textContent = report;
  void fetch('/result', { method: 'POST', body: report });
})();
