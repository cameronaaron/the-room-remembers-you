import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATTENDED_DEPOSIT_GAIN,
  EVIDENCE_WINDOW_MS,
  INTEREST_ATTACK_MS,
  INTEREST_FADE_MS,
  INTEREST_HOLD_MS,
  INTEREST_REST_MS,
  RoomAttention,
  preferMemoryNear,
} from './attention.ts';

/** Enough evidence to cross the threshold, without relying on one weight. */
function earnInterest(attention: RoomAttention, id: string, now: number) {
  attention.observe('revisit', id, now);
  attention.observe('crossing', id, now);
  attention.observe('dwell', id, now);
}

void test('a visitor who only walks through is never attended to', () => {
  const attention = new RoomAttention();
  for (let now = 0; now < 60_000; now += 1000) attention.update(['passer'], now);
  assert.equal(attention.focus(60_000), null);
  assert.equal(attention.depositScale('passer', 60_000), 1);
});

void test('dwelling, returning and crossing history earn the room\'s interest', () => {
  const attention = new RoomAttention();
  earnInterest(attention, 'a', 1000);
  attention.update(['a'], 1000);
  const focus = attention.focus(1000 + INTEREST_ATTACK_MS);
  assert.ok(focus);
  assert.equal(focus.trackId, 'a');
  assert.equal(focus.weight, 1);
});

void test('interest arrives and leaves rather than switching', () => {
  const attention = new RoomAttention();
  earnInterest(attention, 'a', 0);
  attention.update(['a'], 0);
  assert.equal(attention.focus(0)?.weight ?? 0, 0, 'nothing at the instant it begins');
  assert.ok((attention.focus(INTEREST_ATTACK_MS / 2)?.weight ?? 0) > 0.4, 'rising');
  assert.equal(attention.focus(INTEREST_ATTACK_MS + 1000)?.weight, 1, 'held');

  const fadingAt = INTEREST_ATTACK_MS + INTEREST_HOLD_MS + INTEREST_FADE_MS / 2;
  const fading = attention.focus(fadingAt)?.weight ?? 0;
  assert.ok(fading > 0.2 && fading < 0.8, `fading, got ${fading}`);
});

void test('interest dies with the track and is never handed to whoever is nearest', () => {
  const attention = new RoomAttention();
  earnInterest(attention, 'a', 0);
  attention.update(['a'], 0);
  assert.ok(attention.focus(INTEREST_ATTACK_MS));

  // They left. Somebody else is still in the room.
  attention.update(['b'], INTEREST_ATTACK_MS + 1000);
  assert.equal(attention.focus(INTEREST_ATTACK_MS + 1000), null);
  assert.equal(attention.depositScale('b', INTEREST_ATTACK_MS + 1000), 1);
});

void test('a visitor who comes back is a new presence, not a resumed one', () => {
  // The tracker mints a new id after an absence, and the room has no way to
  // know the two were the same person. Attending to them again would be a claim
  // about identity that the sensing cannot support.
  const attention = new RoomAttention();
  earnInterest(attention, 'first-visit', 0);
  attention.update(['first-visit'], 0);
  attention.update([], 1000);
  attention.update(['second-visit'], 2000);
  assert.equal(attention.focus(2000), null);
});

void test('the room spends its interest and then wants nobody for minutes', () => {
  const attention = new RoomAttention();
  earnInterest(attention, 'a', 0);
  attention.update(['a'], 0);
  const ends = INTEREST_ATTACK_MS + INTEREST_HOLD_MS + INTEREST_FADE_MS;
  attention.update(['a'], ends);
  assert.equal(attention.focus(ends), null);

  // Somebody else does everything right, immediately. The room is not looking.
  earnInterest(attention, 'b', ends + 1000);
  attention.update(['b'], ends + 1000);
  assert.equal(attention.focus(ends + 1000 + INTEREST_ATTACK_MS), null);

  const rested = ends + INTEREST_REST_MS + 1;
  earnInterest(attention, 'b', rested);
  attention.update(['b'], rested);
  assert.ok(attention.focus(rested + INTEREST_ATTACK_MS), 'the room becomes able to care again');
});

void test('simply being present for a long time is not the same as doing anything', () => {
  const attention = new RoomAttention();
  // One weak act every half-window, forever. Without expiry this accumulates
  // until everyone in a gallery eventually qualifies by standing there.
  for (let now = 0; now < EVIDENCE_WINDOW_MS * 6; now += EVIDENCE_WINDOW_MS / 2) {
    attention.observe('stillness', 'a', now);
    attention.update(['a'], now);
    assert.equal(attention.focus(now + INTEREST_ATTACK_MS), null, `attended at ${now}`);
  }
});

void test('attention biases the field slightly rather than rewriting it', () => {
  const attention = new RoomAttention();
  earnInterest(attention, 'a', 0);
  attention.update(['a'], 0);
  const scale = attention.depositScale('a', INTEREST_ATTACK_MS);
  assert.equal(scale, 1 + ATTENDED_DEPOSIT_GAIN);
  // The deposit rates were measured and deliberately left alone; this must stay
  // a fraction more from one person, not a change of regime.
  assert.ok(scale < 1.6, 'interest must not become a different room');
  assert.equal(attention.depositScale('someone-else', INTEREST_ATTACK_MS), 1);
});

