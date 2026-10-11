import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_VOICE_OPTIONS,
  RoomVoice,
  UNCERTAIN_KINDS,
  usesFirstPerson,
  UTTERANCE_DROP,
  UTTERANCE_LIFETIME_MS,
  VOICE_LINES,
  type VoiceKind,
} from './room-voice.ts';
import type { BehaviorKind } from './behaviors.ts';

const KINDS = Object.keys(VOICE_LINES) as VoiceKind[];
const somewhere = { x: 0.5, y: 0.5 };
const always = () => 0;

void test('the room says "I" only when it is uncertain', () => {
  // The authorial rule the whole register rests on. Observing is impersonal;
  // the room becomes a self only at the point it stops trusting itself.
  for (const kind of KINDS) {
    const allowed = UNCERTAIN_KINDS.includes(kind);
    for (const line of VOICE_LINES[kind]) {
      if (allowed) continue;
      assert.ok(
        !usesFirstPerson(line),
        `${kind} line "${line}" speaks in the first person outside a moment of doubt`,
      );
    }
  }
});

void test('every uncertain occasion actually admits doubt somewhere', () => {
  for (const kind of UNCERTAIN_KINDS) {
    assert.ok(
      VOICE_LINES[kind].some((line) => usesFirstPerson(line)),
      `${kind} is listed as uncertain but never says "I"`,
    );
  }
});

void test('every occasion has something to say, and alternatives', () => {
  for (const kind of KINDS) {
    assert.ok(VOICE_LINES[kind].length >= 2, `${kind} would repeat itself immediately`);
    assert.equal(new Set(VOICE_LINES[kind]).size, VOICE_LINES[kind].length, `${kind} has duplicates`);
  }
});

void test('lines stay short enough to read off a wall in passing', () => {
  for (const kind of KINDS) {
    for (const line of VOICE_LINES[kind]) {
      assert.ok(line.length <= 48, `"${line}" is too long to take in while walking`);
      assert.ok(line === line.toLowerCase(), `"${line}" breaks the quiet lowercase register`);
      assert.ok(/[.]$/.test(line), `"${line}" should end in a full stop, not raise its voice`);
      assert.ok(!/[!?]/.test(line), `"${line}" exclaims or asks; the room does neither`);
    }
  }
});

void test('speech is rare: the room will not speak twice in quick succession', () => {
  const voice = new RoomVoice({ speakChance: 1, random: always });
  const first = voice.offer('stillness', 1_000, somewhere);
  assert.ok(first);
  for (let now = 1_100; now < 1_000 + DEFAULT_VOICE_OPTIONS.minGapMs; now += 2_500) {
    assert.equal(voice.offer('return', now, somewhere), null, `spoke again at ${now}`);
  }
  assert.ok(voice.offer('return', 1_000 + DEFAULT_VOICE_OPTIONS.minGapMs, somewhere));
});

void test('a line stays up for less time than the gap that follows it', () => {
  // Otherwise two lines could overlap on the wall.
  assert.ok(UTTERANCE_LIFETIME_MS < DEFAULT_VOICE_OPTIONS.minGapMs);
});

void test('the room does not repeat the same line for the same occasion', () => {
  const voice = new RoomVoice({ speakChance: 1, random: always });
  const seen: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const said = voice.offer('stillness', index * 120_000 + 1, somewhere);
    assert.ok(said);
    assert.notEqual(said.text, seen.at(-1), 'repeated itself back to back');
    seen.push(said.text);
  }
});

void test('the room sometimes declines an opportunity it is entitled to take', () => {
  const voice = new RoomVoice({ speakChance: 0.5, random: () => 0.9 });
  assert.equal(voice.offer('stillness', 500_000, somewhere), null);
});

void test('a line is placed next to its subject, inside the projection', () => {
  const voice = new RoomVoice({ speakChance: 1, random: always });
  const said = voice.offer('convergence', 1_000, { x: -3, y: 42 })!;
  assert.ok(said.x >= 0.08 && said.x <= 0.92, `x escaped the wall at ${said.x}`);
  assert.ok(said.y >= 0.1 && said.y <= 0.9, `y escaped the wall at ${said.y}`);
  const placed = voice.offer('return', 200_000, { x: 0.3, y: 0.7 })!;
  assert.ok(Math.abs(placed.x - 0.3) < 1e-9, 'a line should land where its subject is');
  // Just below it, so the line does not sit across the bright core it is about.
  assert.ok(Math.abs(placed.y - (0.7 + UTTERANCE_DROP)) < 1e-9);
  assert.ok(UTTERANCE_DROP > 0.05 && UTTERANCE_DROP < 0.2);
});

void test('the drop never pushes a line off the bottom of the wall', () => {
  const voice = new RoomVoice({ speakChance: 1, random: always });
  const low = voice.offer('stillness', 1_000, { x: 0.5, y: 0.95 })!;
  assert.ok(low.y <= 0.9, `a line at the bottom of the room escaped to ${low.y}`);
});

void test('an unknown occasion is silently ignored rather than crashing the room', () => {
  const voice = new RoomVoice({ speakChance: 1, random: always });
  assert.equal(voice.offer('nonsense' as VoiceKind, 1_000, somewhere), null);
});

void test('first-person detection is not fooled by ordinary words', () => {
  assert.ok(usesFirstPerson('i am no longer certain this happened.'));
  assert.ok(usesFirstPerson('someone was here. i may be wrong.'));
  assert.ok(!usesFirstPerson('this line is yours, twice.'));
  assert.ok(!usesFirstPerson('someone walked this line before you.'));
  // "in", "is", "this" and friends must not trip it.
  assert.ok(!usesFirstPerson('this path already existed.'));
  assert.ok(!usesFirstPerson('you have been still a while.'));
});

