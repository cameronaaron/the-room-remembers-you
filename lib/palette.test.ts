import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cielab,
  composite,
  srgbToLinear,
  deltaE76,
  EVENT_MARKS,
  groundLightCost,
  type MarkName,
  PALETTES,
  paletteFor,
  projectedWeberContrast,
  markStyle,
  markStyleAt,
  relativeLuminance,
  rgbCss,
  accumulatedEquilibrium,
  depositPerFrame,
  PERSONALITY_RENDER,
  type Rgb,
  retentionPerFrame,
} from './palette.ts';
import type { RoomPersonality } from './room-types.ts';

/**
 * A mark must clear this against its ground. A just-noticeable difference is
 * about 1; the margin covers projector gamma, lamp ageing, and gallery ambient.
 */
const LEGIBILITY_FLOOR = 12;

/**
 * Two recall events must clear this against each other. Visitors are given no
 * labels, so events that fall below this are the same event as far as the
 * artwork is concerned.
 */
const DISCRIMINABILITY_FLOOR = 12;

const MODES = ['room', 'paper'] as const;

for (const mode of MODES) {
  const palette = paletteFor(mode);
  const markNames = Object.keys(palette.marks) as MarkName[];

  void test(`${mode}: every mark clears the legibility floor against its ground`, () => {
    for (const name of markNames) {
      const resolved = composite(palette.ground, palette.marks[name]);
      const difference = deltaE76(palette.ground, resolved);
      assert.ok(
        difference >= LEGIBILITY_FLOOR,
        `${mode}/${name} resolves to ΔE ${difference.toFixed(2)}, below the ${LEGIBILITY_FLOOR} floor`,
      );
    }
  });

  void test(`${mode}: the six recall events stay mutually discriminable`, () => {
    const resolved = new Map<MarkName, Rgb>(
      EVENT_MARKS.map((name) => [name, composite(palette.ground, palette.marks[name])]),
    );
    for (let i = 0; i < EVENT_MARKS.length; i += 1) {
      for (let j = i + 1; j < EVENT_MARKS.length; j += 1) {
        const a = EVENT_MARKS[i];
        const b = EVENT_MARKS[j];
        const difference = deltaE76(resolved.get(a)!, resolved.get(b)!);
        assert.ok(
          difference >= DISCRIMINABILITY_FLOOR,
          `${mode}: ${a} vs ${b} is ΔE ${difference.toFixed(2)}, below the ${DISCRIMINABILITY_FLOOR} floor`,
        );
      }
    }
  });

  void test(`${mode}: a faded mark degrades toward the ground rather than inverting`, () => {
    for (const name of markNames) {
      const full = deltaE76(palette.ground, composite(palette.ground, palette.marks[name], 1));
      const faded = deltaE76(palette.ground, composite(palette.ground, palette.marks[name], 0.25));
      assert.ok(faded < full, `${mode}/${name} does not fade toward its ground`);
      assert.ok(faded > 0, `${mode}/${name} disappears entirely at quarter strength`);
    }
  });
}

void test('the default palette keeps the projector nearly dark', () => {
  // The camera has to reject the installation's own light. The additive ground
  // emits essentially nothing, so there is almost nothing to reject.
  assert.ok(groundLightCost(PALETTES.room) <= 0.01);
  // Recorded for contrast: the paper ground demands most of the projector's
  // output as a constant full-field flood.
  assert.ok(groundLightCost(PALETTES.paper) > 0.8);
});

void test('both palettes stay legible under gallery ambient', () => {
  // A lit white-box gallery: ambient wall luminance is a quarter of the
  // projector's full-white output.
  const galleryAmbient = 0.25;
  const legible = 0.25; // Weber contrast a visitor reads as a definite mark.

  for (const mode of MODES) {
    const palette = paletteFor(mode);
    const ground = relativeLuminance(palette.ground);
    for (const name of EVENT_MARKS) {
      const mark = relativeLuminance(composite(palette.ground, palette.marks[name]));
      const contrast = projectedWeberContrast(ground, mark, galleryAmbient);
      assert.ok(
        contrast >= legible,
        `${mode}/${name} is only ${(contrast * 100).toFixed(1)}% contrast under gallery ambient`,
      );
    }
  }
});

void test('the additive palette buys that legibility with far less projected light', () => {
  // Measured, not assumed: subtractive marks are perfectly legible once the
  // inks are strong enough. What separates the two modes is the standing cost
  // of the ground. `paper` floods the wall continuously; `room` emits light
  // only where the room remembers something. That flood is what the camera
  // then has to reject, so this is a sensor-stability property as much as an
  // aesthetic one, and it is why `room` is the default.
  const additive = groundLightCost(PALETTES.room);
  const subtractive = groundLightCost(PALETTES.paper);
  assert.ok(additive <= 0.01);
  assert.ok(subtractive > 0.8);
  assert.ok(subtractive / Math.max(additive, 1e-6) > 80);
});

