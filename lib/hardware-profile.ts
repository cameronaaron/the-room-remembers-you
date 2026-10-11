/**
 * Pick a hardware profile from what the machine actually reports.
 *
 * The default used to be a hardcoded CHEAP, which is the safe guess for an
 * unknown computer and the wrong one for almost any machine this runs on. On a
 * real session it capped the sensing loop at 9.3 Hz, which is slow enough that
 * the two-frame persistence rule demands over 200 ms of held movement — a
 * measurable loss of detection, not just of particles.
 *
 * Detection here is deliberately conservative: it moves *up* from CHEAP only
 * on evidence, and never overrides a profile an operator has chosen.
 */

import type { HardwareProfile } from './room-types';

export type MachineCapability = {
  /** navigator.hardwareConcurrency, or 0 when unavailable. */
  cores: number;
  /** Unmasked WebGL renderer string, lowercased. Empty when unavailable. */
  renderer: string;
  /** WebGL2 with float render targets, which the particle field requires. */
  floatTargets: boolean;
};

/**
 * GPUs that comfortably carry the largest particle field. Apple silicon is
 * named explicitly because it is what this installation is developed and
 * exhibited on, and because its integrated GPUs would otherwise be mistaken
 * for the low-power integrated parts the conservative branch is meant to catch.
 */
const STRONG_GPU = /apple m\d|radeon pro|geforce (rtx|gtx)|quadro|arc a\d/;

/** Integrated parts that should stay modest regardless of core count. */
const MODEST_GPU = /(intel|uhd|iris|hd graphics|swiftshader|llvmpipe|software)/;

export function chooseHardwareProfile(capability: MachineCapability): HardwareProfile {
  // Without float render targets the particle field cannot run at all and the
  // trace renderer takes over; there is nothing to be gained from a rich profile.
  if (!capability.floatTargets) return 'CHEAP';

  const renderer = capability.renderer.toLowerCase();
  if (MODEST_GPU.test(renderer) && !STRONG_GPU.test(renderer)) {
    return capability.cores >= 8 ? 'STANDARD' : 'CHEAP';
  }
  if (STRONG_GPU.test(renderer)) return 'FULL';
  // Unknown GPU: fall back on core count, and stay off the top rung.
  if (capability.cores >= 12) return 'FULL';
  if (capability.cores >= 8) return 'STANDARD';
  return 'CHEAP';
}

/**
 * Ask the browser what it is running on. Creates and discards a throwaway
 * context, so call it once at startup rather than per frame.
 */
export function probeMachine(): MachineCapability {
  const capability: MachineCapability = {
    cores: typeof navigator === 'undefined' ? 0 : navigator.hardwareConcurrency || 0,
    renderer: '',
    floatTargets: false,
  };
  if (typeof document === 'undefined') return capability;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { alpha: false, depth: false, antialias: false });
    if (!gl) return capability;
    capability.floatTargets = Boolean(gl.getExtension('EXT_color_buffer_float'));
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    if (info) capability.renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '');
    else capability.renderer = String(gl.getParameter(gl.RENDERER) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    // A machine that cannot even be probed gets the conservative profile.
  }
  return capability;
}
