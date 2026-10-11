'use client';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { HEARTBEAT_INTERVAL_MS } from '../lib/liveness';
import { COMMISSIONING_CONFIRMATIONS, galleryPreflight, type Confirmation } from '../lib/commissioning';
import type { RoomConfig, RuntimeStatus } from '../lib/room-types';

type Props = { config: RoomConfig; status: RuntimeStatus; onRelearn: () => void; onCalibrate: () => void; onAudition: () => void };

/** The parent keys this panel to the configuration, discarding all old evidence. */
export function GalleryPreflight({ config, status, onRelearn, onCalibrate, onAudition }: Props) {
  const [active, setActive] = useState(false);
  const [confirmed, setConfirmed] = useState<Partial<Record<Confirmation, boolean>>>({});
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active]);
  const checks = galleryPreflight(config, status, confirmed, Math.max(now, status.lastRenderAt ?? now, status.lastAnalysisAt ?? now));
  return <section className="console-section preflight" aria-label="Gallery commissioning">
    <label className="preflight-choice"><input type="checkbox" checked={active} onChange={event => {
      setActive(event.target.checked);
      setConfirmed({});
    }} /> Gallery preflight</label>
    <p className="control-note">Run after moving equipment. Changes to settings or a reload clear all confirmations.</p>
    {active && <>
      <output className="preflight-result">{checks.every(check => check.passed) ? 'Preflight complete' : 'Commissioning in progress'}</output>
      <p className="control-note">Live checks plus your observations in this room; this does not automatically certify the hardware.</p>
      <ul className="preflight-checks">{checks.filter(check => !(check.id in COMMISSIONING_CONFIRMATIONS)).map(check => <li key={check.id}>{check.passed ? 'Pass' : 'Pending'}: {check.instruction}</li>)}</ul>
      <div className="preflight-actions">
        <Button variant="outline" type="button" onClick={() => { setConfirmed({}); onRelearn(); }}>Relearn empty room</Button>
        <Button variant="outline" type="button" onClick={() => { setConfirmed({}); onCalibrate(); }}>Calibrate projection</Button>
        <Button variant="outline" type="button" onClick={onAudition}>Audition captured whispers</Button>
      </div>
      {Object.entries(COMMISSIONING_CONFIRMATIONS).map(([id, instruction]) => <label className="preflight-choice" key={id}>
        <input type="checkbox" checked={confirmed[id as Confirmation] === true} onChange={event => setConfirmed({ ...confirmed, [id]: event.target.checked })} /> {instruction}
      </label>)}
      <Button variant="outline" type="button" onClick={() => setConfirmed({})}>Restart commissioning</Button>
    </>}
  </section>;
}