void test('an unknown projection mode falls back to the additive palette', () => {
  assert.equal(paletteFor('nonsense' as never).mode, 'room');
});

const ALL_PERSONALITIES: RoomPersonality[] = [
  'dormant',
  'curious',
  'attentive',
  'crowded',
  'overwhelmed',
  'lonely',
  'remembering',
  'forgetting',
];

void test('every room personality has a projected body', () => {
  for (const personality of ALL_PERSONALITIES) {
    assert.ok(
      personality in PERSONALITY_RENDER,
      `${personality} is decided by the world model but never reaches the wall`,
    );
  }
  assert.equal(Object.keys(PERSONALITY_RENDER).length, ALL_PERSONALITIES.length);
});

void test('no two personalities project the same image', () => {
  const seen = new Map<string, RoomPersonality>();
  for (const personality of ALL_PERSONALITIES) {
    const render = PERSONALITY_RENDER[personality];
    const signature = [render.retention, render.presence, render.drift, render.unrest].join('/');
    const clash = seen.get(signature);
    assert.equal(clash, undefined, `${personality} is indistinguishable from ${clash}`);
    seen.set(signature, personality);
  }
});

void test('personality render values stay inside their bounds', () => {
  for (const personality of ALL_PERSONALITIES) {
    const { retention, presence, drift, unrest } = PERSONALITY_RENDER[personality];
    assert.ok(retention > 0 && retention < 1, `${personality} retention must forget eventually`);
    assert.ok(presence > 0 && presence <= 1.5);
    assert.ok(drift >= 0 && drift <= 2);
    assert.ok(unrest >= 0 && unrest <= 1);
  }
});

void test('an overwhelmed room forgets faster than a remembering one', () => {
  assert.ok(PERSONALITY_RENDER.overwhelmed.retention < PERSONALITY_RENDER.attentive.retention);
  assert.ok(PERSONALITY_RENDER.attentive.retention < PERSONALITY_RENDER.remembering.retention);
  assert.ok(PERSONALITY_RENDER.forgetting.retention < PERSONALITY_RENDER.dormant.retention);
});

void test('accumulated light decays at the same rate regardless of frame rate', () => {
  const retention = PERSONALITY_RENDER.attentive.retention;
  const oneSecondAt24 = retentionPerFrame(retention, 1 / 24) ** 24;
  const oneSecondAt120 = retentionPerFrame(retention, 1 / 120) ** 120;
  assert.ok(Math.abs(oneSecondAt24 - retention) < 1e-6);
  assert.ok(Math.abs(oneSecondAt120 - retention) < 1e-6);
});

void test('retention survives a stalled frame without erasing the image', () => {
  // A long GC pause must not blank the wall.
  assert.ok(retentionPerFrame(PERSONALITY_RENDER.overwhelmed.retention, 10) > 0);
});

/** Simulate the accumulation buffer directly, the way the renderer drives it. */
function settle(retentionPerSecond: number, fps: number, depositAlpha: (retentionFrame: number) => number) {
  const dt = 1 / fps;
  const retentionFrame = retentionPerFrame(retentionPerSecond, dt);
  let value = 0;
  for (let frame = 0; frame < fps * 20; frame += 1) {
    value = Math.min(1, value * retentionFrame + depositAlpha(retentionFrame));
  }
  return value;
}

void test('a continuously drawn mark settles on its declared alpha, not on white', () => {
  // The first build of the accumulating renderer deposited each mark's full
  // single-pass alpha every frame. The buffer integrated it to white within a
  // second and the six recall hues became one flat glare.
  const seconds = 20;
  for (const personality of ALL_PERSONALITIES) {
    const retention = PERSONALITY_RENDER[personality].retention;
    for (const fps of [24, 60, 144]) {
      const settled = settle(retention, fps, (frame) => depositPerFrame(frame));
      // Closed form: depositing (1 - r) per frame into a buffer keeping r
      // leaves 1 - r^n after n frames, so the mark approaches its declared
      // alpha from below and never passes it.
      const expected = 1 - retention ** seconds;
      assert.ok(
        settled < 1,
        `${personality} at ${fps}fps saturated at ${settled.toFixed(4)}`,
      );
      assert.ok(
        Math.abs(settled - expected) < 0.005,
        `${personality} at ${fps}fps settles at ${settled.toFixed(4)}, expected ${expected.toFixed(4)}`,
      );
    }
  }
});

void test('the equilibrium is independent of frame rate', () => {
  const retention = PERSONALITY_RENDER.attentive.retention;
  const at24 = settle(retention, 24, (frame) => depositPerFrame(frame));
  const at144 = settle(retention, 144, (frame) => depositPerFrame(frame));
  assert.ok(at24 > 0.9 && at144 > 0.9, 'the mark should have essentially arrived after 20s');
  assert.ok(Math.abs(at24 - at144) < 0.01, `${at24.toFixed(4)} vs ${at144.toFixed(4)}`);
});

