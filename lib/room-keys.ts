/**
 * What the operator's keyboard means, decided away from the window it is
 * attached to.
 *
 * The shortcuts are printed on the wall card and in the console's own hint, so
 * "does B still black the room out" is a question about the piece rather than
 * about React. While this lived in a `keydown` closure the only way to ask it
 * was to stand at the gallery machine and press the key.
 */
import type { MotionBlob } from './room-types.ts';

/**
 * One operator intent. Named rather than expressed as a config patch: `mute`
 * and `blackout` both end up changing settings, but only one of them has to
 * remember what the volume used to be.
 */
export type RoomCommand =
  | 'operator'
  | 'diagnostics'
  | 'tracking-overlay'
  | 'fullscreen'
  | 'blackout'
  | 'mute'
  | 'reset'
  | 'capture-calibration'
  | 'cancel-calibration';

/** The parts of a `KeyboardEvent` this decision reads, and nothing else. */
export type KeyStroke = {
  key: string;
  code: string;
  altKey: boolean;
  shiftKey: boolean;
};

export type KeyAction = {
  command: RoomCommand;
  /**
   * Whether the browser's own handling has to be suppressed. True only for
   * Space during calibration, where the default action scrolls the projection
   * surface out from under the markers.
   */
  preventDefault: boolean;
};

/**
 * Erasing the room is the one irreversible thing the keyboard can do, so it
 * takes a chord no hand finds by accident. Everything else is a single letter
 * because the operator is usually holding something.
 */
const RESET_CHORD = { key: 'r', altKey: true, shiftKey: true } as const;

export function roomCommand(stroke: KeyStroke, calibrating: boolean): KeyAction | null {
  // Calibration owns Space and Escape while it is running, and nothing else
  // does: outside calibration, Space is how a visitor scrolls a page and
  // Escape is how they close whatever they opened.
  if (calibrating && stroke.code === 'Space') {
    return { command: 'capture-calibration', preventDefault: true };
  }
  if (stroke.key === 'Escape') return { command: 'cancel-calibration', preventDefault: false };
  const key = stroke.key.toLowerCase();
  if (key === RESET_CHORD.key
    && stroke.altKey === RESET_CHORD.altKey
    && stroke.shiftKey === RESET_CHORD.shiftKey) {
    return { command: 'reset', preventDefault: false };
  }
  // Plain `r` is deliberately nothing. A reset one modifier away from a bare
  // letter is a reset that eventually happens by mistake.
  const single: Partial<Record<string, RoomCommand>> = {
    o: 'operator',
    d: 'diagnostics',
    t: 'tracking-overlay',
    f: 'fullscreen',
    b: 'blackout',
    m: 'mute',
  };
  const command = single[key];
  return command ? { command, preventDefault: false } : null;
}

/**
 * Mute, and unmute to where the operator had it.
 *
 * Muting to zero and unmuting to a default would quietly overwrite a level
 * somebody set by ear in the actual room, which is the only way that number is
 * ever arrived at.
 */
export function toggleMute(
  volume: number,
  held: number,
): { masterVolume: number; held: number } {
  if (volume > 0) return { masterVolume: 0, held: volume };
  return { masterVolume: held, held };
}

/** Where a pointer sits in the room, as the demo body the analysis loop reads. */
export function pointerBlob(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
): MotionBlob {
  return {
    x: clientX / viewportWidth,
    y: clientY / viewportHeight,
    // A person-shaped patch rather than a dot, so demo mode exercises the same
    // extent and plausibility bounds a camera blob does.
    width: 0.08,
    height: 0.18,
    energy: 0.7,
  };
}
