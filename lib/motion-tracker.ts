import { BodyScale } from './body-scale.ts';
import { assignTracks } from './track-assignment.ts';
import type { MotionBlob, MotionDiagnostics, Point, VisitorTrack } from './room-types';

const ANALYSIS_WIDTH = 160;
const ANALYSIS_HEIGHT = 90;
const CELL = 4;
const GRID_WIDTH = ANALYSIS_WIDTH / CELL;
const GRID_HEIGHT = Math.ceil(ANALYSIS_HEIGHT / CELL);
const WARMUP_FRAMES = 9;
/**
 * Share of the *grid* that may light up before a frame is thrown away as a
 * room-wide lighting or scene change rather than as movement.
 *
 * This deliberately measures spatial coverage rather than the fraction of
 * changed pixels. The two are not the same thing, and conflating them was a
 * real defect: a person standing close to the camera changes a large fraction
 * of the pixels while still occupying only part of the room, and the old
 * pixel-fraction guard could not tell that apart from the lights coming on.
 *
 * Measured on a real desk-range session: a single visitor lit between 27% and
 * 56% of the grid, and 21% of frames were being discarded as scene changes. A
 * genuine lighting change lights up essentially every cell, so a coverage
 * threshold separates the two cleanly where a pixel count could not.
 */
export const DEFAULT_SCENE_CHANGE_COVERAGE = 0.85;

/**
 * Absolute backstop on changed pixels. Only catches the pathological case
 * where nearly the entire image differs; ordinary movement never reaches it.
 */
export const ABSOLUTE_CHANGE_LIMIT = 0.92;

/** Frames kept to report how often the scene-change guard is firing. */
const REJECTION_WINDOW = 30;

/**
 * After the background model has warmed up it is still *settling*: anything
 * already standing in the room is learned in gradually, so the changed area
 * starts at roughly twice its eventual size and falls for several seconds.
 *
 * Measured on a real session: grid coverage ran 42%, 50%, 45%, 42%, 38%, 33%,
 * 28%, 23% and only then held at 22%. Two extra tracks were born and lost
 * inside that transient, and because both were born at once the room announced
 * "two of you, at once" to a single visitor.
 *
 * Detection during settling is still useful for the artwork to react to. It is
 * not solid enough to make claims about.
 */
const SETTLE_WINDOW_MS = 2_000;
/** Percentage points of coverage spread across the window that counts as still. */
const SETTLE_SPREAD = 6;
/** Settling ends regardless after this long, so a busy room cannot stall it. */
const SETTLE_TIMEOUT_MS = 12_000;

/**
 * Gap, in room units, below which two detected regions are treated as one body.
 *
 * Connected components only join cells that touch orthogonally, so a single
 * person routinely arrives as several pieces — a head, a torso, legs — split
 * wherever their clothing happens to match the background. Every piece then
 * became its own track, so one visitor was reported as three or four people and
 * the artwork answered each fragment separately instead of answering them.
 *
 * Roughly one and a half cells. Wide enough to close the gaps inside one body,
 * narrow enough to leave two people standing apart as two people.
 */
export const BODY_MERGE_GAP = 0.04;

/**
 * Vertical gap allowed between regions that overlap horizontally.
 *
 * A person is a vertical column, and that is the asymmetry the merge rule has
 * to exploit. Their fragments stack — head above torso above legs — and share
 * the same horizontal band. Two people, by contrast, stand side by side and
 * share almost no horizontal extent.
 *
 * A single symmetric allowance cannot express that. On a real session, 51
 * samples reported two people when there was one, every one of them with two
 * genuinely separate regions at a modest 17.5% coverage: one body, split
 * vertically, sitting further apart than a symmetric gap could close without
 * also merging people standing next to each other.
 */
export const COLUMN_MERGE_GAP = 0.14;

/** Share of the narrower region's width that must overlap to count as a column. */
export const COLUMN_OVERLAP = 0.35;

/**
 * Sightings before a detection is treated as a person.
 *
 * Without this, a one-frame fragment created a track instantly, and that track
 * then lingered for four seconds of occlusion prediction. A single visitor
 * produced a crowd of phantoms that took seconds to drain.
 */
export const TRACK_CONFIRM_SIGHTINGS = 2;

/**
 * How long a confirmed person may be predicted through an occlusion.
 */
export const OCCLUSION_SECONDS = 4;

/**
 * Two people cannot stand inside one body's width of each other.
 *
 * Blob merging works on what a single frame detected. It cannot help when a
 * nearly-still visitor registers only in disconnected scraps — a hand here, a
 * shoulder there — that never touch and do not share a column. Those scraps
 * become separate tracks, and on a real session 44 of 307 samples reported two
 * or more people at a median coverage of 8%, which is one person barely moving.
 *
 * This is the backstop: after association, tracks closer together than a body
 * are the same body, and the younger one is discarded.
 */
export const MIN_PERSON_SEPARATION = 0.08;

/** Fraction of the wider detection two people must be apart by. */
export const SEPARATION_OF_BODY = 0.55;

