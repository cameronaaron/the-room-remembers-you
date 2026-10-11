/**
 * Let a module that imports a stylesheet be imported by a test.
 *
 * The bundler turns `import './globals.css'` into a side effect on the built
 * page; Node refuses the extension outright, so any module with one in its
 * import graph — the root layout, for one — could not be reached from a test
 * at all. Resolving stylesheets to an empty module is exactly what the bundler
 * leaves behind for the JavaScript side.
 *
 * Test support, not installation code. Nothing here models CSS, and nothing
 * may assert anything about styling through it.
 */
import { register } from 'node:module';

let registered = false;

/** Register the loader once per process. Safe to call from every suite. */
export function allowStyleImports() {
  if (registered) return;
  registered = true;
  register(new URL('./style-loader.mjs', import.meta.url));
}
