/**
 * The trace renderer's primitives: the memory field, its film grain, and the
 * jitter that makes an unsettled room shimmer rather than vibrate.
 *
 * Separated from the drawing that uses them because these three are the only
 * pieces with their own arithmetic — a pixel buffer, a noise texture, and a
 * deterministic offset — and arithmetic is the part worth checking. What the
 * room *paints* is judged by eye against the captures in `docs/`; what it
 * *computes* on the way there can be judged by a test.
 */

import { FIELD_HEIGHT, FIELD_WIDTH } from './memory-engine.ts';
import type { Palette } from './palette.ts';

export function paintMemory(context: CanvasRenderingContext2D, field: Float32Array, intensity: number, palette: Palette) {
  const mark = palette.marks.memoryField;
  const image = context.createImageData(FIELD_WIDTH, FIELD_HEIGHT);
  for (let index = 0; index < field.length; index += 1) {
    const weight = Math.min(1, field[index] * 2.2) * intensity;
    const offset = index * 4;
    image.data[offset] = mark.rgb[0];
    image.data[offset + 1] = mark.rgb[1];
    image.data[offset + 2] = mark.rgb[2];
    image.data[offset + 3] = Math.round(weight * mark.alpha * 255);
  }
  context.clearRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);
  context.putImageData(image, 0, 0);
}

export function makeGrain() {
  const canvas = document.createElement('canvas');
  canvas.width = 220;
  canvas.height = 130;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(canvas.width, canvas.height);
  for (let index = 0; index < image.data.length; index += 4) {
    const value = 100 + Math.random() * 150;
    image.data[index] = value;
    image.data[index + 1] = value;
    image.data[index + 2] = value;
    image.data[index + 3] = 70;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

/** Deterministic per-point jitter, so unrest shimmers instead of vibrating randomly. */
export function unrestOffset(seed: number, now: number, amount: number) {
  if (amount <= 0) return { x: 0, y: 0 };
  return {
    x: Math.sin(seed * 12.9898 + now * 0.0011) * amount,
    y: Math.cos(seed * 78.233 + now * 0.0013) * amount,
  };
}