/**
 * Share of the smaller detection that may sit inside the larger one before the
 * two are judged to be the same body. Centroid distance alone misses this: a
 * scrap of movement can be well away from a body's centre while lying entirely
 * within its outline, which is precisely what a moving hand looks like.
 */
export const SAME_BODY_OVERLAP = 0.3;

/**
 * A detection this much smaller than another, and this close to it, is a piece
 * of it rather than a person of its own.
 *
 * Overlap alone is not enough: a hand or a shoulder can register just outside a
 * torso's box while obviously belonging to the same body. Measured on a real
 * session, a single visitor at 13% coverage still produced three separate
 * tracks this way.
 *
 * This is frankly a heuristic about human proportions, not a principle. It
 * holds because a fragment is small and a person is not.
 */
/**
 * Accepted cells one person's worth of movement occupies, at the low end.
 *
 * The count of people is bounded by how much of the room is actually moving.
 * Measured over a real session, a single visitor ranged from 39 to 546 active
 * cells; every sample that claimed three people sat at 75 cells or fewer.
 * Three bodies cannot move less than one.
 *
 * A blunt instrument, and deliberately so: it only ever fires when the frame is
 * nearly still, which is exactly when the shape-based tests have least to work
 * with. It is a bound, not a detector.
 */
/**
 * Fallback scale, and no longer a claim about every installation.
 *
 * Measured on a desk-range webcam, where one visitor filled 39 to 546 cells.
 * With the camera across a gallery a body covers about 7, so applying this
 * number there bounded eight people to "at most one" and twenty-five to three,
 * silently. `BodyScale` measures the real figure from the scene; this remains
 * only as the shape of the calculation, never as its input.
 */
export const CELLS_PER_PERSON = 55;

/**
 * Upper bound on how many people this much movement could possibly be.
 *
 * `cellsPerBody` must come from `BodyScale`, measured in this camera's view.
 * There is no default: a bound that guesses the scale is the defect this
 * signature exists to prevent.
 *
 * **Rounded, not floored.** A body's accepted cells are fewer than the merged
 * region the scale was learned from, so two visitors land a little under twice
 * the scale far more often than they land over it, and flooring always resolves
 * that shortfall by deleting somebody. Measured on synthetic gallery frames:
 * two visitors produced 19 accepted cells against a learned scale of 11, and
 * the bound reported one person — the silent under-count this file's own notes
 * describe, arriving through the mechanism meant to prevent an over-count.
 *
 * Rounding keeps every case the bound exists for. The real session where three
 * people were claimed at 75 cells against a 55-cell scale is 1.36, which still
 * rounds to one; a nearly-still frame still floors at one through the Math.max.
 * The asymmetry is deliberate and is the same one the scale itself uses: an
 * over-count is what fragment continuity, column merging and box-overlap
 * coalescing exist to catch, while an under-count has nothing behind it.
 */
export function maxPlausibleBodies(activeCells: number, cellsPerBody: number): number {
  return Math.max(1, Math.round(activeCells / Math.max(1, cellsPerBody)));
}

export const FRAGMENT_AREA_RATIO = 0.35;
export const FRAGMENT_REACH = 0.6;

/** Is `small` plausibly a piece of `large` rather than someone else? */
export function isFragmentOf(
  small: { x: number; y: number; width: number; height: number },
  large: { x: number; y: number; width: number; height: number },
): boolean {
  const smallArea = small.width * small.height;
  const largeArea = large.width * large.height;
  if (largeArea <= 0 || smallArea > largeArea * FRAGMENT_AREA_RATIO) return false;
  const reach = Math.max(large.width, large.height) * FRAGMENT_REACH;
  return Math.hypot(small.x - large.x, small.y - large.y) <= reach;
}

/** Share of the smaller box that lies inside the larger. */
export function boxOverlapRatio(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): number {
  const wide = Math.min(first.x + first.width / 2, second.x + second.width / 2)
    - Math.max(first.x - first.width / 2, second.x - second.width / 2);
  const tall = Math.min(first.y + first.height / 2, second.y + second.height / 2)
    - Math.max(first.y - first.height / 2, second.y - second.height / 2);
  // A positive overlap already proves both boxes have positive width and
  // height: `wide > 0` needs min(right) > max(left), which a zero or negative
  // width makes impossible on either box. So neither area can be zero here, and
  // a guard for that was a division nothing could reach.
  if (wide <= 0 || tall <= 0) return 0;
  return (wide * tall) / Math.min(first.width * first.height, second.width * second.height);
}

/**
 * Per-*second* retention while occluded. These were per-frame constants, which
 * makes a prediction behave completely differently at 10 Hz and at 24 Hz: the
 * same 0.84 confidence factor leaves 17% after a second at the slower profile
 * and 3% at the faster one. Occlusion recovery must not depend on how fast the
 * machine happens to be analysing.
 *
 * Confidence is tuned to reach the floor at roughly the same moment the hard
 * `OCCLUSION_SECONDS` cap expires, so the two agree instead of one quietly
 * overriding the other.
 */
