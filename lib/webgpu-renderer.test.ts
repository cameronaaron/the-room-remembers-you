import assert from 'node:assert/strict';
import test from 'node:test';
import { WebGpuRoomRenderer, WebGpuUnavailable } from './webgpu-renderer.ts';
import { overrideGlobals } from './test-doubles/browser.ts';
import { SWARM_BUDGET } from './swarm.ts';

/**
 * What can be checked about the WebGPU backend without a GPU: the refusals.
 *
 * The drawing is established by `npm run test:render`, which runs it against a
 * real adapter in headless Chrome and compares its pixels to WebGL's. A Node
 * test runner cannot see inside a shader and scoring one here would be a number
 * for code that never ran.
 *
 * The refusals are a different matter, and they are the part that decides
 * whether a gallery machine shows the artwork or a blank wall. Every one has to
 * fail as a named reason rather than as a crash, because the caller's answer to
 * "WebGPU is not available here" is to run WebGL, and it can only do that if it
 * is told rather than thrown at.
 */

const canvas = () => ({ getContext: () => null }) as unknown as HTMLCanvasElement;

void test('a browser with no WebGPU is told so, in a sentence', async () => {
  const restore = overrideGlobals({ navigator: {} });
  try {
    await assert.rejects(
      WebGpuRoomRenderer.create(canvas(), { budget: SWARM_BUDGET.STANDARD }),
      (error: unknown) => {
        assert.ok(error instanceof WebGpuUnavailable);
        assert.match(error.message, /no WebGPU implementation/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

void test('a machine with WebGPU but no adapter is a fallback, not a crash', async () => {
  const restore = overrideGlobals({
    navigator: { gpu: { requestAdapter: async () => null } },
  });
  try {
    await assert.rejects(
      WebGpuRoomRenderer.create(canvas(), { budget: SWARM_BUDGET.STANDARD }),
      (error: unknown) => {
        assert.ok(error instanceof WebGpuUnavailable);
        assert.match(error.message, /no WebGPU adapter/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

/**
 * An adapter that exists and cannot carry the field is the interesting case: it
 * is the one where an optimistic implementation builds a pipeline, dispatches
 * nothing useful and leaves a dark wall. The limits are read before a device is
 * even requested.
 */
void test('an adapter too small for the field refuses before it asks for a device', async () => {
  let askedForDevice = false;
  const restore = overrideGlobals({
    navigator: {
      gpu: {
        requestAdapter: async () => ({
          limits: {
            maxComputeInvocationsPerWorkgroup: 8,
            maxComputeWorkgroupSizeX: 8,
            maxComputeWorkgroupsPerDimension: 65_535,
            maxStorageBufferBindingSize: 128 * 1024 * 1024,
            maxBufferSize: 256 * 1024 * 1024,
            maxStorageBuffersPerShaderStage: 8,
          },
          requestDevice: async () => {
            askedForDevice = true;
            return {};
          },
        }),
      },
    },
  });
  try {
    await assert.rejects(
      WebGpuRoomRenderer.create(canvas(), { budget: SWARM_BUDGET.CHEAP }),
      (error: unknown) => {
        assert.ok(error instanceof WebGpuUnavailable);
        assert.match(error.message, /invocations per workgroup/);
        return true;
      },
    );
    assert.equal(askedForDevice, false, 'a device this adapter cannot use is not worth acquiring');
  } finally {
    restore();
  }
});

/**
 * A canvas that already holds a 2D or WebGL context returns null here. The
 * device has been acquired by then and has to be given back — a leaked GPU
 * device on a machine that runs for weeks is a machine that eventually stops
 * being able to make one.
 *
 * Reaching this at all is also the proof of the ordering that matters: every
 * other refusal happens *before* the canvas is asked for a WebGPU context,
 * because once it has one it can never hold a WebGL one, and a machine that
 * cannot run WebGPU must not lose the renderer it can run.
 */
void test('a canvas that cannot hold a WebGPU context gives the device back', async () => {
  let destroyed = false;
  let compiled = 0;
  const restore = overrideGlobals({
    navigator: {
      gpu: {
        requestAdapter: async () => ({
          limits: {
            maxComputeInvocationsPerWorkgroup: 256,
            maxComputeWorkgroupSizeX: 256,
            maxComputeWorkgroupsPerDimension: 65_535,
            maxStorageBufferBindingSize: 128 * 1024 * 1024,
            maxBufferSize: 256 * 1024 * 1024,
            maxStorageBuffersPerShaderStage: 8,
          },
          requestDevice: async () => ({
            destroy: () => { destroyed = true; },
            createShaderModule: () => ({
              getCompilationInfo: async () => {
                compiled += 1;
                return { messages: [] };
              },
            }),
          }),
        }),
      },
    },
  });
  try {
    await assert.rejects(
      WebGpuRoomRenderer.create(canvas(), { budget: SWARM_BUDGET.CHEAP }),
      (error: unknown) => {
        assert.ok(error instanceof WebGpuUnavailable);
        assert.match(error.message, /cannot hold a WebGPU context/);
        return true;
      },
    );
    assert.equal(destroyed, true, 'the device must not outlive the failed attempt');
    assert.equal(compiled, 2, 'both shaders are compiled before the canvas is committed to WebGPU');
  } finally {
    restore();
  }
});

/**
 * A shader that does not compile is a renderer that draws nothing. The driver
 * reports it through `getCompilationInfo`, not by throwing, so an
 * implementation that does not ask is an implementation that finds out when the
 * wall is black.
 */
void test('a shader the driver rejects is named, and the canvas is left usable', async () => {
  let askedForContext = false;
  const restore = overrideGlobals({
    navigator: {
      gpu: {
        requestAdapter: async () => ({
          limits: {
            maxComputeInvocationsPerWorkgroup: 256,
            maxComputeWorkgroupSizeX: 256,
            maxComputeWorkgroupsPerDimension: 65_535,
            maxStorageBufferBindingSize: 128 * 1024 * 1024,
            maxBufferSize: 256 * 1024 * 1024,
            maxStorageBuffersPerShaderStage: 8,
          },
          requestDevice: async () => ({
            destroy: () => {},
            createShaderModule: () => ({
              getCompilationInfo: async () => ({
                messages: [{ type: 'error', lineNum: 12, linePos: 3, message: 'unknown builtin' }],
              }),
            }),
          }),
        }),
      },
    },
  });
  const watched = {
    getContext: () => { askedForContext = true; return null; },
  } as unknown as HTMLCanvasElement;
  try {
    await assert.rejects(
      WebGpuRoomRenderer.create(watched, { budget: SWARM_BUDGET.CHEAP }),
      (error: unknown) => {
        assert.ok(error instanceof WebGpuUnavailable);
        assert.match(error.message, /did not compile/);
        assert.match(error.message, /12:3 unknown builtin/);
        return true;
      },
    );
    assert.equal(askedForContext, false, 'a canvas must not be spent on a renderer that cannot run');
  } finally {
    restore();
  }
});

void test('every refusal is something an operator could act on', async () => {
  const restore = overrideGlobals({ navigator: {} });
  try {
    await WebGpuRoomRenderer.create(canvas(), { budget: SWARM_BUDGET.CHEAP });
    assert.fail('should have refused');
  } catch (error) {
    assert.ok(error instanceof WebGpuUnavailable);
    assert.ok(error.message.length > 25 && /WebGPU/.test(error.message));
  } finally {
    restore();
  }
});

/**
 * A device the caller supplied is the caller's.
 *
 * The shell owns device acquisition — that is the division of labour the
 * architecture rests on — so a caller that already holds a device hands it
 * over rather than making the renderer find a second one. It is also what
 * makes two of the promotion gates checkable at all: a harness that owns the
 * device can destroy it to produce a real device loss, and can count what the
 * renderer allocates through it.
 *
 * The risk that comes with it is this one: a failed startup that destroyed a
 * borrowed device would take down a device the shell is still using for the
 * renderer it is rebuilding on, turning one refused backend into no renderer
 * at all.
 */
void test('a device the caller supplied outlives a startup that fails', async () => {
  let acquired = 0;
  let destroyed = false;
  const borrowed = {
    destroy: () => { destroyed = true; },
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
  };
  const restore = overrideGlobals({
    navigator: {
      gpu: {
        requestAdapter: async () => ({
          limits: {
            maxComputeInvocationsPerWorkgroup: 256,
            maxComputeWorkgroupSizeX: 256,
            maxComputeWorkgroupsPerDimension: 65_535,
            maxStorageBufferBindingSize: 128 * 1024 * 1024,
            maxBufferSize: 256 * 1024 * 1024,
            maxStorageBuffersPerShaderStage: 8,
          },
          // Never reached: the caller's device is used instead.
          requestDevice: async () => { acquired += 1; return borrowed; },
        }),
      },
    },
  });
  try {
    // The canvas double refuses a WebGPU context, which is the last thing
    // `create` tries and the point at which it gives a device back.
    await assert.rejects(
      WebGpuRoomRenderer.create(canvas(), {
        budget: SWARM_BUDGET.CHEAP,
        device: borrowed as unknown as GPUDevice,
      }),
      (error: unknown) => {
        assert.ok(error instanceof WebGpuUnavailable);
        return true;
      },
    );
    assert.equal(acquired, 0, 'a supplied device must be used, not supplemented');
    assert.equal(destroyed, false, 'a borrowed device must survive a failed startup');
  } finally {
    restore();
  }
});
