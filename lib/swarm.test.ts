import assert from 'node:assert/strict';
import test from 'node:test';
import { deltaE76, relativeLuminance } from './palette.ts';
import {
  bodyResponseSeconds,
  buildSwarmGradientLut,
  chroma,
  sampleSwarmGradient,
  SWARM_BUDGET,
  SWARM_DYNAMICS,
  SWARM_GRADIENT,
  SWARM_LUT_WIDTH,
  SWARM_MAX,
  RECALL_PRESENTATION,
  recallBody,
  type RecallKind,
  swarmParticleCount,
  swarmTextureSide,
} from './swarm.ts';
import type { HardwareProfile } from './room-types.ts';

const PROFILES: HardwareProfile[] = ['CHEAP', 'STANDARD', 'FULL'];

void test('every hardware profile packs into a square float texture with no waste', () => {
  for (const profile of PROFILES) {
    const budget = SWARM_BUDGET[profile];
    assert.ok(budget > 0 && budget <= SWARM_MAX, `${profile} budget ${budget} is out of range`);
    // A budget that is not already a perfect square power-of-two pair silently
    // simulates more particles than the profile promised.
    assert.equal(swarmParticleCount(budget), budget, `${profile} does not pack exactly`);
  }
});

void test('a richer profile runs more particles', () => {
  assert.ok(SWARM_BUDGET.CHEAP < SWARM_BUDGET.STANDARD);
  assert.ok(SWARM_BUDGET.STANDARD < SWARM_BUDGET.FULL);
});

void test('the texture side never rounds a profile up into a bigger one', () => {
  for (const count of [1, 100, 65_536, 147_456, 262_144]) {
    const side = swarmTextureSide(count);
    // Rounding up to a power of two would turn 147,456 into 262,144 and make
    // STANDARD cost exactly what FULL costs.
    assert.ok(side * side >= count, `${side}^2 cannot hold ${count}`);
    assert.ok((side - 1) ** 2 < count, `${side} overshoots ${count}`);
  }
  assert.equal(swarmParticleCount(999_999), swarmParticleCount(SWARM_MAX));
  assert.ok(swarmParticleCount(999_999) <= SWARM_MAX);
});

void test('the gradient is maximalist, not grey', () => {
  // This piece began as desaturated grey-green marks that a visitor could
  // barely see. This assertion is what stops it drifting back.
  const interior = SWARM_GRADIENT.filter((stop) => stop.at > 0 && stop.at < 1);
  for (const stop of interior) {
    assert.ok(
      chroma(stop.rgb) >= 45,
      `stop at ${stop.at} has chroma ${chroma(stop.rgb).toFixed(1)}, which is on its way back to grey`,
    );
  }
  assert.ok(interior.length >= 4, 'a full-gamut sweep needs more than a couple of hues');
});

void test('the gradient actually sweeps rather than restating one hue', () => {
  for (let index = 0; index < SWARM_GRADIENT.length - 1; index += 1) {
    const difference = deltaE76(SWARM_GRADIENT[index].rgb, SWARM_GRADIENT[index + 1].rgb);
    assert.ok(
      difference >= 25,
      `stops ${index} and ${index + 1} differ by only ΔE ${difference.toFixed(1)}`,
    );
  }
  assert.ok(deltaE76(SWARM_GRADIENT[0].rgb, SWARM_GRADIENT.at(-1)!.rgb) >= 60);
});

void test('an empty room still has a colour', () => {
  // 0 is what the piece wears whenever nobody is in the gallery, which is most
  // of its life. An earlier gradient ran hot-to-cold and put a near-white at 0,
  // so an empty room rendered as flat grey static — the exact failure the whole
  // colour effort exists to prevent.
  const empty = sampleSwarmGradient(0);
  assert.ok(
    chroma(empty) >= 25,
    `an empty room renders at chroma ${chroma(empty).toFixed(1)}, which is grey`,
  );
  // And it must be the dark end, not the bright one: an empty gallery is not
  // supposed to be the most luminous thing the piece ever does.
  const alive = sampleSwarmGradient(1);
  assert.ok(
    relativeLuminance(empty) < relativeLuminance(alive) * 0.25,
    'the empty room is brighter than a room with someone in it',
  );
});

