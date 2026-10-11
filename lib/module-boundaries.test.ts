/**
 * The modularity standard, as a check rather than a paragraph.
 *
 * "Decisions belong in `lib/` where they can be called directly" has been in
 * the standards since the first extraction, and it held only for as long as
 * somebody remembered it. Every rule that matters is enforced by a test, a lint
 * or a contract; a standard with no executable check is a suggestion, and this
 * one had cost the room three defects that were invisible until the code that
 * held them was moved somewhere a test could reach.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Through `fileURLToPath`, not `.pathname`: a checkout under a directory with a
// space in its name comes back percent-encoded otherwise, and the check then
// passes by finding no modules at all.
const LIB = fileURLToPath(new URL('.', import.meta.url));
const COMPONENT = join(LIB, '..', 'components', 'room-installation.tsx');

const modules = readdirSync(LIB)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => name.slice(0, -3));

const suites = readdirSync(LIB)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => readFileSync(join(LIB, name), 'utf8'));

/**
 * Modules that carry no decision of the room's.
 *
 * Named individually rather than matched by pattern, so adding one is a visible
 * act. `utils.ts` is the shadcn class-name helper, which belongs to the UI
 * scaffolding rather than to the installation.
 */
const NOT_THE_ROOM_S = new Set(['utils']);

void test('every module the room thinks with is reached directly by a test', () => {
  // Transitive coverage is not the same claim. A module exercised only through
  // its callers is tested at whatever inputs they happen to produce, which is
  // exactly the position the render component put all of this in.
  const imported = new Set<string>();
  for (const source of suites) {
    for (const match of source.matchAll(/from '\.\/([a-z0-9-]+)\.ts'/g)) imported.add(match[1]);
  }
  const unreached = modules.filter((name) => !imported.has(name) && !NOT_THE_ROOM_S.has(name));
  assert.deepEqual(unreached, [], `no test imports: ${unreached.join(', ')}`);
});

void test('nothing in lib knows it is being rendered by React', () => {
  // The seam that makes all of this callable. A module that reaches for a hook,
  // a ref or a component is a module whose decisions can only be reached by
  // mounting something.
  const entangled: string[] = [];
  for (const name of modules) {
    const source = readFileSync(join(LIB, `${name}.ts`), 'utf8');
    if (/from ['"]react['"]/.test(source)) entangled.push(`${name}: react`);
    if (/from ['"](@\/components|\.\.\/components)/.test(source)) entangled.push(`${name}: components`);
  }
  assert.deepEqual(entangled, []);
});

/**
 * A ceiling on the one file that cannot be called directly.
 *
 * It ratchets: lower it when work takes something out, never raise it to make
 * room for something new. Anything that would need the ceiling raised is a
 * decision that belongs in a module, which is the whole point of the number.
 */
const RENDER_COMPONENT_CEILING = 1_195;

void test('the render component stays a render component', () => {
  const lines = readFileSync(COMPONENT, 'utf8').split('\n').length;
  assert.ok(
    lines <= RENDER_COMPONENT_CEILING,
    `room-installation.tsx is ${lines} lines against a ceiling of ${RENDER_COMPONENT_CEILING}; `
    + 'move the decision into lib/ rather than raising the ceiling',
  );
});

void test('the room\'s own logic does not live in the component any more', () => {
  // Named for what they were: each of these was arithmetic or a choice inside
  // the render tree, and each is now a module with its own tests. The check is
  // that they did not quietly come back.
  const source = readFileSync(COMPONENT, 'utf8');
  const moved: Array<[string, RegExp]> = [
    ['the recall decision tree', /\ballStill\b|createFalseMemory/],
    ['the forgetting loop', /decayStrength|trimExpired\(ghostsRef/],
    ['the frame composite', /drawRecentTrails|drawAmbient|retentionPerFrame/],
    ['keyboard command mapping', /key === 'b'|event\.code === 'Space'/],
    ['device constraints', /echoCancellation|videoinput/],
    ['the debug event ring', /debugEventsRef/],
    ['rate arithmetic', /fpsSamplesRef|analysisSamplesRef/],
  ];
  const returned = moved.filter(([, pattern]) => pattern.test(source)).map(([what]) => what);
  assert.deepEqual(returned, [], `back inside the component: ${returned.join(', ')}`);
});
