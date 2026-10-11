import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const version = '0.2.128';
const bindgen = process.env.WASM_BINDGEN || (existsSync(`${root}.tools/wasm-bindgen`) ? `${root}.tools/wasm-bindgen` : 'wasm-bindgen');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
const probe = spawnSync(bindgen, ['--version'], { encoding: 'utf8' });
if (probe.stdout?.trim() !== `wasm-bindgen ${version}`) {
  throw new Error(`Install wasm-bindgen-cli ${version}, or set WASM_BINDGEN to that binary. See docs/V2-RUNBOOK.md.`);
}
run('cargo', ['build', '--locked', '--release', '-p', 'room-wasm', '--target', 'wasm32-unknown-unknown']);
mkdirSync(`${root}public/wasm`, { recursive: true });
run(bindgen, ['--target', 'web', '--out-dir', 'public/wasm', 'target/wasm32-unknown-unknown/release/room_wasm.wasm']);
