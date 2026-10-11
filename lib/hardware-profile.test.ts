import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseHardwareProfile, probeMachine, type MachineCapability } from './hardware-profile.ts';
import { installDomGlobals, overrideGlobals } from './test-doubles/browser.ts';

const machine = (patch: Partial<MachineCapability> = {}): MachineCapability => ({
  cores: 8,
  renderer: '',
  floatTargets: true,
  ...patch,
});

void test('an M-series MacBook gets the largest profile', () => {
  // The machine this is developed and exhibited on. Chrome reports Apple
  // silicon through ANGLE's Metal backend.
  const chrome = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)';
  assert.equal(chooseHardwareProfile(machine({ renderer: chrome, cores: 12 })), 'FULL');
  assert.equal(chooseHardwareProfile(machine({ renderer: 'Apple M1', cores: 8 })), 'FULL');
  assert.equal(chooseHardwareProfile(machine({ renderer: 'Apple M4 Max', cores: 16 })), 'FULL');
});

void test('a machine without float render targets stays conservative', () => {
  // The particle field cannot run at all; a rich profile buys nothing.
  assert.equal(
    chooseHardwareProfile(machine({ renderer: 'Apple M3 Pro', cores: 16, floatTargets: false })),
    'CHEAP',
  );
});

void test('integrated and software renderers stay modest', () => {
  assert.equal(chooseHardwareProfile(machine({ renderer: 'Intel Iris Plus Graphics', cores: 8 })), 'STANDARD');
  assert.equal(chooseHardwareProfile(machine({ renderer: 'Intel UHD Graphics 620', cores: 4 })), 'CHEAP');
  assert.equal(chooseHardwareProfile(machine({ renderer: 'Google SwiftShader', cores: 16 })), 'STANDARD');
});

void test('an unknown GPU is judged on core count and never takes the top rung blindly', () => {
  assert.equal(chooseHardwareProfile(machine({ renderer: '', cores: 4 })), 'CHEAP');
  assert.equal(chooseHardwareProfile(machine({ renderer: '', cores: 8 })), 'STANDARD');
  assert.equal(chooseHardwareProfile(machine({ renderer: 'Mystery GPU 9000', cores: 16 })), 'FULL');
});

void test('detection is stable and never returns anything outside the three profiles', () => {
  const renderers = ['', 'Apple M2', 'Intel HD Graphics', 'NVIDIA GeForce RTX 4080', 'AMD Radeon Pro 5500M', 'llvmpipe'];
  for (const renderer of renderers) {
    for (const cores of [0, 1, 4, 8, 12, 32]) {
      const profile = chooseHardwareProfile(machine({ renderer, cores }));
      assert.ok(['CHEAP', 'STANDARD', 'FULL'].includes(profile), `${renderer}/${cores} gave ${profile}`);
      assert.equal(profile, chooseHardwareProfile(machine({ renderer, cores })), 'detection must be deterministic');
    }
  }
});

void test('a discrete GPU with few cores is still trusted', () => {
  assert.equal(chooseHardwareProfile(machine({ renderer: 'NVIDIA GeForce RTX 3070', cores: 4 })), 'FULL');
});

void test('the probe reads the unmasked renderer when the driver offers one, and the plain one otherwise', () => {
  const unmasked = installDomGlobals({ cores: 12, webgl: { floatTargets: true, renderer: 'ANGLE (Apple M3 Max)' } });
  try {
    const probed = probeMachine();
    assert.equal(probed.renderer, 'ANGLE (Apple M3 Max)');
    assert.equal(probed.cores, 12);
    assert.equal(probed.floatTargets, true);
    assert.equal(chooseHardwareProfile(probed), 'FULL');
    assert.equal(unmasked.lostContexts, 1, 'the throwaway context must not be left alive');
  } finally { unmasked.restore(); }

  // Firefox and privacy-hardened Chrome withhold WEBGL_debug_renderer_info.
  const masked = installDomGlobals({ cores: 4, webgl: { floatTargets: false, renderer: 'WebKit WebGL', debugInfo: false } });
  try {
    const probed = probeMachine();
    assert.equal(probed.renderer, 'WebKit WebGL', 'the masked string is still worth reading');
    assert.equal(probed.floatTargets, false);
  } finally { masked.restore(); }

  // Withheld *and* answering nothing: both ways of learning what this machine
  // is have failed, and the profile must be chosen without a renderer rather
  // than on the string "null".
  const silent = installDomGlobals({ cores: 4, webgl: { floatTargets: true, renderer: null, debugInfo: false } });
  try {
    assert.equal(probeMachine().renderer, '');
  } finally { silent.restore(); }
});

void test('a driver that answers nothing leaves an empty renderer rather than the word null', () => {
  // `String(null)` is "null", which matches no vendor and would sail through
  // every renderer test below as if it were an unrecognised GPU — the same
  // outcome by accident that the conservative profile reaches on purpose.
  const blank = installDomGlobals({ cores: 0, webgl: { floatTargets: true, renderer: null } });
  try {
    const probed = probeMachine();
    assert.equal(probed.renderer, '');
    assert.equal(probed.cores, 0);
    assert.equal(chooseHardwareProfile(probed), chooseHardwareProfile(machine({ renderer: '', cores: 0, floatTargets: true })));
  } finally { blank.restore(); }
});

void test('a machine with no WebGL2, no document and no navigator is still probed, not thrown at', () => {
  const noGpu = installDomGlobals({ cores: 2, webgl: null });
  try {
    assert.deepEqual(probeMachine(), { cores: 2, renderer: '', floatTargets: false });
  } finally { noGpu.restore(); }

  const hostile = installDomGlobals({ cores: 8, throwOnCreate: true });
  try {
    assert.deepEqual(probeMachine(), { cores: 8, renderer: '', floatTargets: false });
  } finally { hostile.restore(); }

  const headless = overrideGlobals({ navigator: undefined, document: undefined });
  try {
    assert.deepEqual(probeMachine(), { cores: 0, renderer: '', floatTargets: false });
  } finally { headless(); }

  const coreless = overrideGlobals({ navigator: {}, document: undefined });
  try {
    assert.equal(probeMachine().cores, 0, 'an absent hardwareConcurrency is zero cores, not NaN');
  } finally { coreless(); }
});
