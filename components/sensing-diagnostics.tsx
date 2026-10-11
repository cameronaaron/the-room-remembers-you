'use client';

import { blockingStage, diagnoseSensing, type SensingSnapshot } from '@/lib/sensing-diagnosis';
import { FIELD_HEIGHT, FIELD_WIDTH } from '@/lib/memory-engine';
import type { RoomConfig, RuntimeStatus } from '@/lib/room-types';

/**
 * A track sampled for display. Carries both coordinate spaces, because
 * "detected" and "detected in the right place" are different failures that
 * look identical on the wall.
 */
export type DiagnosticTrack = {
  id: string;
  /** Sensor space, as the motion grid sees it. */
  sx: number;
  sy: number;
  /** Projection space, after mirroring and calibration. */
  x: number;
  y: number;
  occluded: boolean;
};

/**
 * The sensing instrument.
 *
 * When the room fails to see anybody it renders an empty field, which looks
 * exactly like an empty gallery. This panel is the only way to tell those two
 * apart. It shows the raw motion grid, the count at every stage of the
 * pipeline, and where each track actually lands on the wall after mirroring
 * and calibration — because "am I detected" and "am I detected in the right
 * place" are different failures with the same symptom.
 *
 * It draws the ephemeral 40x23 occupancy grid, never camera pixels.
 */