export const OCCLUDED_CONFIDENCE_RETENTION = 0.35;
export const OCCLUDED_VELOCITY_RETENTION = 0.25;

/** Below this, a prediction is not worth holding on to. */
export const OCCLUDED_CONFIDENCE_FLOOR = 0.02;

const EMPTY_DIAGNOSTICS: MotionDiagnostics = {
  width: GRID_WIDTH,
  height: GRID_HEIGHT,
  mask: Array(GRID_WIDTH * GRID_HEIGHT).fill(0),
  changedPercent: 0,
  candidateCells: 0,
  activeCells: 0,
  sceneChangeLimitPercent: DEFAULT_SCENE_CHANGE_COVERAGE * 100,
  coveragePercent: 0,
  rejectedFraction: 0,
  blobCount: 0,
  meanLightShift: 0,
  cellsPerBody: null,
  state: 'idle',
  source: 'none',
  visibleTracks: 0,
  occludedTracks: 0,
};

/**
 * Median of `current - reference`, via a 1-level histogram over the integer
 * range luminance differences can occupy. Robust to up to half the frame
 * moving, and cheaper than sorting.
 */
export function medianDifference(current: Float32Array, reference: Float32Array): number {
  // An empty frame has no median. Without this the scan satisfies `seen >= 0`
  // on the first bin and reports -255 — the far end of the range, read
  // downstream as the room having gone black — instead of "nothing changed".
  if (!current.length) return 0;
  const OFFSET = 255;
  const bins = new Uint32Array(OFFSET * 2 + 1);
  for (let index = 0; index < current.length; index += 1) {
    const difference = Math.round(current[index] - reference[index]);
    bins[Math.max(0, Math.min(bins.length - 1, difference + OFFSET))] += 1;
  }
  // Every sample lands in a bin, so the running total passes half the frame
  // before the scan runs out of bins. There is no median-not-found case to
  // return from, and writing one meant a line no frame could ever reach.
  const middle = current.length / 2;
  let seen = 0;
  let bin = 0;
  while (seen < middle) {
    seen += bins[bin];
    bin += 1;
  }
  return bin - 1 - OFFSET;
}

export class MotionFrameAnalyzer {
  private background = new Float32Array(ANALYSIS_WIDTH * ANALYSIS_HEIGHT);
  private persistence = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
  /**
   * How large a body is in this camera's view, measured rather than assumed.
   * The bound it feeds is otherwise a statement about one camera distance.
   */
  private bodyScale = new BodyScale();
  private learnedFrames = 0;
  private rejections: number[] = [];
  private settleHistory: Array<{ t: number; coverage: number }> = [];
  private warmedAt = 0;
  private settled = false;
  private diagnostics: MotionDiagnostics = { ...EMPTY_DIAGNOSTICS, mask: [...EMPTY_DIAGNOSTICS.mask] };

