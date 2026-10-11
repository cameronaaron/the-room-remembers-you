'use client';

import { RotateCcw, ScanLine, ScanSearch } from 'lucide-react';
import { GalleryPreflight } from '@/components/gallery-preflight';
import { commissioningKey } from '@/lib/commissioning';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import type { RoomConfig, RuntimeStatus } from '@/lib/room-types';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: RoomConfig;
  status: RuntimeStatus;
  onConfig: (patch: Partial<RoomConfig>) => void;
  onReset: () => void;
  onRelearnMotion: () => void;
  calibrationStep: number | null;
  onStartCalibration: () => void;
  onOpenDay: () => void;
  onCloseDay: () => void;
  onExportDebug: () => void;
  onReplayDebug: () => void;
  onImportDebug: (file: File) => void;
  /** Play everything the room is holding, for commissioning. */
  onAuditionWhispers: () => void;
  /** Video inputs, available only once camera access has been granted. */
  cameras: Array<{ deviceId: string; label: string }>;
};

const numberFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });

export function OperatorConsole({
  open,
  onOpenChange,
  config,
  status,
  onConfig,
  onReset,
  onRelearnMotion,
  calibrationStep,
  onStartCalibration,
  onOpenDay,
  onCloseDay,
  onExportDebug,
  onReplayDebug,
  onImportDebug,
  onAuditionWhispers,
  cameras,
}: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="operator-sheet" side="right">
        <SheetHeader className="operator-header">
          <p className="console-kicker">Room operator · O to close</p>
          <SheetTitle>Surface conditions</SheetTitle>
          <SheetDescription>
            The labels below stay inside this hidden local console.
          </SheetDescription>
        </SheetHeader>

        <div className="operator-scroll">
          <GalleryPreflight key={commissioningKey(config)} config={config} status={status}
            onRelearn={onRelearnMotion} onCalibrate={onStartCalibration} onAudition={onAuditionWhispers} />
          <section className="status-grid" aria-label="System status">
            <Status label="Camera" value={status.camera} good={status.camera === 'ready'} />
            <Status label="Microphone" value={status.microphone} good={status.microphone === 'ready'} />
            <Status label="Projection" value={status.projector} good />
            <Status label="Renderer" value={status.renderer} good />
            <Status label="Tracking" value={status.tracking ?? 'TypeScript tracking'} good />
            <Status label="Interest" value={status.interest ?? 'TypeScript interest'} good />
            <Status label="Memory field" value={status.memory ?? 'TypeScript memory field'} good />
            <Status label="Behaviours" value={status.behaviour ?? 'TypeScript behaviour'} good />
            <Status label="Random seed" value={status.seed === undefined ? '—' : String(status.seed)} good />
            <Status label="Anonymous bodies" value={String(status.people)} good />
            <Status label="Room condition" value={status.personality} good />
            <Status label="Gallery cycle" value={`day ${status.currentDay} · ${status.lifecycle}`} good />
            <Status label="Remembered forms" value={`${status.ghostCount} paths · ${status.whisperCount} sounds`} good />
            <Status label="Frame rate" value={`${numberFormat.format(status.fps)} fps`} good={status.fps >= 27} />
            <Status label="Render load" value={`${numberFormat.format(status.renderLoad)}%`} good={status.renderLoad < 85} />
            <Status label="Stored abstractions" value={formatBytes(status.storageBytes)} good />
            <Status label="Empty for" value={formatDuration(status.emptySeconds)} good />
          </section>

          <section className="console-section motion-diagnostics">
            <h3>Live motion diagnostics</h3>
            <MotionMask status={status} />
            <div className="diagnostic-grid">
              <Diagnostic label="Input" value={status.motion.source} />
              <Diagnostic label="Detector" value={status.motion.state} />
              <Diagnostic label="Changed pixels" value={`${numberFormat.format(status.motion.changedPercent)}%`} />
              <Diagnostic label="Accepted cells" value={String(status.motion.activeCells)} />
              <Diagnostic label="Blobs" value={String(status.motion.blobCount)} />
              <Diagnostic label="Tracks" value={`${status.motion.visibleTracks} live · ${status.motion.occludedTracks} hidden`} />
              <Diagnostic label="Light shift" value={numberFormat.format(status.motion.meanLightShift)} />
            </div>
            <Button variant="outline" className="console-button" onClick={onRelearnMotion}>
              <ScanSearch /> Relearn empty room
            </Button>
            <p className="control-note">White cells are accepted motion; faint cells are one-frame candidates. “Scene-change” means a room-wide image change was rejected. Keep the room empty for about one second after relearning.</p>
          </section>

          <section className="console-section">
            <h3>Memory</h3>
            <Control label="Movement sensitivity" value={config.motionSensitivity} min={8} max={64} onValue={(value) => onConfig({ motionSensitivity: value })} />
            <Control label="Scene-change limit" value={config.sceneChangeCoverage} min={0.4} max={0.99} step={0.01} onValue={(value) => onConfig({ sceneChangeCoverage: value })} />
            <p className="control-note">
              Frames that light up more than this share of the motion grid are discarded as a lighting change. Coverage, not changed pixels: one person close to the camera changes a lot of pixels but still occupies only part of the room, and only a genuine lighting change lights up nearly every cell. Press D to see the live figure.
            </p>
            <Control label="Memory half-life" value={config.memoryMinutes} min={30} max={1440} suffix=" min" onValue={(value) => onConfig({ memoryMinutes: value })} />
            <Control label="Surface intensity" value={config.visualIntensity} min={0.1} max={1} step={0.01} onValue={(value) => onConfig({ visualIntensity: value })} />
            <Control label="Forgetting time" value={config.forgettingMinutes} min={20} max={60} suffix=" min" onValue={(value) => onConfig({ forgettingMinutes: value })} />
            <Control label="Ghost frequency" value={config.ghostFrequency} min={0} max={1} step={0.01} onValue={(value) => onConfig({ ghostFrequency: value })} />
            {config.ghostFrequency === 0 && (
              <p className="control-note control-note-off">
                At zero the room never recalls a ghost on its own. Raise it to bring them back.
              </p>
            )}
          </section>

          <section className="console-section">
            <h3>Sound</h3>
            <Control label="Whisper threshold" value={config.microphoneThreshold} min={0.001} max={0.05} step={0.0005} onValue={(value) => onConfig({ microphoneThreshold: value })} />
            <p className="control-note">
              A floor, not the answer: the room measures its own noise and lifts the working threshold above it. Press D to see the measured floor and the threshold actually in force.
            </p>
            <Control label="Whisper frequency" value={config.whisperFrequency} min={0} max={1} step={0.01} onValue={(value) => onConfig({ whisperFrequency: value })} />
            {config.whisperFrequency === 0 && (
              <p className="control-note control-note-off">
                At zero the room never surfaces a whisper on its own, however many it is holding. The button below still plays them, which is why this reads as working audio and silent art.
              </p>
            )}
            <Control label="Master volume" value={config.masterVolume} min={0} max={0.7} step={0.01} onValue={(value) => onConfig({ masterVolume: value })} />
            <Button variant="outline" className="console-button" onClick={onAuditionWhispers}>
              Play remembered whispers ({status.audio.held})
            </Button>
            <p className="control-note">
              Plays actual voices captured during this session, spaced out. Recordings stay only in memory and are erased on reload, microphone shutdown, or reset. Older saved textures contain no playable voice. The microphone stays closed during playback.
            </p>
            <Toggle label="Spoken voice" note="The room says its lines aloud as well as showing them, from a voice rendered offline and committed with the work, panned to where the line appears. The microphone is held closed for exactly as long as the line lasts." checked={config.speech} onChecked={(checked) => onConfig({ speech: checked })} />
            <Toggle label="Strict privacy" note="Only a reversed loudness envelope survives, and it vanishes when the session ends." checked={config.privacyMode} onChecked={(checked) => onConfig({ privacyMode: checked })} />
          </section>

          <section className="console-section">
            <h3>Projection & camera mapping</h3>
            <Control label="Crop" value={config.crop} min={0} max={12} suffix="%" onValue={(value) => onConfig({ crop: value })} />
            <Control label="Keystone — horizontal" value={config.keystoneX} min={-12} max={12} step={0.1} suffix="°" onValue={(value) => onConfig({ keystoneX: value })} />
            <Control label="Keystone — vertical" value={config.keystoneY} min={-12} max={12} step={0.1} suffix="°" onValue={(value) => onConfig({ keystoneY: value })} />
            <Control label="Projection rotation" value={config.rotation} min={-8} max={8} step={0.1} suffix="°" onValue={(value) => onConfig({ rotation: value })} />
            <Toggle label="Mirror camera map" checked={config.mirrorCamera} onChecked={(checked) => onConfig({ mirrorCamera: checked })} />
            <label className="select-row">
              <span>Camera rotation</span>
              <select value={config.cameraRotation} onChange={(event) => onConfig({ cameraRotation: Number(event.target.value) as RoomConfig['cameraRotation'] })}>
                <option value={0}>0°</option>
                <option value={90}>90°</option>
                <option value={180}>180°</option>
                <option value={270}>270°</option>
              </select>
            </label>
            <Button variant="outline" className="console-button" onClick={onStartCalibration}>
              <ScanLine /> {calibrationStep === null ? 'Begin spatial calibration' : `Capture marker ${calibrationStep + 1} with Space`}
            </Button>
            <p className="control-note">Stand on each projected marker and press Space. Four body-to-projector pairs produce a true perspective mapping.</p>
          </section>

          <section className="console-section">
            <h3>Installation</h3>
            <Toggle label="Demo motion" note="Use pointer movement when no camera is available." checked={config.demoMode} onChecked={(checked) => onConfig({ demoMode: checked })} />
            <Toggle label="Blackout" checked={config.blackout} onChecked={(checked) => onConfig({ blackout: checked })} />
            <label className="select-row">
              <span>Camera</span>
              <select value={config.cameraDeviceId} onChange={(event) => onConfig({ cameraDeviceId: event.target.value })}>
                <option value="">System default</option>
                {cameras.map((camera) => (
                  <option key={camera.deviceId} value={camera.deviceId}>{camera.label}</option>
                ))}
              </select>
            </label>
            <p className="control-note">
              Devices are listed once camera access has been granted. A camera placed high and looking across the room tracks far better than one at desk range, where a single person fills the frame.
            </p>
            <label className="select-row">
              <span>Visual engine</span>
              <select value={config.visualEngine} onChange={(event) => onConfig({ visualEngine: event.target.value as RoomConfig['visualEngine'] })}>
                <option value="swarm">Particle field · GPU</option>
                <option value="traces">Line traces · CPU</option>
              </select>
            </label>
            <p className="control-note">
              The particle field animates both surfaces: light in a dark room, ink on a lit surface. Line traces are the fallback when WebGL2 float targets are unavailable.
            </p>
            <label className="select-row">
              <span>Graphics backend</span>
              <select value={config.rendererBackend} onChange={(event) => onConfig({ rendererBackend: event.target.value as RoomConfig['rendererBackend'] })}>
                <option value="auto">Automatic · WebGL2</option>
                <option value="webgl">WebGL2 · fragment shader</option>
                <option value="webgpu">WebGPU · compute shader</option>
              </select>
            </label>
            <p className="control-note">
              Automatic means WebGL2. The two backends draw the same field to within a fraction of a percent of the wall, but only WebGL2 has been through device-loss recovery and a gallery-length soak, so WebGPU is something to select deliberately and watch. The renderer line above says which one is actually running and why.
            </p>
            <label className="select-row">
              <span>Projection surface</span>
              <select value={config.projectionMode} onChange={(event) => onConfig({ projectionMode: event.target.value as RoomConfig['projectionMode'] })}>
                <option value="room">Dark room · projector adds light</option>
                <option value="paper">Lit surface · marks darken a bright field</option>
              </select>
            </label>
            <p className="control-note">
              Dark room is the default. The projector emits light only where the room remembers something, so it floods the space far less and the camera has much less of the artwork&rsquo;s own light to reject.
            </p>
            <label className="select-row">
              <span>Hardware profile</span>
              <select value={config.hardwareProfile} onChange={(event) => onConfig({ hardwareProfile: event.target.value as RoomConfig['hardwareProfile'] })}>
                <option value="CHEAP">CHEAP · 10 fps / 4 tracks</option>
                <option value="STANDARD">STANDARD · 15 fps / 8 tracks</option>
                <option value="FULL">FULL · 24 fps / 12 tracks</option>
              </select>
            </label>
            <label className="select-row">
              <span>Gallery simulation</span>
              <select value={config.simulationRate} onChange={(event) => onConfig({ simulationRate: Number(event.target.value) as RoomConfig['simulationRate'] })}>
                <option value={0}>Off</option>
                <option value={60}>One hour / minute</option>
                <option value={720}>Twelve hours / minute</option>
              </select>
            </label>
            <Toggle label="Record anonymous events" note="Stores coordinates, speed and occlusion only—never media." checked={config.recordDebugEvents} onChecked={(checked) => onConfig({ recordDebugEvents: checked })} />
            <div className="button-pair">
              <Button variant="outline" onClick={onReplayDebug} disabled={!status.debugEvents}>Replay events</Button>
              <Button variant="outline" onClick={onExportDebug} disabled={!status.debugEvents}>Export JSON</Button>
            </div>
            <label className="import-button">
              Import anonymous replay
              <input type="file" accept="application/json,.json" onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onImportDebug(file);
                event.target.value = '';
              }} />
            </label>
            <Control label="Automatic expiration" value={config.persistenceDays} min={1} max={30} suffix=" days" onValue={(value) => onConfig({ persistenceDays: value })} />
            <div className="button-pair">
              <Button variant="outline" onClick={onOpenDay}>Open gallery day</Button>
              <Button variant="outline" onClick={onCloseDay}>Close gallery day</Button>
            </div>
            <p className="control-note">Emergency keys: B blackout · M mute · Alt+Shift+R reset.</p>
            <p className="last-event">Last event · {status.lastEvent}</p>
            <AlertDialog>
              <AlertDialogTrigger render={<Button variant="destructive" className="console-button" />}>
                <RotateCcw /> Reset room memory
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Let the room forget everything?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently removes the memory field, anonymous paths, and transformed whisper envelopes stored on this computer.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep memory</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={onReset}>Forget everything</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MotionMask({ status }: { status: RuntimeStatus }) {
  const { width, height, mask } = status.motion;
  return (
    <svg className="motion-mask" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <rect width={width} height={height} className="motion-mask-background" />
      {mask.map((value, index) => value > 0 && (
        <rect
          key={index}
          x={index % width}
          y={Math.floor(index / width)}
          width="0.82"
          height="0.82"
          className={value === 2 ? 'motion-cell-accepted' : 'motion-cell-candidate'}
        />
      ))}
    </svg>
  );
}

function Diagnostic({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function Status({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="status-item">
      <span className={good ? 'status-dot is-good' : 'status-dot'} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Control({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onValue,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onValue: (value: number) => void;
}) {
  return (
    <label className="slider-row">
      <span>{label}</span>
      <output>{numberFormat.format(value)}{suffix}</output>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => onValue(Array.isArray(next) ? next[0] : next)}
      />
    </label>
  );
}

function Toggle({ label, note, checked, onChecked }: { label: string; note?: string; checked: boolean; onChecked: (checked: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span><strong>{label}</strong>{note && <small>{note}</small>}</span>
      <Switch checked={checked} onCheckedChange={onChecked} />
    </label>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${numberFormat.format(bytes / 1024)} KB`;
  return `${numberFormat.format(bytes / (1024 * 1024))} MB`;
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.floor(seconds)} sec`;
  return `${Math.floor(seconds / 60)} min`;
}
