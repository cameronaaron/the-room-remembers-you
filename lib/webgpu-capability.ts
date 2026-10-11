/**
 * What this GPU will actually let the room do.
 *
 * **Probed, never inferred from a name.** The hardware profile is already
 * detected rather than hardcoded, for the reason `ENGINEERING-STANDARDS.md`
 * records: a fixed guess is safe for an unknown computer and wrong for nearly
 * every machine this runs on. A device string is worse than a guess — it is a
 * guess that looks like evidence. Everything here reads declared limits.
 *
 * Pure, so it can be tested against invented limits. The adapter that supplies
 * them is the browser's business; what those numbers mean for the artwork is
 * this module's.
 */

/**
 * The limits this renderer actually depends on.
 *
 * A subset of `GPUSupportedLimits`, named so a test can construct one without
 * inventing the fifty limits the room does not read. Widening it is a visible
 * act, which is the point.
 */
export type WebGpuLimits = {
  maxComputeInvocationsPerWorkgroup: number;
  maxComputeWorkgroupSizeX: number;
  maxComputeWorkgroupsPerDimension: number;
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
  maxStorageBuffersPerShaderStage: number;
};

/**
 * Bytes per particle in the storage buffer.
 *
 * `vec2 position, vec2 velocity, f32 age, f32 life, f32 seed, f32 depth` — the
 * same eight floats the WebGL backend keeps in two RGBA32F textures, in one
 * buffer instead, because a compute shader can address a buffer directly and
 * does not need the state packed into something a fragment shader can sample.
 */
export const PARTICLE_BYTES = 32;

/** Storage buffers the pipelines bind: the particles, and the bodies. */
export const STORAGE_BUFFERS_NEEDED = 2;

/**
 * Preferred invocations per workgroup.
 *
 * 256 is the usual sweet spot on desktop GPUs and is within the guaranteed
 * minimum of `maxComputeInvocationsPerWorkgroup` (256), so it is a preference
 * this code can almost always have rather than an optimistic one. The real
 * value is still clamped to what the adapter declares.
 */
export const PREFERRED_WORKGROUP = 256;

/**
 * Smallest workgroup worth dispatching.
 *
 * Below this the dispatch overhead dominates and the adapter is almost
 * certainly a software fallback, which is a machine that should be running the
 * line renderer rather than a particle field.
 */
export const MIN_WORKGROUP = 32;

/**
 * Fewest particles worth building a compute pipeline for.
 *
 * Under a quarter of the CHEAP budget the field reads as scattered dots rather
 * than as a swarm, and the artwork is better served by WebGL or by traces than
 * by a technically-working WebGPU path nobody would choose to look at.
 */
export const MIN_PARTICLES = 16_384;

export type WebGpuAssessment =
  | {
    usable: true;
    /** Particles to simulate: a multiple of `workgroupSize`. */
    particleCount: number;
    workgroupSize: number;
    /** Bytes of GPU memory the particle buffer will occupy. */
    particleBytes: number;
    /** Why this is less than was asked for, when it is. Empty when it is not. */
    limitedBy: string[];
  }
  | { usable: false; reason: string };

/**
 * Decide what WebGPU can run here, given a requested particle budget.
 *
 * Returns a refusal with a sentence an operator can act on rather than a
 * boolean. "WebGPU unavailable" in a console at 9am in a gallery is the same
 * information as no console at all.
 */
export function assessWebGpu(limits: WebGpuLimits, requested: number): WebGpuAssessment {
  if (!Number.isFinite(requested) || requested < 1) {
    return { usable: false, reason: 'the requested particle budget is not a number' };
  }
  if (limits.maxStorageBuffersPerShaderStage < STORAGE_BUFFERS_NEEDED) {
    return {
      usable: false,
      reason: `this adapter binds ${limits.maxStorageBuffersPerShaderStage} storage buffer(s) per stage and the field needs ${STORAGE_BUFFERS_NEEDED}`,
    };
  }
  const workgroupSize = Math.min(
    PREFERRED_WORKGROUP,
    limits.maxComputeInvocationsPerWorkgroup,
    limits.maxComputeWorkgroupSizeX,
  );
  if (!Number.isFinite(workgroupSize) || workgroupSize < MIN_WORKGROUP) {
    return {
      usable: false,
      reason: `this adapter allows ${workgroupSize} invocations per workgroup, below the ${MIN_WORKGROUP} the field needs`,
    };
  }

  const limitedBy: string[] = [];
  let count = Math.floor(requested);

  const byBuffer = Math.floor(
    Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize) / PARTICLE_BYTES,
  );
  if (byBuffer < count) {
    count = byBuffer;
    limitedBy.push(`storage buffer size (${PARTICLE_BYTES} bytes a particle)`);
  }

  const byDispatch = limits.maxComputeWorkgroupsPerDimension * workgroupSize;
  if (byDispatch < count) {
    count = byDispatch;
    limitedBy.push(`workgroups per dispatch (${limits.maxComputeWorkgroupsPerDimension})`);
  }

  // Down to a whole number of workgroups. Rounding up would dispatch
  // invocations that immediately return, which is harmless and dishonest: the
  // console would report a particle count the field does not contain.
  count = Math.floor(count / workgroupSize) * workgroupSize;

  if (count < MIN_PARTICLES) {
    return {
      usable: false,
      reason: `this adapter can only carry ${count} particles, below the ${MIN_PARTICLES} worth rendering`,
    };
  }
  return {
    usable: true,
    particleCount: count,
    workgroupSize,
    particleBytes: count * PARTICLE_BYTES,
    limitedBy,
  };
}

/** Workgroups to dispatch for a count this assessment produced. */
export function dispatchCount(particleCount: number, workgroupSize: number): number {
  return Math.ceil(particleCount / workgroupSize);
}