  analyze(
    luminance: Float32Array,
    sensitivity: number,
    sceneChangeCoverage = DEFAULT_SCENE_CHANGE_COVERAGE,
    now = performance.now(),
  ): MotionBlob[] {
    if (luminance.length !== this.background.length) throw new Error('Unexpected motion frame size');
    const threshold = Math.max(8, sensitivity);

    if (this.learnedFrames < WARMUP_FRAMES) {
      const learningRate = this.learnedFrames === 0 ? 1 : 0.35;
      for (let index = 0; index < luminance.length; index += 1) {
        const previous = this.background[index];
        this.background[index] = previous + (luminance[index] - previous) * learningRate;
      }
      this.learnedFrames += 1;
      this.persistence.fill(0);
      this.diagnostics = {
        ...EMPTY_DIAGNOSTICS,
        mask: [...EMPTY_DIAGNOSTICS.mask],
        state: 'warming',
      };
      return [];
    }

    // Robust estimate of how much the whole room's brightness has shifted.
    //
    // This used to be the arithmetic mean, which any large nearby object
    // destroys: a visitor covering a third of the frame and 120 levels brighter
    // than the wall behind them produces a mean shift of ~41, so every
    // *unchanged* background pixel then differs from its corrected background
    // by more than the threshold and the entire frame reads as changed. That is
    // why a desk-range webcam reported ~29% of pixels changing at all times,
    // lit a third of the grid continuously, and tripped the scene-change guard.
    //
    // The median is unaffected by a minority of the frame moving, which is
    // exactly the case that matters. Computed by histogram to stay O(n).
    const meanLightShift = medianDifference(luminance, this.background);

    const changed = new Uint8Array(luminance.length);
    const candidateCells = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
    let changedPixels = 0;
    for (let y = 0; y < ANALYSIS_HEIGHT; y += 1) {
      for (let x = 0; x < ANALYSIS_WIDTH; x += 1) {
        const pixelIndex = y * ANALYSIS_WIDTH + x;
        const difference = Math.abs(luminance[pixelIndex] - this.background[pixelIndex] - meanLightShift);
        if (difference <= threshold) continue;
        changed[pixelIndex] = 1;
        changedPixels += 1;
        candidateCells[Math.floor(y / CELL) * GRID_WIDTH + Math.floor(x / CELL)] += 1;
      }
    }

    const changedFraction = changedPixels / luminance.length;

    // Count candidates first: the scene-change decision depends on how much of
    // the grid they cover, so it cannot be made before they are known.
    let candidateCount = 0;
    for (let index = 0; index < candidateCells.length; index += 1) {
      if (candidateCells[index] >= 5) candidateCount += 1;
    }
    const coverage = candidateCount / candidateCells.length;

    // Has the background stopped moving under us?
    if (!this.warmedAt) this.warmedAt = now;
    this.settleHistory.push({ t: now, coverage: coverage * 100 });
    while (this.settleHistory.length && now - this.settleHistory[0].t > SETTLE_WINDOW_MS) {
      this.settleHistory.shift();
    }
    if (!this.settled) {
      const spans = this.settleHistory.length > 1
        && now - this.settleHistory[0].t >= SETTLE_WINDOW_MS * 0.9;
      const values = this.settleHistory.map((entry) => entry.coverage);
      const steady = spans && Math.max(...values) - Math.min(...values) <= SETTLE_SPREAD;
      this.settled = steady || now - this.warmedAt > SETTLE_TIMEOUT_MS;
    }
    const sceneChange = coverage > sceneChangeCoverage || changedFraction > ABSOLUTE_CHANGE_LIMIT;
    this.rejections.push(sceneChange ? 1 : 0);
    if (this.rejections.length > REJECTION_WINDOW) this.rejections.shift();
    const acceptedCells = new Uint8Array(candidateCells.length);
    const mask = Array.from<number>({ length: candidateCells.length }).fill(0);
    let activeCells = 0;
    for (let index = 0; index < candidateCells.length; index += 1) {
      const candidate = candidateCells[index] >= 5;
      this.persistence[index] = sceneChange
        ? 0
        : candidate
          ? Math.min(3, this.persistence[index] + 1)
          : Math.max(0, this.persistence[index] - 1);
      if (candidate) mask[index] = 1;
      if (!candidate || this.persistence[index] < 2) continue;
      acceptedCells[index] = candidateCells[index];
      mask[index] = 2;
      activeCells += 1;
    }

    for (let index = 0; index < luminance.length; index += 1) {
      const learningRate = sceneChange ? 0.18 : changed[index] ? 0.001 : 0.018;
      this.background[index] += (luminance[index] - this.background[index]) * learningRate;
    }

    let blobs: MotionBlob[] = [];
    if (!sceneChange) {
      const found = connectedComponents(acceptedCells, this.bodyScale.cellsPerBody());
      blobs = found.blobs;
      // Learn from what was found, after the bound rather than before it, so a
      // frame the bound truncated cannot also teach the bound that bodies are
      // larger than they are.
      this.bodyScale.observe(found.cellCounts, now);
    }
    this.learnedFrames += 1;
    this.diagnostics = {
      ...EMPTY_DIAGNOSTICS,
      mask,
      changedPercent: changedFraction * 100,
      candidateCells: candidateCount,
      activeCells,
      sceneChangeLimitPercent: sceneChangeCoverage * 100,
      coveragePercent: coverage * 100,
      // This frame's own verdict was pushed above, so the window is never
      // empty here. `EMPTY_DIAGNOSTICS` is what reports the no-frames-yet case,
      // and it is the only object read before the first frame is judged.
      rejectedFraction: this.rejections.reduce((sum, value) => sum + value, 0) / this.rejections.length,
      blobCount: blobs.length,
      meanLightShift,
      cellsPerBody: this.bodyScale.cellsPerBody(),
      state: sceneChange ? 'scene-change' : this.settled ? 'tracking' : 'settling',
    };
    return blobs;
  }

  getDiagnostics(): MotionDiagnostics {
    return this.diagnostics;
  }

  reset() {
    this.background.fill(0);
    this.persistence.fill(0);
    this.learnedFrames = 0;
    this.rejections = [];
    this.settleHistory = [];
    this.warmedAt = 0;
    this.settled = false;
    // Relearning the empty room is what an operator does after moving the
    // camera, and moving the camera is exactly what changes how large a body
    // is in the frame. Carrying the old scale over would apply one geometry's
    // measurement to another, which is the defect this replaced.
    this.bodyScale.reset();
    this.diagnostics = { ...EMPTY_DIAGNOSTICS, mask: [...EMPTY_DIAGNOSTICS.mask] };
  }
}

export class MotionTracker {
  private canvas = document.createElement('canvas');
  private context: CanvasRenderingContext2D;
  private analyzer = new MotionFrameAnalyzer();

  constructor() {
    this.canvas.width = ANALYSIS_WIDTH;
    this.canvas.height = ANALYSIS_HEIGHT;
    const context = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Camera analysis canvas is unavailable');
    this.context = context;
  }

