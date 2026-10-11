import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, click } from './test-doubles/dom.ts';
import { createElement as h } from 'react';
import { SensingDiagnostics } from '../components/sensing-diagnostics.tsx';
import { DEFAULT_CONFIG } from './room-types.ts';
import { healthyStatus } from './test-doubles/status.ts';

void test('instrument renders anonymous cells in sensor space and tracks in calibrated space', async () => {
  const status = healthyStatus(); let exported = 0;
  const tracks = [{ id: 'a', sx: 0.25, sy: 0.5, x: 0.75, y: 0.25, occluded: false }, { id: 'b', sx: 0.5, sy: 0.5, x: 0.1, y: 0.5, occluded: true }];
  const props = { status, config: DEFAULT_CONFIG, tracks, onExportLog: () => exported++ };
  const view = await mount(h(SensingDiagnostics, { ...props, open: false }));
  try {
    assert.equal(view.container.textContent, '');
    await view.render(h(SensingDiagnostics, { ...props, open: true }));
    assert.ok(view.container.querySelector('.sensing-verdict.is-ok'));
    assert.equal(view.container.querySelectorAll('.cell-accepted').length, 1);
    assert.equal(view.container.querySelectorAll('.cell-candidate').length, 1);
    const plots = view.container.querySelectorAll('svg');
    assert.equal(plots[0].querySelector('circle')?.getAttribute('cx'), '0.75');
    assert.equal(plots[1].querySelector('circle')?.getAttribute('cx'), '75');
    assert.equal(plots[1].querySelectorAll('.track-hidden').length, 1);
    assert.equal(view.container.querySelector('img,video,canvas'), null, 'diagnostics must not display sensor imagery');
    await click(view.container.querySelector('button')); assert.equal(exported, 1);
    status.audio = { ...status.audio, running: false, contextState: 'suspended', suppressed: true, capturing: true, tooLoud: true };
    status.motion.cellsPerBody = null;
    await view.render(h(SensingDiagnostics, { ...props, open: true, config: { ...DEFAULT_CONFIG, mirrorCamera: false, spatialCalibration: { ...DEFAULT_CONFIG.spatialCalibration, calibratedAt: 1 } } }));
    for (const text of ['still measuring', 'not running', 'audio suspended', 'held closed', 'capturing', 'too loud']) assert.ok(view.container.textContent?.includes(text));
  } finally { await view.close(); }
});
void test('instrument names failed stages and distinguishes a warning from a blockage', async () => {
  const status = healthyStatus();
  const view = await mount(h(SensingDiagnostics, { open: true, status, config: DEFAULT_CONFIG, tracks: [], onExportLog: () => {} }));
  try {
    status.analysisHz = 9;
    await view.render(h(SensingDiagnostics, { open: true, status, config: DEFAULT_CONFIG, tracks: [], onExportLog: () => {} }));
    assert.ok(view.container.querySelector('.sensing-verdict.is-warn'));
    status.camera = 'failed'; status.cameraResolution = '—'; status.analysisHz = 0;
    status.motion = { ...status.motion, changedPercent: 0, activeCells: 0, blobCount: 0, visibleTracks: 0 };
    await view.render(h(SensingDiagnostics, { open: true, status, config: DEFAULT_CONFIG, tracks: [], onExportLog: () => {} }));
    assert.ok(view.container.querySelector('.sensing-verdict.is-blocked'));
    assert.match(view.container.querySelector('[data-blocked]')?.textContent ?? '', /Camera/);
  } finally { await view.close(); }
});
