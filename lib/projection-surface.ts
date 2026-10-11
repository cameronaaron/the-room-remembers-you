/**
 * The shape of the projected image: how large the drawing surfaces are, and
 * how the finished rectangle is bent to fit the wall.
 *
 * Both were arithmetic inside the render effect, which meant the two numbers
 * that decide whether a CHEAP machine can afford a frame — the device pixel
 * ratio cap and the half-resolution retina — could only be checked by opening
 * the piece on that machine.
 */
import type { RoomConfig } from './room-types.ts';

/**
 * Retina and projection are never asked for more than two device pixels per CSS
 * pixel. A 3× phone-class display triples the fill cost of every frame for a
 * blurred light field nobody can resolve from across a gallery.
 */
export const MAX_PIXEL_RATIO = 2;

/** The retina is a blurred accumulation buffer, so it is drawn at half scale. */
export const RETINA_SCALE = 0.5;

export type SurfaceSize = {
  width: number;
  height: number;
  retinaWidth: number;
  retinaHeight: number;
  /** Compared frame to frame to decide whether the canvases must be resized. */
  key: string;
};

export function surfaceSize(
  innerWidth: number,
  innerHeight: number,
  devicePixelRatio: number,
): SurfaceSize {
  const ratio = Math.min(devicePixelRatio || 1, MAX_PIXEL_RATIO);
  const width = Math.round(innerWidth * ratio);
  const height = Math.round(innerHeight * ratio);
  return {
    width,
    height,
    // Never zero: a canvas sized 0 throws on `drawImage` rather than drawing
    // nothing, which turns a narrow window into a blank wall.
    retinaWidth: Math.max(1, Math.round(width * RETINA_SCALE)),
    retinaHeight: Math.max(1, Math.round(height * RETINA_SCALE)),
    key: `${width}x${height}`,
  };
}

export type ProjectionStyle = { clipPath: string; transform: string };

/**
 * Keystone, rotation and crop, as one CSS transform.
 *
 * Cropping insets the image, so the surface is scaled back up by the amount
 * that was cut away — otherwise every keystone adjustment also shrinks the
 * projection and the operator chases the two settings against each other.
 */
export function projectionStyle(
  config: Pick<RoomConfig, 'crop' | 'keystoneX' | 'keystoneY' | 'rotation'>,
): ProjectionStyle {
  return {
    clipPath: `inset(${config.crop}%)`,
    transform: `perspective(1400px) rotateX(${config.keystoneY}deg) rotateY(${config.keystoneX}deg) rotate(${config.rotation}deg) scale(${1 + config.crop / 45})`,
  };
}