  analyze(
    video: HTMLVideoElement,
    sensitivity: number,
    mirrored: boolean,
    sceneChangeCoverage = DEFAULT_SCENE_CHANGE_COVERAGE,
    now = performance.now(),
  ): MotionBlob[] {
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return [];
    this.context.save();
    if (mirrored) {
      this.context.translate(ANALYSIS_WIDTH, 0);
      this.context.scale(-1, 1);
    }
    this.context.drawImage(video, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    this.context.restore();
    const pixels = this.context.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT).data;
    const luminance = new Float32Array(ANALYSIS_WIDTH * ANALYSIS_HEIGHT);
    for (let pixelIndex = 0; pixelIndex < luminance.length; pixelIndex += 1) {
      const rgba = pixelIndex * 4;
      luminance[pixelIndex] = pixels[rgba] * 0.299 + pixels[rgba + 1] * 0.587 + pixels[rgba + 2] * 0.114;
    }
    return this.analyzer.analyze(luminance, sensitivity, sceneChangeCoverage, now);
  }

  getDiagnostics(): MotionDiagnostics {
    return this.analyzer.getDiagnostics();
  }

  reset() {
    this.analyzer.reset();
  }
}

/**
 * Ceiling on bodies reported from one frame.
 *
 * Twelve, matching the FULL profile and the twelve body slots the swarm shader
 * declares. It was eight, which meant the FULL profile's advertised twelve was
 * unreachable and a crowd was truncated below the limit the work claims to
 * hold. Anyone past the twelfth still moves the memory field — they simply are
 * not tracked as an individual, which the instrument reports.
 */
export const MAX_DETECTED_BODIES = 12;

function connectedComponents(
  cells: Uint8Array,
  cellsPerBody: number | null,
): { blobs: MotionBlob[]; cellCounts: number[] } {
  const active = cells.map((value) => (value >= 4 ? 1 : 0));
  const visited = new Uint8Array(active.length);
  const blobs: MotionBlob[] = [];
  for (let start = 0; start < active.length; start += 1) {
    if (!active[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let minX = GRID_WIDTH;
    let maxX = 0;
    let minY = GRID_HEIGHT;
    let maxY = 0;
    let energy = 0;
    while (queue.length) {
      const index = queue.pop()!;
      const x = index % GRID_WIDTH;
      const y = Math.floor(index / GRID_WIDTH);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      energy += cells[index];
      for (const neighbor of [index - 1, index + 1, index - GRID_WIDTH, index + GRID_WIDTH]) {
        if (neighbor < 0 || neighbor >= active.length || visited[neighbor] || !active[neighbor]) continue;
        const nx = neighbor % GRID_WIDTH;
        if (Math.abs(nx - x) > 1) continue;
        visited[neighbor] = 1;
        queue.push(neighbor);
      }
    }
    const cellCount = (maxX - minX + 1) * (maxY - minY + 1);
    if (energy < 44 || cellCount < 3) continue;
    blobs.push({
      x: ((minX + maxX + 1) / 2) / GRID_WIDTH,
      y: ((minY + maxY + 1) / 2) / GRID_HEIGHT,
      width: (maxX - minX + 1) / GRID_WIDTH,
      height: (maxY - minY + 1) / GRID_HEIGHT,
      energy: Math.min(1, energy / 700),
    });
  }
  const merged = mergeAdjacentBlobs(blobs).sort((a, b) => b.energy - a.energy);

  // How many accepted cells each merged region accounts for. This is the
  // sample BodyScale needs, in the same units the bound divides: cells, not
  // bounding boxes. Counted from the grid rather than carried through the
  // merge, so mergeAdjacentBlobs stays a statement about geometry alone.
  const cellCounts = merged.map((blob) => {
    const minX = Math.max(0, Math.round((blob.x - blob.width / 2) * GRID_WIDTH));
    const maxX = Math.min(GRID_WIDTH - 1, Math.round((blob.x + blob.width / 2) * GRID_WIDTH) - 1);
    const minY = Math.max(0, Math.round((blob.y - blob.height / 2) * GRID_HEIGHT));
    const maxY = Math.min(GRID_HEIGHT - 1, Math.round((blob.y + blob.height / 2) * GRID_HEIGHT) - 1);
    let count = 0;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) if (cells[y * GRID_WIDTH + x] > 0) count += 1;
    }
    return count;
  });

  // Keep the strongest, bounded by how much of the room is moving at all — but
  // only once the scale of a body here has actually been measured. Until then
  // the shape tests stand alone, which is the safer failure: an over-count is
  // what fragment continuity and column merging exist to catch, while a bound
  // with the wrong scale deletes people who are standing in the room.
  if (cellsPerBody === null) {
    return { blobs: merged.slice(0, MAX_DETECTED_BODIES), cellCounts };
  }
  let occupied = 0;
  for (const value of cells) if (value > 0) occupied += 1;
  const limit = Math.min(MAX_DETECTED_BODIES, maxPlausibleBodies(occupied, cellsPerBody));
  return { blobs: merged.slice(0, limit), cellCounts };
}

/** Bounding-box gap between two regions, per axis. Negative means they overlap. */
function boxGap(first: MotionBlob, second: MotionBlob) {
  const gapX = Math.max(first.x - first.width / 2, second.x - second.width / 2)
    - Math.min(first.x + first.width / 2, second.x + second.width / 2);
  const gapY = Math.max(first.y - first.height / 2, second.y - second.height / 2)
    - Math.min(first.y + first.height / 2, second.y + second.height / 2);
  return { gapX, gapY };
}

