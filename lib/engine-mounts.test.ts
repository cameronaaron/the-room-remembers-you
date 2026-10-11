import assert from 'node:assert/strict';
import test from 'node:test';
import { FieldRuntime, mountEngines, type Mounters } from './engine-mounts.ts';

/**
 * Stand-ins for the four real mounts.
 *
 * Each records that it was asked and hands back a `stop` that records that it
 * was called. The real mounts are tested by their own suites; what is under
 * test here is the composition — that all four are started, and that all four
 * come down.
 */
function mounters(): { spies: Mounters; started: string[]; stopped: string[] } {
  const started: string[] = [];
  const stopped: string[] = [];
  const spy = (name: string) => (search: string): (() => void) => {
    started.push(`${name}:${search}`);
    return () => { stopped.push(name); };
  };
  return {
    spies: {
      tracking: spy('tracking'),
      interest: spy('interest'),
      behaviour: spy('behaviour'),
      field: spy('field'),
    },
    started,
    stopped,
  };
}

const NOTHING = {
  tracking: () => {},
  interest: () => {},
  behaviour: () => {},
  field: new FieldRuntime(),
};

void test('every engine is started, and each reads the same query string', () => {
  const { spies, started } = mounters();
  mountEngines('?behavior=wasm', NOTHING, spies);
  assert.deepEqual(started, [
    'tracking:?behavior=wasm',
    'interest:?behavior=wasm',
    'behaviour:?behavior=wasm',
    'field:?behavior=wasm',
  ]);
});

void test('one handle retires all four', () => {
  const { spies, stopped } = mounters();
  const stop = mountEngines('', NOTHING, spies);
  assert.deepEqual(stopped, [], 'nothing comes down until it is asked to');
  stop();
  assert.deepEqual(stopped, ['tracking', 'interest', 'behaviour', 'field']);
});

/**
 * The property this module exists for.
 *
 * A cleanup that stops at the first failure leaves the rest of the room's
 * engines mounted behind an unmounted component: a WASM instance never freed,
 * a startup still in flight that will attach into a dead ref. That is a leak
 * that only shows after the tenth device reconnect of an unattended day.
 */
void test('an engine that throws on the way down does not strand the others', () => {
  const { spies, stopped } = mounters();
  const exploding: Mounters = {
    ...spies,
    interest: (search, attach) => {
      void spies.interest(search, attach);
      return () => { throw new Error('disposal failed'); };
    },
  };
  const stop = mountEngines('', NOTHING, exploding);
  stop();
  assert.deepEqual(stopped, ['tracking', 'behaviour', 'field'],
    'the three that can come down, do');
});

void test('the field is handed in rather than attached, because callers hold it', () => {
  const { spies, started } = mounters();
  const field = new FieldRuntime();
  const handed: unknown[] = [];
  const watching: Mounters = {
    ...spies,
    field: (search, runtime) => {
      handed.push(runtime);
      return spies.field(search, runtime);
    },
  };
  mountEngines('', { ...NOTHING, field }, watching);
  assert.deepEqual(handed, [field], 'the live field object, not a callback');
  assert.ok(started.includes('field:'));
});
