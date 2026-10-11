import { build } from 'vite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withoutNodeInstrumentation } from '../child-environment.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'room-render-regression-'));
let server;
let report;
const reported = new Promise(resolve => { report = resolve; });
try {
  await build({ configFile: false, logLevel: 'error', build: {
    outDir: join(temporary, 'build'), emptyOutDir: true,
    lib: { entry: fileURLToPath(new URL('./browser.ts', import.meta.url)), formats: ['iife'], name: 'RenderRegression', fileName: () => 'test.js' },
  } });
  const script = await readFile(join(temporary, 'build/test.js'));
  server = createServer((request, response) => {
    if (request.url === '/result' && request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += chunk; if (body.length > 64000) request.destroy(); });
      request.on('end', () => { response.end(); report(body); });
      return;
    }
    response.setHeader('Content-Type', request.url === '/test.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/test.js' ? script : '<!doctype html><body>RUNNING<script src="/test.js"></script></body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const chrome = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  const output = await new Promise((resolve, reject) => {
    const child = spawn(chrome, ['--headless', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']), `--user-data-dir=${join(temporary, 'profile')}`, `http://127.0.0.1:${server.address().port}`], {
      env: withoutNodeInstrumentation(process.env),
    });
    let stderr = '';
    let result;
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.resume();
    const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 180000);
    void reported.then(value => { result = value; child.kill(); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', () => {
      clearTimeout(timeout);
      if (result !== undefined) resolve(result);
      else reject(new Error(`Chrome stopped before reporting its pixel checks: ${stderr}`));
    });
  });
  if (!output.startsWith('PASS\n')) throw new Error(output);
  // A backend that silently never ran is a gate that silently never gated.
  // `ALLOW_NO_WEBGPU=1` is for a machine that genuinely has no WebGPU; it has
  // to be said out loud rather than discovered from an absent line of output.
  const skipped = /WEBGPU-SKIPPED: (.*)/.exec(output);
  if (skipped && !process.env.ALLOW_NO_WEBGPU) {
    throw new Error(`The WebGPU renderer was not exercised: ${skipped[1]}.\n`
      + 'Set ALLOW_NO_WEBGPU=1 if this machine has no WebGPU and you accept that the backend is unchecked here.');
  }
  console.log(output.replace(/<[^>]*>/g, '').trim());
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
