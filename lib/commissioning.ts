import type { RoomConfig, RuntimeStatus } from './room-types';
import { HARDWARE_PROFILES } from './simulation.ts';
import { HEARTBEAT_STALE_MS } from './liveness.ts';

export const COMMISSIONING_CONFIRMATIONS = {
  empty: 'Relearn the empty room and confirm no phantom visitors appear.',
  walk: 'Walk the near and far edges; confirm one body follows each visitor.',
  alignment: 'Calibrate four points and confirm the projection follows the whole floor.',
  sound: 'Capture a short whisper, audition it, and confirm audibility across the room.',
} as const;
export type Confirmation = keyof typeof COMMISSIONING_CONFIRMATIONS;
export type PreflightCheck = { id: string; passed: boolean; instruction: string };

/** Tied to the complete configuration: changing the installation invalidates evidence.
 * This configuration key stays in RAM; it is never exported or persisted. */
export function commissioningKey(config: RoomConfig): string {
  return JSON.stringify(config);
}

export function galleryPreflight(config: RoomConfig, status: RuntimeStatus,
  confirmed: Partial<Record<Confirmation, boolean>>, now = Date.now()): PreflightCheck[] {
  const targetHz = 1000 / HARDWARE_PROFILES[config.hardwareProfile].analysisIntervalMs;
  const fresh = (at: number | undefined) => typeof at === 'number' && Number.isFinite(at)
    && at <= now && now - at < HEARTBEAT_STALE_MS;
  return [
    { id: 'live', passed: !config.demoMode && config.simulationRate === 0,
      instruction: 'Use live sensing; stop demo and accelerated simulation.' },
    { id: 'camera', passed: status.camera === 'ready' && status.motion.state === 'tracking' && fresh(status.lastAnalysisAt),
      instruction: 'Connect the camera and wait for background learning to finish.' },
    { id: 'scale', passed: Number.isFinite(status.motion.cellsPerBody) && Number(status.motion.cellsPerBody) > 0,
      instruction: 'Walk separately through near and far areas until body scale is learned.' },
    { id: 'cadence', passed: Number.isFinite(status.analysisHz) && status.analysisHz >= targetHz * 0.8,
      instruction: `Reach at least ${(targetHz * 0.8).toFixed(1)} sensing frames/s for ${config.hardwareProfile}; lower the profile if needed.` },
    { id: 'projection', passed: !config.blackout && Number.isFinite(status.fps) && status.fps > 0 && fresh(status.lastRenderAt),
      instruction: 'Disable blackout and verify the projected field is updating.' },
    { id: 'audio', passed: status.microphone === 'ready' && status.audio.contextState === 'running' && config.masterVolume > 0,
      instruction: 'Connect the microphone, resume audio and raise master volume before auditioning.' },
    ...Object.entries(COMMISSIONING_CONFIRMATIONS).map(([id, instruction]) => ({
      id, instruction, passed: confirmed[id as Confirmation] === true,
    })),
  ];
}
