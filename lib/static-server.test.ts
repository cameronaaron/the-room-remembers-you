import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoomServer } from '../scripts/static-server.mjs';

void test('static server serves assets, fallback routes and HEAD without caching HTML', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gallery-server-'));
  const server = createRoomServer({ root });
  try {
    await writeFile(join(root, 'index.html'), '<main>Gallery</main>');
    await mkdir(join(root, 'room')); await writeFile(join(root, 'room/index.html'), 'Room');
    await writeFile(join(root, 'engine.wasm'), 'wasm');
    await writeFile(join(root, 'voice.wav'), 'wave'); await writeFile(join(root, 'asset.bin'), 'binary');
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const route of ['/', '/missing', '/%2e%2e%2foutside']) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 200); assert.equal(await response.text(), '<main>Gallery</main>');
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.equal(response.headers.get('permissions-policy'), 'camera=(self), microphone=(self)');
    }
    assert.equal(await (await fetch(origin + '/room/')).text(), 'Room');
    for (const [file, type] of [['engine.wasm','application/wasm'],['voice.wav','audio/wav'],['asset.bin','application/octet-stream']]) {
      const response = await fetch(origin + '/' + file, { method: 'HEAD' });
      assert.equal(response.headers.get('content-type'), type); assert.equal(await response.text(), '');
      assert.match(response.headers.get('cache-control')!, /immutable/);
    }
    assert.equal((await fetch(origin + '/%ZZ')).status, 400);
    assert.equal((await fetch(origin + '/')).status, 200, 'malformed requests must not crash the server');
    await rm(join(root, 'index.html'));
    assert.equal((await fetch(origin + '/missing')).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true }); }
});
void test('heartbeat accepts only valid bounded telemetry and reports its age without storing media', async () => {
  let now = 1000;
  const server = createRoomServer({ now: () => now });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await (await fetch(origin + '/health')).json(), { beat: null, ageMs: null });
    for (const body of ['bad JSON', '{}']) assert.equal((await fetch(origin + '/heartbeat', { method: 'POST', body })).status, 400);
    const beat = { at: 100, uptimeMs: 100, fps: 60, sensingHz: 24, tracks: 2, entered: true, engine: 'swarm' };
    assert.equal((await fetch(origin + '/heartbeat', { method: 'POST', body: JSON.stringify({ ...beat, cameraFrame: 'must not survive', microphonePCM: [1, 2, 3] }) })).status, 204);
    now += 250;
    const response = await fetch(origin + '/health');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { beat, ageMs: 250 });
    assert.equal((await fetch(origin + '/heartbeat', { method: 'POST', body: 'x'.repeat(5000) })).status, 413);
    assert.equal((await fetch(origin + '/heartbeat', { method: 'POST', body: '界'.repeat(2000) })).status, 413);
    assert.deepEqual(await (await fetch(origin + '/health')).json(), { beat, ageMs: 250 });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
void test('server CLI starts on an assigned port and reports its real listening address', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/static-server.mjs'], { env: { ...process.env, PORT: '0' }, stdio: ['ignore','pipe','pipe'] });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('server did not announce readiness')), 5000);
      let text = '';
      child.stdout.on('data', chunk => { text += String(chunk); if (text.includes('listening at')) { clearTimeout(timeout); resolve(text); } });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    const address = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//)!;
    assert.ok(address); assert.ok(Number(address[1]) > 0);
    assert.deepEqual(await (await fetch(address[0] + 'health')).json(), { beat: null, ageMs: null });
  } finally { child.kill('SIGTERM'); await exited; }
});
