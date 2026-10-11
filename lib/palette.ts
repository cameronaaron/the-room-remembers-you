/**
 * Projected colour for the installation.
 *
 * A projector can only add light. It cannot subtract it. The visible mark on
 * the wall is therefore `ambient + projected`, and every design decision below
 * follows from that one fact:
 *
 *  - `room` (default) paints a black ground and adds luminous marks. The
 *    projector emits light only where the room remembers something, so the
 *    rectangle of the projector itself disappears and the marks float on the
 *    wall. Mark contrast is `emitted / ambient`, which stays high in a lit
 *    gallery and costs very little light.
 *  - `paper` paints a bright ground and darkens marks out of it. This is
 *    reproducible on a projector only by flooding the wall and letting the
 *    "ink" fall back to the ambient value, so contrast is bounded by
 *    `projected_delta / (ambient + projected_field)` and collapses as room
 *    light rises. It is kept for LCD/scrim installs and is not the default.
 *
 * Both palettes are held to the same measured legibility floors by
 * `palette.test.ts`. Colours are declared here and nowhere else so the floors
 * cannot be bypassed by a literal in a draw call.
 */

export type Rgb = readonly [number, number, number];
export type MarkComposite = 'lighter' | 'source-over';
export type ProjectionMode = 'room' | 'paper';

export type Mark = {
  /** Colour at full strength, before `alpha`. */
  readonly rgb: Rgb;
  /** Fraction of `rgb` that reaches the wall for a single pass. */
  readonly alpha: number;
  readonly composite: MarkComposite;
};

/** Every distinct thing the installation can put on the wall. */
export type MarkName =
  | 'presentBody'
  | 'presentPath'
  | 'recentTrail'
  | 'memoryField'
  | 'ghostRecall'
  | 'emptyGhost'
  | 'stillnessRecall'
  | 'returnEcho'
  | 'convergence'
  | 'falseMemory'
  | 'closingMontage'
  | 'ambientDrift'
  | 'calibration';

export type Palette = {
  readonly mode: ProjectionMode;
  readonly ground: Rgb;
  readonly marks: Readonly<Record<MarkName, Mark>>;
};

/**
 * The six recall events the world model distinguishes. Visitors are never told
 * these names, so the only way the distinction can exist for them is chromatic:
 * these six must be mutually discriminable on the wall.
 */
export const EVENT_MARKS = [
  'ghostRecall',
  'emptyGhost',
  'stillnessRecall',
  'returnEcho',
  'convergence',
  'falseMemory',
] as const satisfies readonly MarkName[];

/**
 * Additive palette. Hue carries the meaning, because at low light level hue
 * separates far more reliably than luminance does.
 *
 *  present  warm white   — the living are the brightest thing in the room
 *  recent   cool green   — minutes old, already cooling
 *  field    deep teal    — the slow wash the room has accumulated
 *  recall   phosphor     — something the room chose to replay
 *  converge amber gold   — rarest and warmest: you walked someone else's path
 *  false    magenta      — chromatically wrong on purpose; a visitor should
 *                          feel the untrustworthiness without being told
 */
const ROOM_PALETTE: Palette = {
  mode: 'room',
  ground: [0, 0, 0],
  marks: {
    presentBody: { rgb: [255, 238, 214], alpha: 0.5, composite: 'lighter' },
    presentPath: { rgb: [255, 222, 170], alpha: 0.4, composite: 'lighter' },
    recentTrail: { rgb: [140, 214, 198], alpha: 0.22, composite: 'lighter' },
    memoryField: { rgb: [46, 104, 124], alpha: 0.62, composite: 'lighter' },
    ghostRecall: { rgb: [126, 226, 206], alpha: 0.44, composite: 'lighter' },
    emptyGhost: { rgb: [110, 182, 228], alpha: 0.5, composite: 'lighter' },
    stillnessRecall: { rgb: [176, 172, 240], alpha: 0.46, composite: 'lighter' },
    returnEcho: { rgb: [206, 234, 150], alpha: 0.46, composite: 'lighter' },
    convergence: { rgb: [255, 204, 120], alpha: 0.66, composite: 'lighter' },
    falseMemory: { rgb: [230, 120, 198], alpha: 0.5, composite: 'lighter' },
    closingMontage: { rgb: [128, 184, 212], alpha: 0.34, composite: 'lighter' },
    ambientDrift: { rgb: [96, 156, 176], alpha: 0.26, composite: 'lighter' },
    calibration: { rgb: [255, 255, 255], alpha: 0.9, composite: 'lighter' },
  },
};