void test('depositing a full single-pass alpha every frame would still saturate', () => {
  // Kept as the record of why depositPerFrame exists: without it, any mark
  // drawn continuously blows out regardless of how the palette is tuned.
  const naive = settle(PERSONALITY_RENDER.attentive.retention, 60, () => 0.4);
  assert.equal(naive, 1);
  assert.ok(accumulatedEquilibrium(0.4, retentionPerFrame(0.62, 1 / 60)) >= 1);
});

void test('a mark renders as the colour it declares, at the alpha it declares', () => {
  // Every trace on the wall goes through these two functions. A mistake here is
  // invisible in the palette tests, which measure the declared colours, and
  // plainly visible on the projection.
  const mark = PALETTES.room.marks.ghostRecall;
  const style = markStyle(mark);
  assert.equal(style, `rgba(${mark.rgb[0]}, ${mark.rgb[1]}, ${mark.rgb[2]}, ${mark.alpha})`);
  assert.match(markStyle(mark, 0.5), /^rgba\(\d+, \d+, \d+, [\d.]+\)$/);
});

void test('scaling a mark never drives its alpha outside a legal colour', () => {
  const mark = PALETTES.room.marks.falseMemory;
  for (const scale of [-3, 0, 0.5, 1, 40]) {
    const alpha = Number(markStyle(mark, scale).split(', ').at(-1)!.replace(')', ''));
    assert.ok(alpha >= 0 && alpha <= 1, `scale ${scale} produced alpha ${alpha}`);
  }
  // An explicit alpha ignores the mark's own single-pass value, and is clamped
  // the same way — a recall fading out passes values through here every frame.
  assert.equal(markStyleAt(mark, 2), `rgba(${mark.rgb[0]}, ${mark.rgb[1]}, ${mark.rgb[2]}, 1)`);
  assert.equal(markStyleAt(mark, -1), `rgba(${mark.rgb[0]}, ${mark.rgb[1]}, ${mark.rgb[2]}, 0)`);
});

void test('alpha is rounded rather than emitted at full float precision', () => {
  // These strings are rebuilt for every mark on every frame; an unrounded one
  // is a long allocation sixty times a second for no visible difference.
  const mark = PALETTES.room.marks.ghostRecall;
  const alpha = markStyleAt(mark, 1 / 3).split(', ').at(-1)!.replace(')', '');
  assert.ok(alpha.length <= 6, `alpha rendered as ${alpha}`);
  assert.ok(Math.abs(Number(alpha) - 1 / 3) < 1e-3);
});

void test('a ground renders as an opaque colour', () => {
  for (const mode of ['room', 'paper'] as const) {
    const css = rgbCss(PALETTES[mode].ground);
    assert.match(css, /^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/);
  }
});

void test('a buffer that loses nothing settles at full brightness rather than dividing by zero', () => {
  // retentionFrame 1 is a buffer that keeps every frame forever. The steady
  // state is saturation, and it has to be reported as saturation: an infinity
  // or a NaN here reads as "no equilibrium found" and would let the accumulation
  // floors above pass on a buffer that clips to white within a second.
  assert.equal(accumulatedEquilibrium(0.001, 1), 1);
  assert.equal(accumulatedEquilibrium(0, 1), 1);
  assert.equal(depositPerFrame(1), 0, 'and nothing more may be deposited into it');
  assert.equal(depositPerFrame(1.4), 0, 'a retention above one cannot deposit negative light');
  assert.equal(depositPerFrame(-0.2), 1, 'nor may a negative retention deposit more than full scale');
});

void test('every mark composites the way its surface does, and nothing composites both ways', () => {
  // This is the polarity of the whole work in one field. In a dark room the
  // projector can only add light, so a mark that composited `source-over`
  // would paint the room's own black over whatever was already on the wall and
  // erase it; on a lit surface the ink can only take light away, and a
  // `lighter` mark there brightens a ground that is already near white and
  // disappears. Both render, both look plausible in a screenshot, and the
  // measured contrast floors above cannot tell the difference because they
  // read the declared colour rather than what reaches the wall.
  for (const [name, mark] of Object.entries(PALETTES.room.marks)) {
    assert.equal(mark.composite, 'lighter', `${name} does not add light in a dark room`);
  }
  for (const [name, mark] of Object.entries(PALETTES.paper.marks)) {
    assert.equal(mark.composite, 'source-over', `${name} adds light to a lit surface`);
  }

  // And the compositor must actually do the two different things.
  const ground: Rgb = [10, 10, 10];
  const added = composite(ground, { rgb: [200, 200, 200], alpha: 0.5, composite: 'lighter' });
  assert.ok(added.every((channel) => channel > ground[0]), 'an additive mark must raise every channel');
  const over = composite([250, 250, 250], { rgb: [20, 20, 20], alpha: 0.5, composite: 'source-over' });
  assert.ok(over.every((channel) => channel < 250), 'a subtractive mark must lower every channel');
  // A full-alpha subtractive mark replaces the ground outright; an additive one
  // saturates rather than wrapping around.
  assert.deepEqual(composite([250, 250, 250], { rgb: [0, 0, 0], alpha: 1, composite: 'source-over' }), [0, 0, 0]);
  assert.deepEqual(composite([250, 250, 250], { rgb: [255, 255, 255], alpha: 1, composite: 'lighter' }), [255, 255, 255]);
});

