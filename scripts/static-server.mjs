import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHeartbeat } from '../lib/liveness.ts';

const defaultRoot = fileURLToPath(new URL('../dist/client/', import.meta.url));
const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  // The room's rendered voice. Served as octet-stream before this, which left
  // the browser to sniff 34 files the installation depends on being able to say.
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
};

/**
 * The renderer's pulse.
 *
 * Held in memory only, overwritten every few seconds, never written to disk.
 * It carries frame rate, sensing rate and a person count — aggregate numbers of
 * the same kind the sensing telemetry already records, and no coordinates.
 */
export function createRoomServer({ root = defaultRoot, now = Date.now } = {}) {
let lastBeat = null;

/** A page cannot be allowed to grow this process by posting a large body. */
const HEARTBEAT_BODY_LIMIT = 4096;

function readHeartbeat(request, response) {
  let body = '';
  let bytes = 0;
  let aborted = false;
  request.on('data', (chunk) => {
    if (aborted) return;
    bytes += chunk.length;
    body += chunk;
    if (bytes > HEARTBEAT_BODY_LIMIT) {
      aborted = true;
      response.writeHead(413).end();
      request.destroy();
    }
  });
  request.on('end', () => {
    if (aborted) return;
    let parsed = null;
    try {
      parsed = parseHeartbeat(JSON.parse(body));
    } catch {
      parsed = null;
    }
    if (!parsed) {
      response.writeHead(400).end();
      return;
    }
    lastBeat = { beat: parsed, receivedAt: now() };
    response.writeHead(204).end();
  });
}

return createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Malformed URL');
    return;
  }

  if (pathname === '/heartbeat' && request.method === 'POST') {
    readHeartbeat(request, response);
    return;
  }

  /**
   * Reported as an age rather than as a timestamp. The launcher is a separate
   * process, and handing it a wall-clock instant to subtract from its own
   * invites exactly the kind of cross-process clock assumption that is fine
   * until a machine adjusts its time mid-exhibition.
   */
  if (pathname === '/health') {
    const payload = lastBeat
      ? { beat: lastBeat.beat, ageMs: now() - lastBeat.receivedAt }
      : { beat: null, ageMs: null };
    response.setHeader('Content-Type', types['.json']);
    response.setHeader('Cache-Control', 'no-store');
    response.writeHead(200).end(JSON.stringify(payload));
    return;
  }

  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, safePath);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) file = join(root, 'index.html');
  if (!file.startsWith(root) || !existsSync(file)) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
  response.setHeader('Cache-Control', extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
  response.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  if (request.method === 'HEAD') {
    response.writeHead(200).end();
    return;
  }
  createReadStream(file).pipe(response);
});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const port = Number(process.env.PORT || 3000);
const server = createRoomServer();
server.listen(port, '127.0.0.1', () => {
  console.log(`Room renderer listening at http://127.0.0.1:${server.address().port}/`);
});
}