/**
 * Subtractive palette for LCD panels and bright-projector-onto-paper installs.
 * The inks are far stronger than a screen design would need, because the same
 * legibility floor applies here and a projector compresses this direction hard.
 */
const PAPER_PALETTE: Palette = {
  mode: 'paper',
  ground: [238, 237, 232],
  marks: {
    presentBody: { rgb: [58, 66, 62], alpha: 0.5, composite: 'source-over' },
    presentPath: { rgb: [44, 52, 49], alpha: 0.55, composite: 'source-over' },
    recentTrail: { rgb: [66, 96, 88], alpha: 0.4, composite: 'source-over' },
    memoryField: { rgb: [92, 112, 108], alpha: 0.62, composite: 'source-over' },
    ghostRecall: { rgb: [38, 96, 86], alpha: 0.55, composite: 'source-over' },
    emptyGhost: { rgb: [24, 80, 124], alpha: 0.55, composite: 'source-over' },
    stillnessRecall: { rgb: [104, 58, 138], alpha: 0.55, composite: 'source-over' },
    returnEcho: { rgb: [92, 108, 34], alpha: 0.55, composite: 'source-over' },
    convergence: { rgb: [150, 96, 16], alpha: 0.66, composite: 'source-over' },
    falseMemory: { rgb: [140, 40, 110], alpha: 0.6, composite: 'source-over' },
    closingMontage: { rgb: [58, 78, 94], alpha: 0.42, composite: 'source-over' },
    ambientDrift: { rgb: [62, 84, 92], alpha: 0.34, composite: 'source-over' },
    calibration: { rgb: [18, 22, 20], alpha: 0.92, composite: 'source-over' },
  },
};

export const PALETTES: Readonly<Record<ProjectionMode, Palette>> = {
  room: ROOM_PALETTE,
  paper: PAPER_PALETTE,
};

export function paletteFor(mode: ProjectionMode): Palette {
  return PALETTES[mode] ?? ROOM_PALETTE;
}

/** `rgba(...)` for a mark, optionally scaled by intensity/fade at the call site. */
export function markStyle(mark: Mark, scale = 1): string {
  const alpha = clamp01(mark.alpha * scale);
  return `rgba(${mark.rgb[0]}, ${mark.rgb[1]}, ${mark.rgb[2]}, ${round(alpha, 4)})`;
}

/** `rgba(...)` at an explicit alpha, ignoring the mark's own single-pass alpha. */
export function markStyleAt(mark: Mark, alpha: number): string {
  return `rgba(${mark.rgb[0]}, ${mark.rgb[1]}, ${mark.rgb[2]}, ${round(clamp01(alpha), 4)})`;
}

export function rgbCss(rgb: Rgb): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/** What a single pass of `mark` over `ground` actually resolves to. */
export function composite(ground: Rgb, mark: Mark, scale = 1): Rgb {
  const alpha = clamp01(mark.alpha * scale);
  const out: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const base = ground[index];
    const source = mark.rgb[index];
    const value = mark.composite === 'lighter'
      ? base + source * alpha
      : base * (1 - alpha) + source * alpha;
    out.push(Math.max(0, Math.min(255, value)));
  }
  return [out[0], out[1], out[2]];
}

// ---------------------------------------------------------------------------
// Colour science. Enough of it to hold the palette to a measurable floor.
// ---------------------------------------------------------------------------

export function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2]);
}