/**
 * Join regions that are close enough to be parts of the same body. Repeats
 * until nothing more merges, so a chain of three fragments collapses into one.
 */
export function mergeAdjacentBlobs(input: MotionBlob[], gap = BODY_MERGE_GAP): MotionBlob[] {
  // A fixed gap only suits bodies of one size. A visitor close to the camera
  // arrives as large fragments separated by correspondingly large gaps, so the
  // allowance scales with the smaller of the two regions.
  //
  // **Vertically only.** The scale factor multiplies the smaller dimension of a
  // region, and for a standing person that dimension is their width — so a
  // scaled sideways allowance grows in exactly the direction that separates two
  // neighbours, and grows fastest when they are closest to the camera and
  // largest. Measured before this was split: two visitors 0.28 wide had to
  // stand 40% of the frame apart to be counted as two, against 14% for the same
  // pair at gallery distance. The horizontal allowance therefore stays at the
  // fixed `BODY_MERGE_GAP`, which is the asymmetry this rule exists to express.
  //
  // The residual risk is the opposite error — one close visitor split down the
  // middle reading as two — and that is the one the room is built to absorb:
  // over-counting is caught downstream by fragment continuity and track
  // coalescing, while under-counting is silent, because two people reported as
  // one looks exactly like a quieter gallery.
  const verticalGapFor = (a: MotionBlob, b: MotionBlob) => Math.max(
    gap,
    0.4 * Math.min(Math.min(a.width, a.height), Math.min(b.width, b.height)),
  );

  /** Do these two share enough horizontal extent to be one vertical column? */
  const sameColumn = (a: MotionBlob, b: MotionBlob) => {
    const overlap = Math.min(a.x + a.width / 2, b.x + b.width / 2)
      - Math.max(a.x - a.width / 2, b.x - b.width / 2);
    return overlap > 0 && overlap >= Math.min(a.width, b.width) * COLUMN_OVERLAP;
  };
  let blobs = input.map((blob) => ({ ...blob }));
  let merged = true;
  while (merged && blobs.length > 1) {
    merged = false;
    outer: for (let i = 0; i < blobs.length; i += 1) {
      for (let j = i + 1; j < blobs.length; j += 1) {
        const { gapX, gapY } = boxGap(blobs[i], blobs[j]);
        // Stacked pieces of one body get a much longer reach vertically than
        // anything gets sideways.
        const stacked = verticalGapFor(blobs[i], blobs[j]);
        const verticalReach = sameColumn(blobs[i], blobs[j])
          ? Math.max(stacked, COLUMN_MERGE_GAP)
          : stacked;
        if (gapX > gap || gapY > verticalReach) continue;
        const left = Math.min(blobs[i].x - blobs[i].width / 2, blobs[j].x - blobs[j].width / 2);
        const right = Math.max(blobs[i].x + blobs[i].width / 2, blobs[j].x + blobs[j].width / 2);
        const top = Math.min(blobs[i].y - blobs[i].height / 2, blobs[j].y - blobs[j].height / 2);
        const bottom = Math.max(blobs[i].y + blobs[i].height / 2, blobs[j].y + blobs[j].height / 2);
        blobs[i] = {
          x: (left + right) / 2,
          y: (top + bottom) / 2,
          width: right - left,
          height: bottom - top,
          energy: Math.min(1, blobs[i].energy + blobs[j].energy),
        };
        blobs = blobs.filter((_, index) => index !== j);
        merged = true;
        break outer;
      }
    }
  }
  return blobs;
}

function observeTrack(track: VisitorTrack, blob: MotionBlob, now: number) {
  const point: Point = { x: blob.x, y: blob.y, t: now };
  const elapsed = Math.max(0.016, (now - track.lastSeen) / 1000);
  const vx = (point.x - track.position.x) / elapsed;
  const vy = (point.y - track.position.y) / elapsed;
  const speed = Math.hypot(vx, vy);
  track.previous = track.position;
  track.position = point;
  track.velocity = { x: vx, y: vy };
  track.speed = track.speed * 0.65 + speed * 0.35;
  const observedElapsed = track.occluded ? 0 : Math.min(0.15, elapsed);
  track.stillFor = !track.occluded && track.speed < 0.018 ? track.stillFor + observedElapsed : 0;
  track.dwellSeconds += observedElapsed;
  track.lastSeen = now;
  track.active = true;
  track.occluded = false;
  track.confidence = Math.min(1, track.confidence + 0.16);
  track.sightings += 1;
  track.extent = { width: blob.width, height: blob.height };
  const lastPoint = track.path.at(-1)!;
  if (Math.hypot(lastPoint.x - point.x, lastPoint.y - point.y) > 0.008 || now - lastPoint.t > 500) {
    track.path.push(point);
    if (track.path.length > 280) track.path.shift();
  }
}

