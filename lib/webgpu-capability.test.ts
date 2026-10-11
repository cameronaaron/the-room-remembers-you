import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIN_PARTICLES,
  MIN_WORKGROUP,
  PARTICLE_BYTES,
  PREFERRED_WORKGROUP,
  assessWebGpu,
  dispatchCount,
  type WebGpuLimits,
} from './webgpu-capability.ts';
import { SWARM_BUDGET } from './swarm.ts';

/**
 * The WebGPU specification's guaranteed minimums. A machine that only meets
 * these is the floor the room has to work on, so it is the case worth naming.
 */
const GUARANTEED: WebGpuLimits = {
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupsPerDimension: 65_535,
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxBufferSize: 256 * 1024 * 1024,
  maxStorageBuffersPerShaderStage: 8,
};

/** What this machine's Chrome actually reported, for a case that is not invented. */
const MEASURED: WebGpuLimits = {
  maxComputeInvocationsPerWorkgroup: 1024,
  maxComputeWorkgroupSizeX: 1024,
  maxComputeWorkgroupsPerDimension: 65_535,
  maxStorageBufferBindingSize: 4_294_967_292,
  maxBufferSize: 4_294_967_292,
  maxStorageBuffersPerShaderStage: 10,
};

void test('every shipped profile fits inside the specification floor', () => {
  for (const [profile, budget] of Object.entries(SWARM_BUDGET)) {
    const assessment = assessWebGpu(GUARANTEED, budget);
    assert.ok(assessment.usable, `${profile} should run on a minimum-spec adapter`);
    if (!assessment.usable) return;
    assert.equal(assessment.limitedBy.length, 0, `${profile} should not be trimmed: ${assessment.limitedBy.join(', ')}`);
    assert.ok(assessment.particleCount <= budget);
    assert.ok(budget - assessment.particleCount < assessment.workgroupSize,
      'and should lose at most a partial workgroup to rounding');
  }
});

void test('the workgroup is the preferred size where the adapter allows it', () => {
  const assessment = assessWebGpu(MEASURED, SWARM_BUDGET.FULL);
  assert.ok(assessment.usable);
  if (!assessment.usable) return;
  assert.equal(assessment.workgroupSize, PREFERRED_WORKGROUP,
    'a larger cap is not a reason to dispatch larger workgroups');
  assert.equal(assessment.particleCount % assessment.workgroupSize, 0,
    'the population is a whole number of workgroups');
  assert.equal(assessment.particleBytes, assessment.particleCount * PARTICLE_BYTES);
});

/**
 * A count rounded *up* would dispatch invocations that immediately return. That
 * is harmless on the GPU and dishonest in the console, which would then report a
 * particle count the field does not contain.
 */
void test('the population is rounded down to whole workgroups, never up', () => {
  const assessment = assessWebGpu({ ...GUARANTEED, maxComputeInvocationsPerWorkgroup: 64, maxComputeWorkgroupSizeX: 64 }, 100_001);
  assert.ok(assessment.usable);
  if (!assessment.usable) return;
  assert.equal(assessment.workgroupSize, 64);
  assert.equal(assessment.particleCount, 99_968);
  assert.ok(assessment.particleCount < 100_001);
});

void test('a small storage buffer trims the population and names what trimmed it', () => {
  const assessment = assessWebGpu(
    { ...GUARANTEED, maxStorageBufferBindingSize: 4 * 1024 * 1024 },
    SWARM_BUDGET.FULL,
  );
  assert.ok(assessment.usable);
  if (!assessment.usable) return;
  assert.ok(assessment.particleCount < SWARM_BUDGET.FULL);
  assert.ok(assessment.particleBytes <= 4 * 1024 * 1024);
  assert.deepEqual(assessment.limitedBy, ['storage buffer size (32 bytes a particle)']);
});

void test('a dispatch ceiling trims the population too', () => {
  const assessment = assessWebGpu({ ...GUARANTEED, maxComputeWorkgroupsPerDimension: 300 }, SWARM_BUDGET.FULL);
  assert.ok(assessment.usable);
  if (!assessment.usable) return;
  assert.equal(assessment.particleCount, 300 * 256);
  assert.match(assessment.limitedBy.join(), /workgroups per dispatch/);
});

/**
 * "WebGPU unavailable" in a console at 9am in a gallery is the same information
 * as no console at all.
 */
void test('a refusal names the limit that caused it, with its number', () => {
  const tooSmallWorkgroup = assessWebGpu(
    { ...GUARANTEED, maxComputeInvocationsPerWorkgroup: 16, maxComputeWorkgroupSizeX: 16 },
    SWARM_BUDGET.CHEAP,
  );
  assert.equal(tooSmallWorkgroup.usable, false);
  if (tooSmallWorkgroup.usable) return;
  assert.match(tooSmallWorkgroup.reason, /16/);
  assert.match(tooSmallWorkgroup.reason, new RegExp(String(MIN_WORKGROUP)));

  const tooFewBuffers = assessWebGpu({ ...GUARANTEED, maxStorageBuffersPerShaderStage: 1 }, SWARM_BUDGET.CHEAP);
  assert.equal(tooFewBuffers.usable, false);
  if (tooFewBuffers.usable) return;
  assert.match(tooFewBuffers.reason, /storage buffer/);

  const tooSmallBuffer = assessWebGpu({ ...GUARANTEED, maxStorageBufferBindingSize: 64 * 1024 }, SWARM_BUDGET.CHEAP);
  assert.equal(tooSmallBuffer.usable, false);
  if (tooSmallBuffer.usable) return;
  assert.match(tooSmallBuffer.reason, new RegExp(String(MIN_PARTICLES)));

  const nonsense = assessWebGpu(GUARANTEED, Number.NaN);
  assert.equal(nonsense.usable, false);
});

void test('a dispatch covers the whole population and never overshoots by a workgroup', () => {
  for (const [count, size] of [[100_000, 256], [256, 256], [257, 256], [1, 64]] as const) {
    const groups = dispatchCount(count, size);
    assert.ok(groups * size >= count, `${count}/${size} must cover the population`);
    assert.ok((groups - 1) * size < count, `${count}/${size} dispatches a wasted workgroup`);
  }
});