void test('the gradient runs cold to hot, so presence reads as heat', () => {
  let previous = relativeLuminance(sampleSwarmGradient(0));
  let rises = 0;
  for (let step = 1; step <= 20; step += 1) {
    const next = relativeLuminance(sampleSwarmGradient(step / 20));
    if (next > previous) rises += 1;
    previous = next;
  }
  assert.ok(rises >= 15, 'brightness should broadly climb with how alive a place is');
});

void test('gradient stops are ordered and span the full range', () => {
  assert.equal(SWARM_GRADIENT[0].at, 0);
  assert.equal(SWARM_GRADIENT.at(-1)!.at, 1);
  for (let index = 0; index < SWARM_GRADIENT.length - 1; index += 1) {
    assert.ok(SWARM_GRADIENT[index].at < SWARM_GRADIENT[index + 1].at, 'stops must ascend');
  }
});

void test('sampling is continuous, clamped, and hits the declared stops', () => {
  for (const stop of SWARM_GRADIENT) {
    const sampled = sampleSwarmGradient(stop.at);
    assert.ok(deltaE76(sampled, stop.rgb) < 0.5, `stop at ${stop.at} is not reproduced`);
  }
  assert.deepEqual(sampleSwarmGradient(-5), sampleSwarmGradient(0));
  assert.deepEqual(sampleSwarmGradient(5), sampleSwarmGradient(1));
  assert.deepEqual(sampleSwarmGradient(Number.NaN), sampleSwarmGradient(0));
  // No discontinuity anywhere along the sweep.
  let previous = sampleSwarmGradient(0);
  for (let step = 1; step <= 256; step += 1) {
    const next = sampleSwarmGradient(step / 256);
    assert.ok(deltaE76(previous, next) < 12, `gradient jumps near t=${step / 256}`);
    previous = next;
  }
});

void test('the shader lookup table matches the gradient it is built from', () => {
  const lut = buildSwarmGradientLut();
  assert.equal(lut.length, SWARM_LUT_WIDTH * 4);
  for (const at of [0, 0.25, 0.5, 0.75, 1]) {
    const index = Math.round(at * (SWARM_LUT_WIDTH - 1));
    const fromLut: [number, number, number] = [lut[index * 4], lut[index * 4 + 1], lut[index * 4 + 2]];
    const expected = sampleSwarmGradient(index / (SWARM_LUT_WIDTH - 1));
    assert.ok(deltaE76(fromLut, expected) < 1, `lut disagrees with the gradient at ${at}`);
    assert.equal(lut[index * 4 + 3], 255);
  }
});

void test('a body displaces the field faster than a visitor can fail to notice', () => {
  // The whole failure of the previous renderer was that nobody could tell they
  // were causing anything. A response slower than roughly 100 ms reads as
  // ambient animation rather than as an answer.
  assert.ok(
    bodyResponseSeconds() < 0.1,
    `body response is ${(bodyResponseSeconds() * 1000).toFixed(0)} ms`,
  );
});

void test('swarm dynamics stay inside stable bounds', () => {
  const d = SWARM_DYNAMICS;
  assert.ok(d.damping > 0 && d.damping < 1, 'damping must bleed energy without freezing the field');
  assert.ok(d.bodyRadius > 0 && d.bodyRadius < 1);
  assert.ok(d.life > 1 && d.life < 60);
  assert.ok(d.ambientCurl > 0, 'an empty room must still move');
  assert.ok(d.bodyPush > d.memoryFlow, 'a living body must outrank the memory it is standing in');
  assert.ok(d.silhouettePull > 0, 'a visitor must be able to see their own outline');
  assert.ok(d.silhouettePull < d.bodyPush, 'the outline must not overpower the body that casts it');
});

const RECALL_KINDS: RecallKind[] = ['ghost', 'stillness', 'empty', 'return', 'convergence', 'false'];

const straightPath = Array.from({ length: 20 }, (_, index) => ({ x: index / 19, y: 0.5 }));

void test('every recall kind can walk the room', () => {
  for (const kind of RECALL_KINDS) {
    assert.ok(kind in RECALL_PRESENTATION, `${kind} has no presentation`);
    const body = recallBody(straightPath, kind, RECALL_PRESENTATION[kind].durationMs / 2, 1);
    assert.ok(body, `${kind} produced no body mid-crossing`);
  }
});