void test('the colour space conversion is checked against published values, not against itself', () => {
  // Every contrast and separation floor in this file is computed through these
  // two functions, so a wrong coefficient moves every measurement together and
  // the floors go on passing. Reference values from the sRGB and CIE
  // definitions, D65 white, rounded to two decimals.
  const near = (actual: number, expected: number, tolerance: number, what: string) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual.toFixed(3)} vs ${expected}`);

  // Takes an 8-bit channel and returns linear light.
  assert.equal(srgbToLinear(0), 0);
  assert.equal(srgbToLinear(255), 1);
  near(srgbToLinear(128), 0.2158, 0.0005, 'mid grey is a fifth of the light, not half');
  // The piecewise join must be continuous, or a dark mark's luminance steps
  // where nothing in the physics does.
  const joinAt = 0.04045 * 255;
  near(srgbToLinear(joinAt), 0.04045 / 12.92, 1e-9, 'the piecewise join');
  near(srgbToLinear(joinAt + 1e-6), 0.04045 / 12.92, 1e-5, 'and is continuous across it');

  const white = cielab([255, 255, 255]);
  near(white[0], 100, 0.05, 'white L*');
  near(white[1], 0, 0.05, 'white a*');
  near(white[2], 0, 0.05, 'white b*');
  const black = cielab([0, 0, 0]);
  assert.deepEqual(black.map((value) => Math.round(value)), [0, 0, 0]);
  const red = cielab([255, 0, 0]);
  near(red[0], 53.24, 0.05, 'red L*');
  near(red[1], 80.09, 0.1, 'red a*');
  near(red[2], 67.20, 0.1, 'red b*');
  const green = cielab([0, 255, 0]);
  near(green[0], 87.73, 0.05, 'green L*');
  near(green[1], -86.18, 0.1, 'green a*');
  const blue = cielab([0, 0, 255]);
  near(blue[0], 32.30, 0.05, 'blue L*');
  near(blue[2], -107.86, 0.1, 'blue b*');
  // Mid grey sits on the neutral axis: any error in the matrix rows relative to
  // each other shows up here as chroma where there is none.
  const grey = cielab([128, 128, 128]);
  near(grey[1], 0, 0.05, 'grey a*');
  near(grey[2], 0, 0.05, 'grey b*');
  near(relativeLuminance([255, 255, 255]), 1, 0.001, 'white luminance');
  near(relativeLuminance([0, 0, 0]), 0, 1e-9, 'black luminance');
  // The green coefficient dominates: the same value in green is far brighter
  // than in blue, which is why a cyan stop could clear a chroma floor and still
  // put a brightness spike early in the ramp.
  assert.ok(relativeLuminance([0, 255, 0]) > 5 * relativeLuminance([0, 0, 255]));

  // A known pair, so deltaE76 is anchored too rather than only compared to
  // itself: black to white is exactly 100 in L* and nothing else.
  near(deltaE76([0, 0, 0], [255, 255, 255]), 100, 0.05, 'black to white');
  assert.equal(deltaE76([12, 34, 56], [12, 34, 56]), 0);
});

void test('ambient light dilutes contrast, and the ratio is taken against the darker side', () => {
  // Weber contrast against the darker of the two is what makes this comparable
  // between an additive mark on near-black and a subtractive one on near-white.
  assert.equal(projectedWeberContrast(0, 0, 0.01), 0, 'a mark the colour of its ground has no contrast');
  const dark = projectedWeberContrast(0.004, 0.4, 0.01);
  const lit = projectedWeberContrast(0.004, 0.4, 0.2);
  assert.ok(lit < dark, 'gallery ambient must dilute a projected mark, never sharpen it');
  // Symmetric: a mark darker than its ground is as legible as one lighter by
  // the same amount against the same darker reference.
  assert.equal(projectedWeberContrast(0.4, 0.004, 0.01), dark);
  assert.ok(Number.isFinite(projectedWeberContrast(0, 0, 0)), 'a black room in the dark is not a division by zero');
});
