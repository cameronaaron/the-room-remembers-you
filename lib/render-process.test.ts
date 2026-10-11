import assert from 'node:assert/strict';
import test from 'node:test';
import { withoutNodeInstrumentation } from '../scripts/child-environment.mjs';

void test('the renderer browser cannot inherit Node coverage instrumentation', () => {
  const original = {
    NODE_OPTIONS: '--import tsx',
    NODE_V8_COVERAGE: '/tmp/coverage',
    CHROME_BIN: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ROOM_TEST_TOKEN: 'kept',
  };

  const clean = withoutNodeInstrumentation(original);

  assert.equal(clean.NODE_OPTIONS, undefined);
  assert.equal(clean.NODE_V8_COVERAGE, undefined);
  assert.equal(clean.CHROME_BIN, original.CHROME_BIN);
  assert.equal(clean.ROOM_TEST_TOKEN, 'kept');
  assert.deepEqual(original, {
    NODE_OPTIONS: '--import tsx',
    NODE_V8_COVERAGE: '/tmp/coverage',
    CHROME_BIN: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ROOM_TEST_TOKEN: 'kept',
  }, 'building a child environment must not mutate the parent process');
});