void test('a recall finishes inside a visitor\'s attention span', () => {
  for (const kind of RECALL_KINDS) {
    // Gallery dwell is on the order of a minute or two. A recall that outlasts
    // it is a recall nobody ever sees complete.
    assert.ok(
      RECALL_PRESENTATION[kind].durationMs <= 20_000,
      `${kind} takes ${RECALL_PRESENTATION[kind].durationMs}ms to cross`,
    );
    assert.ok(RECALL_PRESENTATION[kind].durationMs >= 5_000, `${kind} is too brief to read`);
  }
});

void test('a false memory is the only recall that runs cold', () => {
  const fabricated = RECALL_PRESENTATION.false.heat;
  for (const kind of RECALL_KINDS) {
    if (kind === 'false') continue;
    assert.ok(
      RECALL_PRESENTATION[kind].heat > fabricated * 1.5,
      `${kind} runs as cold as a fabricated memory, so nothing separates them`,
    );
  }
  // It still has to be visible. Cold, not absent.
  assert.ok(fabricated > 0.2);
  // And a genuine recall should be nearly as warm as a living body.
  assert.ok(RECALL_PRESENTATION.convergence.heat >= 0.9);
});

void test('a recall crosses the room and then stops existing', () => {
  const duration = RECALL_PRESENTATION.ghost.durationMs;
  assert.equal(recallBody(straightPath, 'ghost', -1, 1), null);
  assert.equal(recallBody(straightPath, 'ghost', duration, 1), null);
  assert.equal(recallBody(straightPath, 'ghost', duration * 2, 1), null);

  const early = recallBody(straightPath, 'ghost', duration * 0.1, 1)!;
  const late = recallBody(straightPath, 'ghost', duration * 0.7, 1)!;
  assert.ok(late.x > early.x, 'the recall should travel along its path');
  assert.ok(late.vx > 0, 'and its heading should follow the direction of travel');
});

void test('a recall swells and subsides rather than appearing outright', () => {
  const duration = RECALL_PRESENTATION.ghost.durationMs;
  const start = recallBody(straightPath, 'ghost', duration * 0.01, 1)!;
  const middle = recallBody(straightPath, 'ghost', duration * 0.5, 1)!;
  const end = recallBody(straightPath, 'ghost', duration * 0.99, 1)!;
  assert.ok(start.strength < 0.15, `it appears at strength ${start.strength.toFixed(2)}`);
  assert.ok(middle.strength > 0.9);
  assert.ok(end.strength < 0.15);
});

void test('a weak memory returns as a weak presence', () => {
  const duration = RECALL_PRESENTATION.ghost.durationMs;
  const strong = recallBody(straightPath, 'ghost', duration * 0.5, 1)!;
  const faint = recallBody(straightPath, 'ghost', duration * 0.5, 0.2)!;
  assert.ok(faint.strength < strong.strength * 0.35);
  assert.ok(faint.strength > 0);
});

void test('a path too short to walk produces nothing', () => {
  assert.equal(recallBody([], 'ghost', 100, 1), null);
  assert.equal(recallBody([{ x: 0.5, y: 0.5 }], 'ghost', 100, 1), null);
});

void test('a gradient with a repeated stop yields that stop, never a NaN colour', () => {
  // The shipped table has no repeated stop, so this guard is a claim about a
  // table someone might write later. A zero span divides to NaN, and a NaN
  // channel reaches the shader's lookup texture as a transparent black band —
  // an invisible seam in the ramp that no chroma or luminance floor would catch.
  const degenerate = [
    { at: 0, rgb: [16, 46, 104] },
    { at: 0, rgb: [255, 64, 150] },
    { at: 1, rgb: [255, 246, 220] },
  ] as const;
  const sampled = sampleSwarmGradient(0, degenerate);
  assert.ok(sampled.every(Number.isFinite), `degenerate stop produced ${sampled.join()}`);
  assert.deepEqual(sampled, [16, 46, 104], 'the earlier of the two stops wins');
  // Away from the repeat the table still interpolates normally.
  assert.deepEqual(sampleSwarmGradient(0.5, degenerate), [
    (255 + 255) / 2, (64 + 246) / 2, (150 + 220) / 2,
  ]);
  assert.deepEqual(sampleSwarmGradient(0), sampleSwarmGradient(0, SWARM_GRADIENT), 'the committed table stays the default');
});