export function SensingDiagnostics({
  open,
  status,
  config,
  tracks,
  onExportLog,
}: {
  open: boolean;
  status: RuntimeStatus;
  config: RoomConfig;
  tracks: DiagnosticTrack[];
  onExportLog: () => void;
}) {
  if (!open) return null;
  const motion = status.motion;

  const snapshot: SensingSnapshot = {
    cameraState: status.camera,
    videoWidth: Number(status.cameraResolution.split('×')[0]) || 0,
    videoHeight: Number(status.cameraResolution.split('×')[1]) || 0,
    videoReadyState: status.camera === 'ready' ? 4 : 0,
    analysisHz: status.analysisHz,
    warmingUp: motion.state === 'warming',
    settling: motion.state === 'settling',
    changedPercent: motion.changedPercent,
    coveragePercent: motion.coveragePercent,
    sceneChangeLimitPercent: motion.sceneChangeLimitPercent,
    rejectedFraction: motion.rejectedFraction,
    candidateCells: motion.candidateCells,
    activeCells: motion.activeCells,
    blobCount: motion.blobCount,
    visibleTracks: motion.visibleTracks,
    occludedTracks: motion.occludedTracks,
    sensitivity: config.motionSensitivity,
    demoMode: config.demoMode,
    simulationRate: config.simulationRate,
  };
  const findings = diagnoseSensing(snapshot);
  const blocked = blockingStage(findings);

  const stages: Array<{ key: string; label: string; value: string; ok: boolean }> = [
    { key: 'camera', label: 'Camera', value: status.camera, ok: status.camera === 'ready' },
    { key: 'frames', label: 'Frames', value: `${status.cameraResolution} @ ${status.analysisHz.toFixed(1)} Hz`, ok: status.analysisHz >= 1 },
    { key: 'pixels', label: 'Grid coverage', value: `${motion.coveragePercent.toFixed(0)}% lit / ${motion.sceneChangeLimitPercent.toFixed(0)}% limit · ${motion.changedPercent.toFixed(1)}% px`, ok: motion.changedPercent >= 0.15 && motion.rejectedFraction <= 0.3 },
    { key: 'cells', label: 'Cells', value: `${motion.candidateCells} candidate → ${motion.activeCells} accepted`, ok: motion.activeCells > 0 },
    { key: 'blobs', label: 'Bodies', value: String(motion.blobCount), ok: motion.blobCount > 0 },
    // The number the room divides by to decide how many people it is willing
    // to believe in. It was a constant of 55, measured at desk range and wrong
    // by a factor of eight across a gallery, and nothing ever showed it.
    {
      key: 'scale',
      label: 'Body scale',
      value: motion.cellsPerBody === null
        ? 'still measuring — the plausibility bound is not applied yet'
        : `${motion.cellsPerBody} cells per body in this view`,
      ok: motion.cellsPerBody !== null,
    },
    { key: 'tracks', label: 'Tracks', value: `${motion.visibleTracks} live · ${motion.occludedTracks} hidden`, ok: motion.visibleTracks > 0 },
  ];

  return (
    <section className="sensing-panel" aria-label="Sensing diagnostics">
      <header className="sensing-header">
        <h2>What the machine sees</h2>
        <span className="sensing-dismiss">D to close</span>
      </header>

      <div className={`sensing-verdict ${blocked ? 'is-blocked' : findings[0]?.severity === 'warn' ? 'is-warn' : 'is-ok'}`}>
        <strong>{(blocked ?? findings[0])?.headline}</strong>
        <p>{(blocked ?? findings[0])?.fix}</p>
      </div>

      <ol className="sensing-pipeline">
        {stages.map((stage) => (
          <li key={stage.key} className={stage.ok ? 'is-ok' : 'is-stalled'} data-blocked={blocked?.stage === stage.key || undefined}>
            <span>{stage.label}</span>
            <strong>{stage.value}</strong>
          </li>
        ))}
      </ol>

      <div className="sensing-grids">
        <figure>
          <figcaption>Motion grid · {motion.width}×{motion.height} · input: {motion.source}</figcaption>
          <svg className="sensing-mask" viewBox={`0 0 ${motion.width} ${motion.height}`} preserveAspectRatio="none" aria-label="Live motion cells">
            <rect x={0} y={0} width={motion.width} height={motion.height} className="sensing-mask-bg" />
            {motion.mask.map((cell, index) => cell === 0 ? null : (
              <rect
                key={index}
                x={index % motion.width}
                y={Math.floor(index / motion.width)}
                width={1}
                height={1}
                className={cell >= 2 ? 'cell-accepted' : 'cell-candidate'}
              />
            ))}
            {tracks.map((track) => (
              <circle
                key={track.id}
                cx={track.sx * motion.width}
                cy={track.sy * motion.height}
                r={1.2}
                className={track.occluded ? 'track-hidden' : 'track-live'}
              />
            ))}
          </svg>
        </figure>

        <figure>
          <figcaption>Where tracks land on the wall · after mirror and calibration</figcaption>
          <svg className="sensing-mask" viewBox="0 0 100 56" preserveAspectRatio="none" aria-label="Track positions in projection space">
            <rect x={0} y={0} width={100} height={56} className="sensing-mask-bg" />
            {tracks.map((track) => (
              <g key={track.id}>
                <circle cx={track.x * 100} cy={track.y * 56} r={2.4} className={track.occluded ? 'track-hidden' : 'track-live'} />
                <text x={track.x * 100 + 3.5} y={track.y * 56 + 1.5} className="track-label">
                  {track.x.toFixed(2)}, {track.y.toFixed(2)}
                </text>
              </g>
            ))}
          </svg>
        </figure>
      </div>

      <figure className="sensing-audio">
        <figcaption>
          Microphone · {status.audio.running ? 'listening' : 'not running'}
          {status.audio.contextState !== 'running' ? ` · audio ${status.audio.contextState}` : ''}
          {status.audio.suppressed ? ' · held closed while the room speaks' : ''}
          {status.audio.capturing ? ' · capturing' : ''}
          {status.audio.tooLoud ? ' · too loud to register as a whisper' : ''}
        </figcaption>
        {/* Level against threshold. A silent room and a deaf one look identical
            from the outside; this is the only thing that separates them. */}
        <div className="sensing-meter" aria-label="Microphone level against the whisper threshold">
          <span className="sensing-meter-fill" style={{ width: `${Math.min(100, (status.audio.level / 0.25) * 100)}%` }} />
          <span className="sensing-meter-threshold" style={{ left: `${Math.min(100, (status.audio.threshold / 0.25) * 100)}%` }} />
        </div>
        <div className="sensing-meter-scale">
          <span>level {status.audio.level.toFixed(4)}</span>
          <span>floor {status.audio.noiseFloor.toFixed(4)} · threshold {status.audio.threshold.toFixed(4)}</span>
        </div>
      </figure>

      <button type="button" className="sensing-export" onClick={onExportLog}>
        Export sensing log · {status.sensingSamples} samples
      </button>

      <dl className="sensing-numbers">
        <div><dt>Detector</dt><dd>{motion.state}</dd></div>
        <div><dt>Frames rejected</dt><dd>{(motion.rejectedFraction * 100).toFixed(0)}%</dd></div>
        <div><dt>Light shift</dt><dd>{motion.meanLightShift.toFixed(1)}</dd></div>
        <div><dt>Sensitivity</dt><dd>{config.motionSensitivity}</dd></div>
        <div><dt>Mirrored</dt><dd>{config.mirrorCamera ? 'yes' : 'no'}</dd></div>
        <div><dt>Calibrated</dt><dd>{config.spatialCalibration.calibratedAt ? 'yes' : 'identity'}</dd></div>
        <div><dt>Renderer</dt><dd>{status.renderer}</dd></div>
        <div><dt>Memory field</dt><dd>{FIELD_WIDTH}×{FIELD_HEIGHT} · {(status.density * 100).toFixed(1)}%</dd></div>
        <div><dt>Whispers held</dt><dd>{status.audio.held}</dd></div>
        <div><dt>Whispers heard</dt><dd>{status.audio.captured} in · {status.audio.replayed} out</dd></div>
        {/*
          Why the room is not saying them. Capture and replay can both be
          working while the piece stays silent, and that combination is exactly
          what a room with nothing to say looks like — so the refusal has to be
          readable here rather than inferred from two counters that look fine.
        */}
        <div>
          <dt>Whispers recalled</dt>
          <dd>{status.audio.recall === null ? 'yes' : status.audio.recall}</dd>
        </div>
      </dl>
    </section>
  );
}
