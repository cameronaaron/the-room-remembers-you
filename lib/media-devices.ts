/**
 * What the installation asks the browser for, and what it says when it does not
 * get it.
 *
 * `getUserMedia` cannot be called in a test, but every decision around it can:
 * which constraints are exact and which are hints, which devices are worth
 * listing, and which of the two camera failures the operator is looking at.
 */

/**
 * The picture the tracker wants: small, steady, and no larger than it can
 * analyse twenty-four times a second on the cheapest machine in the room.
 */
export const CAMERA_PICTURE = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: 24, max: 30 },
} as const;

/**
 * Nothing that rewrites the signal. Echo cancellation and noise suppression
 * belong to a call; automatic gain would ride over the level the whisper
 * detector's own threshold is measured against and make it meaningless.
 */
export const MICROPHONE_CAPTURE = {
  video: false,
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
} as const;

/**
 * A chosen camera is requested with `exact`.
 *
 * Silently falling back to the built-in webcam after an operator has selected
 * the one pointed at the room is worse than failing: the picture looks
 * plausible, the tracker runs, and the room quietly senses the ceiling.
 */
export function cameraConstraints(deviceId: string) {
  return {
    video: { ...CAMERA_PICTURE, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
    audio: false as const,
  };
}

export type DeviceLike = { deviceId: string; kind: string; label: string };

/**
 * The cameras worth offering. Labels are empty until permission has been
 * granted, so an unnamed device is numbered rather than shown as a blank row.
 */
export function videoInputs(devices: readonly DeviceLike[]) {
  return devices
    .filter((device) => device.kind === 'videoinput')
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Camera ${index + 1}`,
    }));
}

/**
 * The two camera failures are different problems and read as one to an
 * operator. No camera at all still leaves demo motion; a named camera that
 * will not open means the piece is sensing nothing and the fix is a device
 * list away.
 */
export function cameraFailure(deviceId: string): { lastEvent: string; prompt: string } {
  return {
    lastEvent: deviceId
      ? 'selected camera unavailable — choose another in the console'
      : 'camera unavailable — demo motion remains available',
    prompt: 'Camera unavailable. Press D to see why, or O to choose another device.',
  };
}

/**
 * How long a dropped device is left alone before it is asked for again.
 *
 * A USB camera that has been unplugged reappears as the same device id when it
 * comes back, so retrying is worth doing; doing it in a tight loop against a
 * device that is genuinely gone is not.
 */
export const DEVICE_RETRY_MS = 2_500;