void test('every behaviour the room can notice, it can also speak about', () => {
  // Detecting something and having nothing to say about it is the same silence
  // as not detecting it. This is the ratchet that keeps the two in step.
  const behaviours: BehaviorKind[] = ['wave', 'approach', 'follow', 'together', 'revisit', 'mirror'];
  for (const kind of behaviours) {
    assert.ok(kind in VOICE_LINES, `${kind} is detected but never spoken about`);
    assert.ok(VOICE_LINES[kind].length >= 2, `${kind} would repeat itself`);
  }
});

void test('behaviour lines are observations, never confessions', () => {
  // Noticing what someone did is not a moment of doubt, so none of these may
  // use the first person.
  const behaviours: BehaviorKind[] = ['wave', 'approach', 'follow', 'together', 'revisit', 'mirror'];
  for (const kind of behaviours) {
    assert.ok(!UNCERTAIN_KINDS.includes(kind), `${kind} should not be an uncertain occasion`);
    for (const line of VOICE_LINES[kind]) {
      assert.ok(!usesFirstPerson(line), `${kind} line "${line}" speaks in the first person`);
    }
  }
});

/**
 * Words that claim knowledge anonymous motion cannot supply: body parts the
 * sensing never resolves, and acts of perception it cannot perform.
 */
const OVERCLAIMS = [
  'hand', 'hands', 'arm', 'arms', 'head', 'face', 'eyes', 'finger', 'leg', 'legs',
  'shoulder', 'smile', 'smiled', 'looked', 'looking', 'watched', 'stared',
  'waved', 'waving', 'gesture', 'gestured',
];

void test('no line claims knowledge the sensing cannot supply', () => {
  // The wave detector knows a still centroid whose outline keeps changing. It
  // does not know a hand did it: a coat opening or a broad stretch produces the
  // same signal. "the room saw your hand." asserted the inference as fact, and
  // by the project's own rule a behaviour announced wrongly is worse than one
  // missed — one bad call costs belief in everything else the room says.
  for (const kind of KINDS) {
    for (const line of VOICE_LINES[kind]) {
      for (const word of OVERCLAIMS) {
        assert.ok(
          !new RegExp(`\\b${word}\\b`, 'i').test(line),
          `${kind} line "${line}" claims to have seen a ${word}`,
        );
      }
    }
  }
});

void test('the wave lines describe the measurement, not an interpretation of it', () => {
  // Motion without displacement is exactly what the detector observes.
  assert.ok(VOICE_LINES.wave.includes('you moved without leaving.'));
  assert.ok(VOICE_LINES.wave.every((line) => !/hand|arm|wave/i.test(line)));
});

void test('a reset lets the room speak again straight away', () => {
  // Erasing room memory has to erase the room's memory of having spoken. The
  // rarity gate is a minute long, and a room that stays mute for the first
  // minute after a reset looks broken to the operator who just pressed it.
  const voice = new RoomVoice({ random: () => 0 });
  assert.ok(voice.offer('stillness', 1000, { x: 0.5, y: 0.5 }), 'the first line');
  assert.equal(voice.offer('stillness', 2000, { x: 0.5, y: 0.5 }), null, 'still inside the gap');
  voice.reset();
  assert.ok(voice.offer('stillness', 2001, { x: 0.5, y: 0.5 }), 'and again after a reset');
});

void test('a reset also forgets which line was last used for a kind', () => {
  // The room avoids repeating itself by remembering its last line per kind.
  // That, too, is room memory.
  const voice = new RoomVoice({ random: () => 0 });
  const first = voice.offer('return', 0, { x: 0.5, y: 0.5 })!;
  voice.reset();
  const afterReset = voice.offer('return', 1, { x: 0.5, y: 0.5 })!;
  assert.equal(afterReset.text, first.text, 'with no history, the same first choice returns');
});

void test('a kind down to its last line repeats it rather than speaking nothing', () => {
  // Every shipped kind carries at least two lines, so the repeat-avoidance
  // filter can never empty the set today. It could tomorrow, and an empty set
  // indexes to `undefined` — the room would render the word "undefined" on the
  // wall. Rarity is not worth that, so the last line is allowed to repeat.
  const only = 'you stopped.';
  const lines = { ...VOICE_LINES, stillness: [only] } as Record<VoiceKind, readonly string[]>;
  const voice = new RoomVoice({ minGapMs: 0, speakChance: 1, random: () => 0, lines });
  const first = voice.offer('stillness', 1000, { x: 0.5, y: 0.5 });
  assert.equal(first?.text, only);
  const second = voice.offer('stillness', 2000, { x: 0.5, y: 0.5 });
  assert.equal(second?.text, only, 'the room must still have something to say');
});

void test('an occasion the room has no vocabulary for is declined, not invented', () => {
  const voice = new RoomVoice({
    minGapMs: 0,
    speakChance: 1,
    random: () => 0,
    lines: { ...VOICE_LINES, wave: [] } as Record<VoiceKind, readonly string[]>,
  });
  assert.equal(voice.offer('wave', 1000, { x: 0.5, y: 0.5 }), null);
  assert.ok(voice.offer('stillness', 1000, { x: 0.5, y: 0.5 }), 'and the refusal costs no other kind its turn');
});