void test('the shader lookup is the gradient, sampled end to end at full width', () => {
  // The GPU and the tests must not be able to disagree about what the piece
  // looks like, which is the whole reason the shader builds its ramp from this
  // table. A lookup that stops one sample short, or starts one in, shifts every
  // colour on the wall while every assertion about the table keeps passing.
  const lut = buildSwarmGradientLut();
  assert.equal(lut.length, SWARM_LUT_WIDTH * 4);
  const at = (index: number) => [lut[index * 4], lut[index * 4 + 1], lut[index * 4 + 2]];
  assert.deepEqual(at(0), SWARM_GRADIENT[0].rgb.map(Math.round), 'the first texel is the empty-room colour');
  assert.deepEqual(at(SWARM_LUT_WIDTH - 1), SWARM_GRADIENT.at(-1)!.rgb.map(Math.round), 'the last is a body standing there');
  for (let index = 0; index < SWARM_LUT_WIDTH; index += 1) {
    assert.deepEqual(at(index), sampleSwarmGradient(index / (SWARM_LUT_WIDTH - 1)).map(Math.round), `texel ${index}`);
    assert.equal(lut[index * 4 + 3], 255, `texel ${index} is not opaque`);
  }
  // Every stop must land somewhere in the texture, or a stop that exists only
  // in the table is a colour nobody ever sees.
  for (const stop of SWARM_GRADIENT) {
    const texel = at(Math.round(stop.at * (SWARM_LUT_WIDTH - 1)));
    assert.ok(
      texel.every((channel, axis) => Math.abs(channel - stop.rgb[axis]) <= 2),
      `stop at ${stop.at} is not in the lookup: ${texel.join()} against ${stop.rgb.join()}`,
    );
  }
});

void test('a recalled body walks its own path forwards, at the speed it is being re-walked', () => {
  const path = Array.from({ length: 21 }, (_, step) => ({ x: step / 20, y: 0.5 }));
  const duration = RECALL_PRESENTATION.ghost.durationMs;

  const early = recallBody(path, 'ghost', duration * 0.1, 1)!;
  const later = recallBody(path, 'ghost', duration * 0.4, 1)!;
  assert.ok(early && later);
  assert.ok(later.x > early.x, 'the body must move along the path, not back down it');
  assert.ok(early.vx > 0, 'and its velocity must point the way it is going');
  assert.equal(early.vy, 0, 'a straight path has no vertical velocity');

  // The velocity is derived from how fast the path is being re-walked, so a
  // recall that lasts twice as long must move half as fast over the same path.
  const slowKind = (Object.keys(RECALL_PRESENTATION) as Array<keyof typeof RECALL_PRESENTATION>)
    .find((kind) => RECALL_PRESENTATION[kind].durationMs > duration);
  if (slowKind) {
    const slow = recallBody(path, slowKind, RECALL_PRESENTATION[slowKind].durationMs * 0.1, 1)!;
    assert.ok(slow.vx < early.vx, `${slowKind} lasts longer and must move slower`);
  }

  // It starts and ends faint and is strongest in the middle: a recall that
  // appears at full strength is an event rather than a memory.
  const middle = recallBody(path, 'ghost', duration * 0.5, 1)!;
  assert.ok(middle.strength > early.strength);
  assert.ok(middle.strength > recallBody(path, 'ghost', duration * 0.95, 1)!.strength);
  assert.ok(recallBody(path, 'ghost', duration * 0.5, 0)!.strength === 0, 'a spent ghost has no presence');

  // Outside its own span there is no body at all, and a path with nothing to
  // walk is not a recall.
  assert.equal(recallBody(path, 'ghost', duration, 1), null, 'a finished recall is over');
  assert.equal(recallBody(path, 'ghost', -1, 1), null);
  assert.equal(recallBody(path, 'ghost', Number.NaN, 1), null);
  assert.equal(recallBody([{ x: 0, y: 0 }], 'ghost', 1, 1), null);
  assert.equal(recallBody([], 'ghost', 1, 1), null);
});