export function cielab(rgb: Rgb): [number, number, number] {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/**
 * CIE76 difference. It overstates separation for very saturated pairs, so it is
 * used only as a *floor*: passing CIE76 by a wide margin is necessary, not
 * sufficient. Real alignment is still verified on gallery hardware.
 */
export function deltaE76(first: Rgb, second: Rgb): number {
  const a = cielab(first);
  const b = cielab(second);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Weber contrast of a mark against its ground once the room's own light is
 * added to both. `ambientRatio` is ambient wall luminance as a fraction of the
 * projector's full-white luminance: ~0.02 for a blacked-out room, ~0.25 for a
 * daylit white-box gallery.
 *
 * This is the model that decides polarity. For an additive mark the ground
 * carries no projected light, so raising ambient only dilutes; for a
 * subtractive mark the ground is full projector output, so ambient dilutes a
 * difference that was already bounded by the projector's dynamic range.
 */
export function projectedWeberContrast(
  groundLuminance: number,
  markLuminance: number,
  ambientRatio: number,
): number {
  const ground = ambientRatio + groundLuminance;
  const mark = ambientRatio + markLuminance;
  return Math.abs(mark - ground) / Math.max(1e-6, Math.min(ground, mark));
}

/**
 * Share of the projector's full-white output the palette's ground demands. The
 * camera has to reject the installation's own light, so a low number here is a
 * sensor-stability property, not only an aesthetic one.
 */
export function groundLightCost(palette: Palette): number {
  return relativeLuminance(palette.ground);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// How each room personality is allowed to look.
// ---------------------------------------------------------------------------

/**
 * The world model already decides how the room feels. Before this table that
 * decision reached the wall as a single alpha value, so six of the eight
 * personalities projected identically and the state was, for a visitor,
 * fictional.
 *
 * `retention` is the per-second share of accumulated light the image keeps. It
 * is the room's forgetting made visible: an overwhelmed room cannot hold a
 * trace, a remembering room lets everything linger. `presence` scales living
 * bodies, `drift` scales the ambient field, and `unrest` displaces marks from
 * where they were actually sensed — the room's grip on the truth loosening.
 */
export type PersonalityRender = {
  readonly retention: number;
  readonly presence: number;
  readonly drift: number;
  readonly unrest: number;
};

export const PERSONALITY_RENDER = {
  dormant: { retention: 0.86, presence: 0.55, drift: 0.35, unrest: 0.1 },
  curious: { retention: 0.7, presence: 0.9, drift: 0.7, unrest: 0.25 },
  attentive: { retention: 0.62, presence: 1, drift: 0.85, unrest: 0.15 },
  crowded: { retention: 0.44, presence: 1.15, drift: 1.25, unrest: 0.55 },
  overwhelmed: { retention: 0.22, presence: 0.7, drift: 1.6, unrest: 1 },
  lonely: { retention: 0.9, presence: 0.7, drift: 0.45, unrest: 0.2 },
  remembering: { retention: 0.95, presence: 1.05, drift: 0.6, unrest: 0.05 },
  forgetting: { retention: 0.3, presence: 0.45, drift: 0.25, unrest: 0.4 },
} as const satisfies Record<string, PersonalityRender>;

export type RenderablePersonality = keyof typeof PERSONALITY_RENDER;

/**
 * Per-frame survival factor for accumulated light, derived from the per-second
 * `retention` so the image decays at the same rate at 24 fps and 120 fps.
 */
export function retentionPerFrame(retention: number, deltaSeconds: number): number {
  const clamped = Math.max(0.001, Math.min(0.9999, retention));
  const step = Math.max(0, Math.min(0.5, deltaSeconds));
  return clamped ** step;
}

/**
 * How much of a mark to lay down this frame when it is being drawn repeatedly
 * into the accumulation buffer.
 *
 * A buffer that keeps `retention` of its light per frame and receives `d` per
 * frame settles at `d / (1 - retention)`. Depositing a mark's full single-pass
 * alpha every frame therefore drives it to white within a second, whatever the
 * palette says — the first build of this renderer did exactly that, and the
 * hue information the six recall events depend on was lost to saturation.
 *
 * Depositing only what the frame just lost puts the equilibrium back on the
 * mark's declared alpha, at any frame rate and any retention. A side effect is
 * that the personalities inherit their own rise times for free: an overwhelmed
 * room flares and loses it, a remembering room accrues slowly and holds.
 */
export function depositPerFrame(retentionFrame: number): number {
  return Math.max(0, Math.min(1, 1 - retentionFrame));
}

/** Steady-state brightness of a mark deposited continuously. Used by the tests. */
export function accumulatedEquilibrium(deposit: number, retentionFrame: number): number {
  const loss = 1 - retentionFrame;
  return loss <= 0 ? 1 : Math.min(1, deposit / loss);
}