void test('the room prefers to address its line to whoever it is interested in', () => {
  const attention = new RoomAttention();
  earnInterest(attention, 'a', 0);
  attention.update(['a'], 0);
  assert.equal(attention.favours('a', INTEREST_ATTACK_MS), 1);
  assert.equal(attention.favours('b', INTEREST_ATTACK_MS), 0);
  assert.equal(attention.favours(undefined, INTEREST_ATTACK_MS), 0);
});

void test('a reset leaves nothing behind', () => {
  const attention = new RoomAttention();
  earnInterest(attention, 'a', 0);
  attention.update(['a'], 0);
  attention.reset();
  assert.equal(attention.focus(INTEREST_ATTACK_MS), null);
  // And no lingering rest period either: a reset is the room starting over.
  earnInterest(attention, 'b', 100);
  attention.update(['b'], 100);
  assert.ok(attention.focus(100 + INTEREST_ATTACK_MS));
});

void test('memories reach toward the attended visitor without changing how often they surface', () => {
  const near = { path: [{ x: 0.5, y: 0.5 }, { x: 0.52, y: 0.5 }] };
  const far = { path: [{ x: 0.05, y: 0.9 }] };
  const fallback = far;
  assert.equal(preferMemoryNear([far, near], { x: 0.5, y: 0.52 }, 1, fallback), near);
  // No interest: the room's ordinary choice stands.
  assert.equal(preferMemoryNear([far, near], { x: 0.5, y: 0.52 }, 0, fallback), fallback);
});

void test('an attended visitor in an unused corner does not drag the archive over', () => {
  const elsewhere = { path: [{ x: 0.9, y: 0.1 }] };
  const fallback = { path: [{ x: 0.2, y: 0.2 }] };
  assert.equal(
    preferMemoryNear([elsewhere], { x: 0.1, y: 0.9 }, 1, fallback),
    fallback,
    'nothing is near enough to be worth choosing',
  );
});

void test('evidence expires for someone who is still standing there', () => {
  // Distinct from evidence dying with the track. The visitor never leaves; what
  // they did simply stops counting, or the room would eventually attend to
  // anybody who outlasted the window.
  const attention = new RoomAttention();
  attention.observe('revisit', 'a', 0);
  attention.observe('crossing', 'a', 0);
  attention.update(['a'], 0);
  assert.equal(attention.focus(0 + 1), null, 'not yet over the threshold');

  attention.update(['a'], EVIDENCE_WINDOW_MS + 1);
  // Those two acts have now expired, so a third cannot complete the set.
  attention.observe('dwell', 'a', EVIDENCE_WINDOW_MS + 1);
  attention.update(['a'], EVIDENCE_WINDOW_MS + 2);
  assert.equal(attention.focus(EVIDENCE_WINDOW_MS + 2 + INTEREST_ATTACK_MS), null);
});

void test('the room holds no interest and no evidence in an empty gallery', () => {
  const attention = new RoomAttention();
  attention.observe('revisit', 'a', 0);
  attention.observe('crossing', 'a', 0);
  attention.update([], 100);
  attention.update(['a'], 200);
  attention.observe('dwell', 'a', 200);
  attention.update(['a'], 300);
  assert.equal(attention.focus(300 + INTEREST_ATTACK_MS), null, 'their reasons left with them');
});

void test('an act with no track behind it is not evidence of anything', () => {
  const attention = new RoomAttention();
  // Sensing can offer an occasion before a track has an identity. Weighing it
  // anonymously would let unattributable motion qualify whoever came next.
  for (const kind of ['revisit', 'crossing', 'dwell'] as const) attention.observe(kind, '', 0);
  attention.update([''], 100);
  assert.equal(attention.focus(100 + INTEREST_ATTACK_MS), null);
  earnInterest(attention, 'a', 200);
  attention.update(['a'], 300);
  assert.ok(attention.focus(300 + INTEREST_ATTACK_MS), 'a real track still earns interest');
});

void test('interest has no weight before it began and none once it has fallen away', () => {
  const attention = new RoomAttention();
  earnInterest(attention, 'a', 1_000_000);
  attention.update(['a'], 1_000_000);
  // A clock that steps backwards — a replayed log, a corrected timestamp —
  // must read as no interest rather than as negative attention scaled up.
  assert.equal(attention.focus(999_000), null);
  assert.equal(attention.depositScale('a', 999_000), 1);
  const spell = INTEREST_ATTACK_MS + INTEREST_HOLD_MS + INTEREST_FADE_MS;
  assert.equal(attention.focus(1_000_000 + spell), null, 'the fade ends at exactly its own length');
  assert.equal(attention.focus(1_000_000 + spell + 10_000), null);
  assert.equal(attention.depositScale('a', 1_000_000 + spell), 1);
});