export class AnonymousTrackManager {
  private tracks = new Map<string, VisitorTrack>();
  private sequence = 0;
  private fragmentRecoveries = 0;
  private outlines = new Map<string, { blob: MotionBlob; at: number }>();

  update(blobs: MotionBlob[], now: number): { active: VisitorTrack[]; ended: VisitorTrack[] } {
    const ended: VisitorTrack[] = [];
    // Expire before association: a delayed frame must not revive an old identity.
    for (const [id, track] of this.tracks) {
      if (now - track.lastSeen > OCCLUSION_SECONDS * 1000) {
        track.active = false;
        ended.push(track);
        this.tracks.delete(id);
      }
    }
    const rawBlobs = new Set(blobs);
    // A split inside a recently observed outline is initially evidence of the
    // same body. Only raw detections renew this evidence, never our own union.
    for (const [id, outline] of this.outlines) {
      const track = this.tracks.get(id);
      if (!track || now - outline.at > 750) {
        this.outlines.delete(id);
        continue;
      }
      if (track.sightings < TRACK_CONFIRM_SIGHTINGS) continue;
      const anchor = outline.blob;
      const pieces = blobs.filter((blob) =>
        blob.width * blob.height < anchor.width * anchor.height * 0.75
        && boxOverlapRatio(blob, anchor) >= 0.9);
      if (pieces.length < 2) continue;
      const left = Math.min(...pieces.map((blob) => blob.x - blob.width / 2));
      const right = Math.max(...pieces.map((blob) => blob.x + blob.width / 2));
      const top = Math.min(...pieces.map((blob) => blob.y - blob.height / 2));
      const bottom = Math.max(...pieces.map((blob) => blob.y + blob.height / 2));
      const union: MotionBlob = {
        x: (left + right) / 2, y: (top + bottom) / 2,
        width: right - left, height: bottom - top,
        energy: Math.min(1, pieces.reduce((sum, blob) => sum + blob.energy, 0)),
      };
      // A small moving patch is not enough evidence to keep a full body alive.
      if (union.width * union.height < anchor.width * anchor.height * 0.5) continue;
      blobs = [...blobs.filter((blob) => !pieces.includes(blob)), union];
      this.fragmentRecoveries += 1;
    }
    let tracks = [...this.tracks.values()];
    if (tracks.length > MAX_DETECTED_BODIES) {
      // this.tracks is not otherwise bounded by occlusion alone: a confirmed
      // track survives up to OCCLUSION_SECONDS past its last real sighting, so
      // fast-enough churn (or a noisy period repeatedly confirming spurious
      // tracks) can hold more of them at once than assignTracks' ceiling
      // allows. Drop the stalest first — a track this manager has not
      // actually seen in a while is the one most likely to already be stale —
      // so a burst of noise degrades gracefully instead of throwing.
      const stale = [...tracks].sort((a, b) => a.lastSeen - b.lastSeen)
        .slice(0, tracks.length - MAX_DETECTED_BODIES);
      for (const track of stale) {
        track.active = false;
        ended.push(track);
        this.tracks.delete(track.id);
      }
      const staleIds = new Set(stale.map((track) => track.id));
      tracks = tracks.filter((track) => !staleIds.has(track.id));
    }
    const boundedBlobs = blobs.slice(0, MAX_DETECTED_BODIES);
    const costs: number[][] = tracks.map((track) => {
      const elapsed = Math.min(0.15, Math.max(0, (now - track.position.t) / 1000));
      const missingSeconds = Math.max(0, (now - track.lastSeen) / 1000);
      const predicted = {
        x: track.position.x + track.velocity.x * elapsed,
        y: track.position.y + track.velocity.y * elapsed,
      };
      const gate = 0.13 + Math.min(0.14, track.speed * 0.3) + (track.occluded ? Math.min(0.1, missingSeconds * 0.025) : 0);
      return boundedBlobs.map((blob) => {
        const distance = Math.hypot(blob.x - predicted.x, blob.y - predicted.y);
        return distance <= gate ? distance : Infinity;
      });
    });
    const assignment = tracks.length && boundedBlobs.length ? assignTracks(costs) : [];
    const matchedTracks = new Set<string>();
    const matchedBlobs = new Set<MotionBlob>();
    const blobOfTrack = new Map<string, MotionBlob>();
    for (const { trackIndex, blobIndex } of assignment) {
      const track = tracks[trackIndex];
      const blob = boundedBlobs[blobIndex];
      matchedTracks.add(track.id);
      matchedBlobs.add(blob);
      blobOfTrack.set(track.id, blob);
      observeTrack(track, blob, now);
      if (rawBlobs.has(blob)) this.outlines.set(track.id, { blob: { ...blob }, at: now });
    }

    for (const blob of boundedBlobs) {
      if (matchedBlobs.has(blob)) continue;
      const point: Point = { x: blob.x, y: blob.y, t: now };
      const id = `visitor-${now.toString(36)}-${this.sequence++}`;
      if (rawBlobs.has(blob)) this.outlines.set(id, { blob: { ...blob }, at: now });
      blobOfTrack.set(id, blob);
      this.tracks.set(id, {
        id,
        bornAt: now,
        lastSeen: now,
        position: point,
        previous: point,
        velocity: { x: 0, y: 0 },
        speed: 0,
        stillFor: 0,
        dwellSeconds: 0,
        path: [point],
        active: true,
        occluded: false,
        confidence: 0.65,
        sightings: 1,
        extent: { width: blob.width, height: blob.height },
      });
    }

    // Collapse tracks that are too close together to be different people.
    // Newest first, so the survivor is the one with the longer history.
    const present = [...this.tracks.values()].sort((first, second) => second.bornAt - first.bornAt);
    for (const younger of present) {
      if (!this.tracks.has(younger.id)) continue;
      for (const older of present) {
        if (older.id === younger.id || older.bornAt > younger.bornAt) continue;
        if (!this.tracks.has(older.id)) continue;
        // The detector genuinely resolved two people this frame: both were
        // matched to their own distinct blob by the assignment above, not
        // merely predicted from an old position. That is evidence against the
        // pure-proximity `tooClose` check specifically — two real bodies can
        // stand within one body-width of each other — but it is not evidence
        // against `inside`/`fragment`: three same-sized detections crammed
        // into less space than they could physically occupy separately are
        // still one fragmented body however "distinct" the blob objects were,
        // which is why those two checks still run unconditionally below.
        const bothFreshlyDistinct = blobOfTrack.has(younger.id) && blobOfTrack.has(older.id)
          && blobOfTrack.get(younger.id) !== blobOfTrack.get(older.id);
        const apart = Math.hypot(
          younger.position.x - older.position.x,
          younger.position.y - older.position.y,
        );
        const bodies = Math.max(younger.extent.width, older.extent.width);
        const tooClose = !bothFreshlyDistinct
          && apart <= Math.max(MIN_PERSON_SEPARATION, bodies * SEPARATION_OF_BODY);
        const inside = boxOverlapRatio(
          { ...younger.position, ...younger.extent },
          { ...older.position, ...older.extent },
        ) >= SAME_BODY_OVERLAP;
        const youngBox = { ...younger.position, ...younger.extent };
        const oldBox = { ...older.position, ...older.extent };
        const fragment = isFragmentOf(youngBox, oldBox) || isFragmentOf(oldBox, youngBox);
        if (!tooClose && !inside && !fragment) continue;
        // Preserve today's observation when retaining yesterday's identity.
        // Otherwise a fresh body is discarded and the survivor stays occluded.
        if (younger.lastSeen === now && older.lastSeen !== now) {
          observeTrack(older, {
            ...younger.position, ...younger.extent, energy: 1,
          }, now);
          matchedTracks.add(older.id);
        }
        // Keep the longer-standing identity and everything it has seen.
        older.sightings = Math.max(older.sightings, younger.sightings);
        older.confidence = Math.max(older.confidence, younger.confidence);
        this.tracks.delete(younger.id);
        break;
      }
    }

    for (const [id, track] of this.tracks) {
      if (matchedTracks.has(id) || track.bornAt === now) continue;
      const missingSeconds = (now - track.lastSeen) / 1000;
      // Only a confirmed person earns occlusion prediction. A candidate that
      // vanishes was noise, and holding it for four seconds is what turned one
      // visitor into a lingering crowd.
      const confirmed = track.sightings >= TRACK_CONFIRM_SIGHTINGS;
      const step = Math.min(0.12, Math.max(0, (now - track.position.t) / 1000));
      const stillWorthHolding = confirmed
        && missingSeconds <= OCCLUSION_SECONDS
        && track.confidence > OCCLUDED_CONFIDENCE_FLOOR;
      if (stillWorthHolding) {
        const velocityDecay = OCCLUDED_VELOCITY_RETENTION ** step;
        track.previous = track.position;
        track.position = {
          x: Math.max(0, Math.min(1, track.position.x + track.velocity.x * step)),
          y: Math.max(0, Math.min(1, track.position.y + track.velocity.y * step)),
          t: now,
        };
        track.velocity.x *= velocityDecay;
        track.velocity.y *= velocityDecay;
        track.speed *= velocityDecay;
        track.active = false;
        track.occluded = true;
        track.confidence *= OCCLUDED_CONFIDENCE_RETENTION ** step;
      } else {
        track.active = false;
        ended.push(track);
        this.tracks.delete(id);
      }
    }
    return { active: [...this.tracks.values()], ended };
  }

  getFragmentRecoveries() { return this.fragmentRecoveries; }

  clear() {
    this.fragmentRecoveries = 0;
    this.tracks.clear();
    this.outlines.clear();
  }
}

/**
 * The tracks the artwork is allowed to see: confirmed people, currently
 * observed. Occluded tracks are association state, and unconfirmed ones are
 * candidates that may still turn out to be noise.
 */
export function selectObservedTracks(tracks: readonly VisitorTrack[]): VisitorTrack[] {
  return tracks.filter((track) => !track.occluded && track.sightings >= TRACK_CONFIRM_SIGHTINGS);
}
