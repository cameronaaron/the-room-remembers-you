import assert from 'node:assert/strict';
import test from 'node:test';
import { AttentionRuntime } from './attention-runtime.ts';
import { MemoryCollisions } from './memory-disturbance.ts';
import {
  ADMISSION_LOSS,
  DISTURBED_VOICE_PROGRESS,
  MAX_ACTIVE_RECALLS,
  RETRACE_MIN_POINTS,
  RoomEmergence,
  STILLNESS_REST_MS,
  STILLNESS_SECONDS,
  convergenceRecall,
  convergenceVoicePoint,
  hasRecallRoom,
  type EmergenceRoom,
  type WhisperAudio,
} from './room-emergence.ts';
import { RoomRng } from './room-rng.ts';
import { RECALL_PRESENTATION } from './swarm.ts';
import { DEFAULT_CONFIG, type ActiveGhost, type Ghost, type WhisperMemory } from './room-types.ts';
import { ghost, track } from './test-doubles/room.ts';

const NOW = 200_000;
const WALL = 1_700_000_000_000;

const trace = (overrides: Partial<Ghost> = {}) => ghost({ createdAt: WALL - 600_000, ...overrides });

const voice = (overrides: Partial<WhisperMemory> = {}): WhisperMemory => ({
  id: 'whisper', createdAt: WALL - 600_000, lastReplayedAt: 0, duration: 1, envelope: [0.3],
  brightness: 0.5, position: { x: 0.5, y: 0.5 }, strength: 0.6, fidelity: 1, recallCount: 0,
  lineage: ['whisper'], day: 1, ...overrides,
});

/** A room where nothing is due, so each test turns on exactly one thing. */
const quiet = (overrides: Partial<EmergenceRoom> = {}): EmergenceRoom => ({
  tracks: [],
  ghosts: [],
  whispers: [],
  active: [],
  config: DEFAULT_CONFIG,
  day: 1,
  lifecycle: 'active',
  emptySeconds: 0,
  now: NOW,
  wall: WALL,
  attention: new AttentionRuntime(),
  collisions: new MemoryCollisions(),
  audio: null,
  // Nothing rolls unless a test says so; the branches under test are the ones
  // that do not depend on chance.
  random: () => 1,
  ...overrides,
});

/**
 * The first tick of a session banks no elapsed time, so nothing that depends on
 * a roll can happen on it. Branches that roll are reached from the second tick
 * onwards, which is what this arranges.
 */
function afterFirstTick(emergence: RoomEmergence, room: EmergenceRoom) {
  emergence.detect({ ...room, active: [], tracks: [], now: room.now - 1_000, random: () => 1 });
  return emergence.detect(room);
}

const recordingAudio = (): WhisperAudio & { played: Array<{ id: string; loss?: number }> } => {
  const played: Array<{ id: string; loss?: number }> = [];
  return {
    played,
    hasRecording: () => true,
    replay: (whisper, _volume, loss) => played.push({ id: whisper.id, loss }),
  };
};

void test('a capped room cannot start another recall', () => {
  // One at a time made the room feel like it had a single thought; unbounded
  // made it a slideshow. Both are failures of the same decision.
  const room = quiet({
    ghosts: [trace()],
    tracks: [track({ stillFor: STILLNESS_SECONDS + 5 })],
    active: Array.from({ length: MAX_ACTIVE_RECALLS }, (_unused, index) => ({
      ghost: trace({ id: `active-${index}` }), startedAt: NOW, kind: 'ghost' as const,
    })),
    random: () => 0,
  });
  const outcome = new RoomEmergence().detect(room);
  assert.equal(room.active.length, MAX_ACTIVE_RECALLS);
  assert.equal(outcome.event, undefined);
});

void test('the roll clock advances even when the room cannot act on it', () => {
  // Banking the elapsed time while recalls are capped fires a burst the moment
  // a slot frees, which reads as the room having saved them up.
  const emergence = new RoomEmergence();
  const full = quiet({
    ghosts: [trace()],
    active: [{ ghost: trace({ id: 'a' }), startedAt: NOW, kind: 'ghost' }, { ghost: trace({ id: 'b' }), startedAt: NOW, kind: 'ghost' }, { ghost: trace({ id: 'c' }), startedAt: NOW, kind: 'ghost' }],
    random: () => 0.5,
  });
  emergence.detect(full);
  // Ten minutes later, with one slot free and a roll that only succeeds on
  // banked time: nothing may have accumulated.
  const rolls: number[] = [];
  const freed = quiet({
    ghosts: [trace()],
    now: NOW + 600_000,
    random: () => { rolls.push(1); return 1; },
  });
  emergence.detect(freed);
  assert.ok(rolls.length > 0, 'the roll still happens');
});

void test('an opening or closing room keeps its ritual to itself', () => {
  for (const lifecycle of ['opening', 'closing'] as const) {
    const room = quiet({
      lifecycle,
      ghosts: [trace()],
      tracks: [track({ stillFor: STILLNESS_SECONDS + 5 })],
      random: () => 0,
    });
    const outcome = new RoomEmergence().detect(room);
    assert.equal(outcome.event, undefined, lifecycle);
    assert.equal(room.active.length, 0, lifecycle);
  }
});

void test('everyone standing still surfaces the oldest thing the room has', () => {
  // The room's answer to a held silence is the furthest thing back it holds,
  // not whatever is freshest.
  const room = quiet({
    ghosts: [trace({ id: 'recent', createdAt: WALL - 1_000 }), trace({ id: 'oldest', createdAt: WALL - 9_000_000 })],
    tracks: [track({ stillFor: STILLNESS_SECONDS })],
  });
  const outcome = new RoomEmergence().detect(room);
  assert.equal(room.active[0].kind, 'stillness');
  assert.equal(room.active[0].ghost.id, 'oldest');
  assert.match(outcome.event!, /stillness/);
  assert.deepEqual(outcome.utterances.map((said) => said.kind), ['stillness']);
});

void test('one person still among a moving crowd is not a still room', () => {
  const room = quiet({
    ghosts: [trace()],
    tracks: [track({ id: 'a', stillFor: STILLNESS_SECONDS + 10 }), track({ id: 'b', stillFor: 0 })],
  });
  new RoomEmergence().detect(room);
  assert.ok(room.active.every((active) => active.kind !== 'stillness'));
});

void test('an empty room is not a still one', () => {
  // Nobody is there to hold the silence, and the empty-room branch is the one
  // that belongs to that condition.
  const room = quiet({ ghosts: [trace()], tracks: [] });
  new RoomEmergence().detect(room);
  assert.equal(room.active.length, 0);
});

void test('a room with nothing to remember answers a silence with silence', () => {
  // Opening morning: everybody standing still in front of a room whose memory
  // was just erased. There is nothing to surface, and the branch must decline
  // rather than reach into an empty list.
  const room = quiet({ ghosts: [], tracks: [track({ stillFor: STILLNESS_SECONDS + 5 })] });
  const outcome = new RoomEmergence().detect(room);
  assert.equal(room.active.length, 0);
  assert.equal(outcome.event, undefined);
});

void test('walking a long path without doubling back is not a retrace', () => {
  // Far enough to pass the extent guard, and never repeated. This is the
  // ordinary case — most visitors cross a room once.
  const path = Array.from({ length: RETRACE_MIN_POINTS + 6 }, (_unused, index) => ({
    x: 0.05 + index * 0.03, y: 0.2 + index * 0.02, t: index * 100,
  }));
  const room = quiet({ tracks: [track({ path })] });
  new RoomEmergence().detect(room);
  assert.equal(room.active.length, 0);
});

void test('a false memory can be made with no voice to attach to it', () => {
  // Whispers are the rarer material. A room that had never been spoken in
  // could otherwise never fabricate anything.
  const room = quiet({ ghosts: [trace({ id: 'a' }), trace({ id: 'b' })], whispers: [], random: () => 0 });
  afterFirstTick(new RoomEmergence(), room);
  assert.equal(room.active[0].kind, 'false');
});

void test('stillness rests before it can happen again', () => {
  const emergence = new RoomEmergence();
  const standing = () => quiet({
    ghosts: [trace()],
    tracks: [track({ stillFor: STILLNESS_SECONDS })],
  });
  const first = standing();
  emergence.detect(first);
  assert.equal(first.active.length, 1);
  const tooSoon = standing();
  tooSoon.now = NOW + STILLNESS_REST_MS;
  emergence.detect(tooSoon);
  assert.ok(
    tooSoon.active.every((active) => active.kind !== 'stillness'),
    'the rest is inclusive of its own boundary',
  );
  const later = standing();
  later.now = NOW + STILLNESS_REST_MS + 1;
  emergence.detect(later);
  assert.equal(later.active[0].kind, 'stillness');
});

void test('retracing a path brings the earlier half back ahead of its visitor', () => {
  const path = Array.from({ length: RETRACE_MIN_POINTS + 4 }, (_unused, index) => {
    const half = Math.floor((RETRACE_MIN_POINTS + 4) / 2);
    const along = index < half ? index / half : (index - half) / half;
    return { x: 0.1 + along * 0.8, y: 0.5, t: index * 100 };
  });
  const room = quiet({ tracks: [track({ path })] });
  const outcome = new RoomEmergence().detect(room);
  assert.equal(room.active[0].kind, 'return');
  assert.ok(room.active[0].startedAt > room.now, 'the path appears ahead of them, not under them');
  assert.match(outcome.event!, /return/);
});

void test('standing in one place is not retracing a path', () => {
  // A stationary visitor accumulates path points at one spot, so the two halves
  // match perfectly and read as a perfect retrace.
  const path = Array.from({ length: RETRACE_MIN_POINTS + 4 }, (_unused, index) => ({
    x: 0.5, y: 0.5, t: index * 100,
  }));
  const room = quiet({ tracks: [track({ path, stillFor: 0 })] });
  new RoomEmergence().detect(room);
  assert.equal(room.active.length, 0);
});

void test('a path too short to have two halves is not compared', () => {
  const path = Array.from({ length: RETRACE_MIN_POINTS - 1 }, (_unused, index) => ({
    x: 0.1 + index * 0.03, y: 0.5, t: index * 100,
  }));
  const room = quiet({ tracks: [track({ path })] });
  new RoomEmergence().detect(room);
  assert.equal(room.active.length, 0);
});

void test('a false memory needs two real ones to be made from', () => {
  const alone = quiet({ ghosts: [trace()], random: () => 0 });
  afterFirstTick(new RoomEmergence(), alone);
  assert.notEqual(alone.active[0]?.kind, 'false');
  assert.equal(alone.ghosts.length, 1, 'nothing was fabricated from a single trace');
});

void test('a false memory joins two unrelated traces and is kept', () => {
  const room = quiet({
    ghosts: [trace({ id: 'a' }), trace({ id: 'b' })],
    whispers: [voice()],
    random: () => 0,
  });
  const outcome = afterFirstTick(new RoomEmergence(), room);
  assert.equal(room.active[0].kind, 'false');
  assert.equal(room.ghosts.length, 3, 'the room now believes it');
  assert.ok(room.ghosts.at(-1)!.falseMemory);
  assert.match(outcome.event!, /false memory/);
});

void test('an empty room remembers more often than an occupied one', () => {
  // Same seed, same memories: only the emptiness differs.
  // A roll of 0.05 over one second: above the ordinary chance of 0.024, below
  // the empty room's 0.072. The same draw reaches one room and not the other.
  const occupied = quiet({ ghosts: [trace()], emptySeconds: 0, random: () => 0.05 });
  const empty = quiet({ ghosts: [trace()], emptySeconds: 600, random: () => 0.05 });
  afterFirstTick(new RoomEmergence(), occupied);
  afterFirstTick(new RoomEmergence(), empty);
  assert.equal(empty.active.length, 1, 'the same roll reaches the empty room');
  assert.equal(empty.active[0].kind, 'empty');
  assert.equal(occupied.active.length, 0, 'and not the occupied one');
});

void test('an ordinary recall happens without a word', () => {
  // The room speaks rarely. A memory surfacing is not an occasion for it.
  const room = quiet({ ghosts: [trace()], random: () => 0 });
  const outcome = afterFirstTick(new RoomEmergence(), room);
  assert.equal(room.active[0].kind, 'ghost');
  assert.deepEqual(outcome.utterances, []);
  assert.match(outcome.event!, /old path/);
});

void test('a crossing is considered last, so a crowd does not starve the room', () => {
  // Ahead of the other branches this returned first on every eligible tick, and
  // crowded periods — exactly when people cross history most — lost stillness,
  // retrace and false memory entirely.
  const crossing = track({
    id: 'crosser',
    previous: { x: 0.15, y: 0.3, t: NOW - 200 },
    position: { x: 0.5, y: 0.55, t: NOW },
    stillFor: STILLNESS_SECONDS + 1,
  });
  const room = quiet({ ghosts: [trace()], tracks: [crossing] });
  new RoomEmergence().detect(room);
  assert.equal(room.active[0]?.kind, 'stillness', 'stillness must win the tick');
});

void test('a disturbed memory brings a nearby voice with it, once', () => {
  const audio = recordingAudio();
  const disturbed: ActiveGhost = {
    ghost: trace(),
    startedAt: NOW - RECALL_PRESENTATION.ghost.durationMs * DISTURBED_VOICE_PROGRESS - 10,
    kind: 'ghost',
    disturbance: { loss: 0.5, at: { x: 0.5, y: 0.5 }, voicePlayed: false, admitted: false },
  };
  const room = quiet({ whispers: [voice()], active: [disturbed], audio });
  new RoomEmergence().detect(room);
  assert.equal(audio.played.length, 1);
  assert.equal(audio.played[0].loss, 0.5, 'the voice is degraded by the same loss the image is');
  new RoomEmergence().detect(room);
  assert.equal(audio.played.length, 1, 'a latched occasion does not repeat');
});

void test('a voice recorded across the room is not part of this memory', () => {
  const audio = recordingAudio();
  const room = quiet({
    whispers: [voice({ position: { x: 0.95, y: 0.05 } })],
    active: [{
      ghost: trace(),
      startedAt: NOW - RECALL_PRESENTATION.ghost.durationMs * DISTURBED_VOICE_PROGRESS - 10,
      kind: 'ghost',
      disturbance: { loss: 0.5, at: { x: 0.1, y: 0.9 }, voicePlayed: false, admitted: false },
    }],
    audio,
  });
  new RoomEmergence().detect(room);
  assert.equal(audio.played.length, 0);
});

void test('a memory being lost quietly is not admitted to', () => {
  // The room admits to forgetting only when there is something to admit.
  const barely: ActiveGhost = {
    ghost: trace(),
    startedAt: NOW - RECALL_PRESENTATION.ghost.durationMs * 0.95,
    kind: 'ghost',
    disturbance: { loss: ADMISSION_LOSS, at: { x: 0.5, y: 0.5 }, voicePlayed: true, admitted: false },
  };
  const room = quiet({ active: [barely] });
  const outcome = new RoomEmergence().detect(room);
  assert.deepEqual(outcome.utterances, []);
});

void test('a memory dissolving badly is admitted to, once, near the end', () => {
  const dissolving: ActiveGhost = {
    ghost: trace(),
    startedAt: NOW - RECALL_PRESENTATION.ghost.durationMs * 0.95,
    kind: 'ghost',
    disturbance: { loss: 0.9, at: { x: 0.3, y: 0.7 }, voicePlayed: true, admitted: false },
  };
  const room = quiet({ active: [dissolving] });
  const outcome = new RoomEmergence().detect(room);
  assert.deepEqual(outcome.utterances.map((said) => said.kind), ['forgetting']);
  assert.deepEqual(outcome.utterances[0].at, { x: 0.3, y: 0.7 });
  assert.ok(dissolving.disturbance!.admitted);
  assert.deepEqual(new RoomEmergence().detect(room).utterances, []);
});

void test('an undisturbed recall has nothing to progress', () => {
  const room = quiet({ active: [{ ghost: trace(), startedAt: NOW - 1_000, kind: 'ghost' }] });
  assert.deepEqual(new RoomEmergence().detect(room).utterances, []);
});

void test('a reset room is not still resting from the last visitor', () => {
  const emergence = new RoomEmergence();
  const standing = () => quiet({ ghosts: [trace()], tracks: [track({ stillFor: STILLNESS_SECONDS })] });
  const first = standing();
  emergence.detect(first);
  assert.equal(first.active.length, 1);
  emergence.reset();
  const after = standing();
  emergence.detect(after);
  assert.equal(after.active.length, 1);
});

void test('convergence waits for a slot rather than pushing past the cap', () => {
  const held = [trace({ id: 'a' })];
  const full: ActiveGhost[] = Array.from({ length: MAX_ACTIVE_RECALLS }, (_unused, index) => ({
    ghost: trace({ id: `x${index}` }), startedAt: NOW, kind: 'ghost',
  }));
  assert.equal(hasRecallRoom(full), false);
  assert.equal(convergenceRecall(held[0], held, full, NOW), null);
  const recall = convergenceRecall(held[0], held, [], NOW);
  assert.equal(recall?.kind, 'convergence');
  assert.ok(recall!.ghost.recallCount > 0);
});

void test('a capped room still reports what its dissolving memories are saying', () => {
  // The cap is on starting new recalls, not on the ones already running. A
  // `return { }` here loses the room's admission that it is forgetting
  // something, which is the one line it says about its own failure.
  const dissolving: ActiveGhost = {
    ghost: trace(),
    startedAt: NOW - RECALL_PRESENTATION.ghost.durationMs * 0.95,
    kind: 'ghost',
    disturbance: { loss: 0.9, at: { x: 0.4, y: 0.6 }, voicePlayed: true, admitted: false },
  };
  const room = quiet({
    active: [dissolving, { ghost: trace({ id: 'b' }), startedAt: NOW, kind: 'ghost' }, { ghost: trace({ id: 'c' }), startedAt: NOW, kind: 'ghost' }],
    ghosts: [trace()],
    tracks: [track({ stillFor: STILLNESS_SECONDS + 5 })],
  });
  const outcome = new RoomEmergence().detect(room);
  assert.deepEqual(outcome.utterances.map((said) => said.kind), ['forgetting']);
});

void test('a closed room still reports its dissolving memories', () => {
  const dissolving: ActiveGhost = {
    ghost: trace(),
    startedAt: NOW - RECALL_PRESENTATION.ghost.durationMs * 0.95,
    kind: 'ghost',
    disturbance: { loss: 0.9, at: { x: 0.4, y: 0.6 }, voicePlayed: true, admitted: false },
  };
  const room = quiet({ lifecycle: 'closing', active: [dissolving] });
  assert.deepEqual(new RoomEmergence().detect(room).utterances.map((said) => said.kind), ['forgetting']);
});

void test('an admission and a new recall in the same tick are both reported', () => {
  // The two are independent: one is a memory ending, the other a memory
  // beginning, and dropping either leaves the room half-narrated.
  const dissolving: ActiveGhost = {
    ghost: trace({ id: 'dissolving' }),
    startedAt: NOW - RECALL_PRESENTATION.ghost.durationMs * 0.95,
    kind: 'ghost',
    disturbance: { loss: 0.9, at: { x: 0.4, y: 0.6 }, voicePlayed: true, admitted: false },
  };
  const room = quiet({
    active: [dissolving],
    ghosts: [trace()],
    tracks: [track({ stillFor: STILLNESS_SECONDS + 5 })],
  });
  const outcome = new RoomEmergence().detect(room);
  assert.deepEqual(outcome.utterances.map((said) => said.kind), ['forgetting', 'stillness']);
  assert.equal(outcome.event, 'stillness — an old trace surfaced');
});

void test('one recall short of the cap is still a room that can remember', () => {
  const room = quiet({
    ghosts: [trace()],
    tracks: [track({ stillFor: STILLNESS_SECONDS + 5 })],
    active: Array.from({ length: MAX_ACTIVE_RECALLS - 1 }, (_unused, index) => ({
      ghost: trace({ id: `active-${index}` }), startedAt: NOW, kind: 'ghost' as const,
    })),
  });
  new RoomEmergence().detect(room);
  assert.equal(room.active.length, MAX_ACTIVE_RECALLS);
  assert.equal(room.active.at(-1)!.kind, 'stillness');
});

void test('a crossing disturbs the memory it walked into', () => {
  // The branch the room reaches most often in a busy gallery, and the only one
  // that both recalls a memory and begins losing it at the same time.
  const crosser = track({
    id: 'crosser',
    previous: { x: 0.15, y: 0.3, t: NOW - 200 },
    position: { x: 0.5, y: 0.55, t: NOW },
  });
  const room = quiet({ ghosts: [trace()], tracks: [crosser] });
  const outcome = new RoomEmergence().detect(room);
  assert.equal(outcome.event, 'a crossing disturbed an old path');
  const started = room.active[0];
  assert.equal(started.kind, 'ghost');
  assert.equal(started.startedAt, NOW);
  assert.ok(started.disturbance, 'a crossing without a disturbance is an ordinary recall');
  assert.equal(started.disturbance!.voicePlayed, false);
  assert.equal(started.disturbance!.admitted, false);
  assert.ok(started.disturbance!.loss >= 0 && started.disturbance!.loss <= 1);
  // The memory resumes from where it was walked into, not from its beginning.
  assert.equal(started.ghost.path[0].x, started.disturbance!.at.x);
  assert.equal(started.ghost.path[0].y, started.disturbance!.at.y);
  assert.equal(started.ghost.path[0].t, WALL);
  assert.ok(started.ghost.path.length > 1, 'the rest of the path has to follow');
  assert.ok(started.ghost.recallCount > 0, 'a crossing is a recall of that memory');
});

void test('a crossing makes the room take an interest in whoever crossed', () => {
  const crosser = track({
    id: 'crosser',
    previous: { x: 0.15, y: 0.3, t: NOW - 200 },
    position: { x: 0.5, y: 0.55, t: NOW },
  });
  const attention = new AttentionRuntime();
  const room = quiet({ ghosts: [trace()], tracks: [crosser], attention });
  new RoomEmergence().detect(room);
  // Weaker than anything the visitor chose to do — the coincidence is the
  // room's, not theirs — so on its own it never earns a spell. What it must do
  // is be filed, about the right person, and be worth less than the threshold.
  attention.update([crosser], NOW);
  assert.equal(attention.decision().trackId, null, 'a crossing alone is not interest');
});

void test('nobody crossing anything leaves the room quiet', () => {
  const room = quiet({ ghosts: [trace()], tracks: [track({ id: 'still', stillFor: 0 })], now: NOW });
  const emergence = new RoomEmergence();
  emergence.detect(room);
  const away = quiet({
    ghosts: [trace()],
    tracks: [track({
      id: 'far',
      previous: { x: 0.02, y: 0.95, t: NOW - 200 },
      position: { x: 0.04, y: 0.96, t: NOW },
    })],
  });
  const outcome = new RoomEmergence().detect(away);
  assert.equal(outcome.event, undefined);
  assert.equal(away.active.length, 0);
});

void test('the path a retrace surfaces is the visitor\'s own, marked as theirs', () => {
  const path = Array.from({ length: RETRACE_MIN_POINTS + 4 }, (_unused, index) => {
    const half = Math.floor((RETRACE_MIN_POINTS + 4) / 2);
    const along = index < half ? index / half : (index - half) / half;
    return { x: 0.1 + along * 0.8, y: 0.5, t: index * 100 };
  });
  const room = quiet({ tracks: [track({ id: 'walker', path })], day: 4 });
  new RoomEmergence().detect(room);
  const returned = room.active[0].ghost;
  assert.equal(returned.id, 'return-walker');
  assert.deepEqual(returned.lineage, ['walker']);
  assert.equal(returned.falseMemory, false, 'they really did walk it');
  assert.equal(returned.day, 4);
  assert.equal(returned.createdAt, WALL);
  assert.ok(returned.fidelity > 0.9, 'it happened seconds ago; nothing has been lost yet');
  assert.ok(returned.path.length > 1);
  // Not pushed into the room's memory: it is a presentation of something still
  // happening, and the track will be captured as a ghost when it ends.
  assert.equal(room.ghosts.length, 0);
});

void test('a retrace is measured against the whole path, not the last few steps', () => {
  // One point short is not a retrace; the exact minimum is.
  const walk = (points: number) => Array.from({ length: points }, (_unused, index) => {
    const half = Math.floor(points / 2);
    const along = index < half ? index / half : (index - half) / half;
    return { x: 0.1 + along * 0.8, y: 0.5, t: index * 100 };
  });
  const short = quiet({ tracks: [track({ path: walk(RETRACE_MIN_POINTS - 1) })] });
  new RoomEmergence().detect(short);
  assert.equal(short.active.length, 0);
  const exact = quiet({ tracks: [track({ path: walk(RETRACE_MIN_POINTS) })] });
  new RoomEmergence().detect(exact);
  assert.equal(exact.active[0].kind, 'return');
});

void test('a false memory is made from two different traces', () => {
  const room = quiet({
    ghosts: [trace({ id: 'a' }), trace({ id: 'b' })],
    whispers: [voice()],
    random: () => 0,
  });
  afterFirstTick(new RoomEmergence(), room);
  const fabricated = room.ghosts.at(-1)!;
  assert.ok(fabricated.falseMemory);
  // Both parents in the lineage: a memory joined to itself is not a confusion
  // of two things, it is the same path shown twice.
  assert.ok(fabricated.lineage.length >= 2, `lineage was ${fabricated.lineage.join(', ')}`);
  assert.equal(new Set(fabricated.lineage).size, fabricated.lineage.length);
});

void test('every branch names what happened in the room\'s own words', () => {
  // The status line is what an operator reads to tell one kind of event from
  // another. Two branches sharing a sentence is an instrument that cannot
  // distinguish them.
  const said = new Set<string>();
  const stillness = quiet({ ghosts: [trace()], tracks: [track({ stillFor: STILLNESS_SECONDS })] });
  said.add(new RoomEmergence().detect(stillness).event!);
  const retracing = quiet({
    tracks: [track({
      path: Array.from({ length: RETRACE_MIN_POINTS + 4 }, (_unused, index) => {
        const half = Math.floor((RETRACE_MIN_POINTS + 4) / 2);
        const along = index < half ? index / half : (index - half) / half;
        return { x: 0.1 + along * 0.8, y: 0.5, t: index * 100 };
      }),
    })],
  });
  said.add(new RoomEmergence().detect(retracing).event!);
  const fabricating = quiet({ ghosts: [trace({ id: 'a' }), trace({ id: 'b' })], random: () => 0 });
  said.add(afterFirstTick(new RoomEmergence(), fabricating).event!);
  const ordinary = quiet({ ghosts: [trace()], random: () => 0 });
  said.add(afterFirstTick(new RoomEmergence(), ordinary).event!);
  const alone = quiet({ ghosts: [trace()], emptySeconds: 600, random: () => 0 });
  said.add(afterFirstTick(new RoomEmergence(), alone).event!);
  const crossed = quiet({
    ghosts: [trace()],
    tracks: [track({ previous: { x: 0.15, y: 0.3, t: NOW - 200 }, position: { x: 0.5, y: 0.55, t: NOW } })],
  });
  said.add(new RoomEmergence().detect(crossed).event!);
  assert.equal(said.size, 6, `branches share a line: ${[...said].join(' / ')}`);
  for (const line of said) assert.ok(line.length > 8 && line === line.toLowerCase());
});

void test('a room two minutes empty is not yet a room walking alone', () => {
  const emptySeconds = 120;
  const boundary = quiet({ ghosts: [trace()], emptySeconds, random: () => 0.05 });
  afterFirstTick(new RoomEmergence(), boundary);
  assert.equal(boundary.active.length, 0, 'the boundary is exclusive');
  const past = quiet({ ghosts: [trace()], emptySeconds: emptySeconds + 1, random: () => 0.05 });
  afterFirstTick(new RoomEmergence(), past);
  assert.equal(past.active[0].kind, 'empty');
});

void test('an empty room says its line at the start of the path it is walking', () => {
  const room = quiet({ ghosts: [trace()], emptySeconds: 600, random: () => 0 });
  const outcome = afterFirstTick(new RoomEmergence(), room);
  assert.deepEqual(outcome.utterances.map((said) => said.kind), ['empty']);
  assert.deepEqual(outcome.utterances[0].at, room.active[0].ghost.path[0]);
});

void test('the room reaches toward whoever it is interested in', () => {
  // Which memory surfaces, never how often one does. The near memory has to be
  // chosen more often than an unattended room would choose it.
  const near = () => trace({ id: 'near', path: [{ x: 0.5, y: 0.5, t: 0 }, { x: 0.52, y: 0.5, t: 1 }] });
  const far = () => trace({ id: 'far', path: [{ x: 0.02, y: 0.02, t: 0 }, { x: 0.04, y: 0.02, t: 1 }] });
  const attended = track({ id: 'watched', position: { x: 0.5, y: 0.5, t: NOW } });

  /** Interest takes time to build: evidence, then the attack curve. */
  const interested = () => {
    const attention = new AttentionRuntime();
    // Two strong acts and a weak one, which is what the threshold asks for.
    // Dwelling and stillness are the gate's to file, from the track itself.
    attention.observe('revisit', 'watched', NOW - 30_000);
    attention.observe('crossing', 'watched', NOW - 30_000);
    const dwelling = track({ id: 'watched', dwellSeconds: 40, stillFor: 20 });
    attention.update([dwelling], NOW - 20_000);
    attention.update([dwelling], NOW);
    assert.ok(attention.decision().weight, 'the fixture failed to make the room interested');
    return attention;
  };

  // A real stream rather than a constant, because `chooseRareGhost` now draws
  // from the room's own generator. Under a constant "random" the unattended
  // leg would pick the same memory every time and this would compare a
  // deterministic choice against a deterministic choice.
  const chosen = (attention: AttentionRuntime, seed: number) => {
    const room = quiet({
      ghosts: [near(), far()],
      tracks: [attended],
      attention,
      random: new RoomRng(seed).draw,
      // A room that remembers constantly, so most runs reach the choice rather
      // than the rate gate. This test is about *which* memory surfaces; how
      // often one does is measured by the burn-in, at the real frequency.
      config: { ...DEFAULT_CONFIG, ghostFrequency: 40 },
    });
    afterFirstTick(new RoomEmergence(), room);
    return room.active[0]?.ghost.id;
  };

  let reached = 0;
  let indifferent = 0;
  let comparable = 0;
  for (let run = 0; run < 200; run += 1) {
    // Both legs are given the same seed, so they gate on the same draws and
    // surface on exactly the same runs. What differs is the choice. A run that
    // fabricated a memory instead, or surfaced nothing, is not a choice
    // between these two and is left out of both counts.
    const attended_to = chosen(interested(), run);
    const unattended = chosen(new AttentionRuntime(), run);
    const held = (id: string | undefined) => id === 'near' || id === 'far';
    if (!held(attended_to) || !held(unattended)) continue;
    comparable += 1;
    if (attended_to === 'near') reached += 1;
    if (unattended === 'near') indifferent += 1;
  }
  assert.ok(comparable > 20, `only ${comparable} of 200 runs offered a choice to make`);
  assert.equal(reached, comparable, 'an interested room must always reach for the near memory');
  assert.ok(reached > indifferent, `interest changed nothing: ${reached} against ${indifferent}`);
});

void test('a disturbed voice is written back over the one the room was holding', () => {
  // Nothing recalled remains unchanged. Replaying without writing the mutation
  // back gives the room a voice that degrades on playback and resets every time.
  const audio = recordingAudio();
  const held = voice({ recallCount: 0 });
  const room = quiet({
    whispers: [held],
    active: [{
      ghost: trace(),
      startedAt: NOW - RECALL_PRESENTATION.ghost.durationMs * DISTURBED_VOICE_PROGRESS - 10,
      kind: 'ghost',
      disturbance: { loss: 0.5, at: { x: 0.5, y: 0.5 }, voicePlayed: false, admitted: false },
    }],
    audio,
  });
  new RoomEmergence().detect(room);
  assert.equal(room.whispers.length, 1);
  assert.ok(room.whispers[0].recallCount > 0, 'the held whisper was not updated');
  assert.equal(audio.played[0].id, held.id);
});

void test('a voice the session no longer has audio for is not surfaced', () => {
  // Older saved textures carry no playable recording. Replaying one is silence
  // the room believes it filled.
  const audio = { hasRecording: () => false, replay: () => { throw new Error('played a whisper with no audio'); } };
  const room = quiet({
    whispers: [voice()],
    active: [{
      ghost: trace(),
      startedAt: NOW - RECALL_PRESENTATION.ghost.durationMs * DISTURBED_VOICE_PROGRESS - 10,
      kind: 'ghost',
      disturbance: { loss: 0.5, at: { x: 0.5, y: 0.5 }, voicePlayed: false, admitted: false },
    }],
    audio,
  });
  assert.doesNotThrow(() => new RoomEmergence().detect(room));
});

void test('a room with no sound at all still shows what it is losing', () => {
  const room = quiet({
    whispers: [voice()],
    audio: null,
    active: [{
      ghost: trace(),
      startedAt: NOW - RECALL_PRESENTATION.ghost.durationMs * 0.95,
      kind: 'ghost',
      disturbance: { loss: 0.9, at: { x: 0.5, y: 0.5 }, voicePlayed: false, admitted: false },
    }],
  });
  const outcome = new RoomEmergence().detect(room);
  assert.deepEqual(outcome.utterances.map((said) => said.kind), ['forgetting']);
});

void test('a voice too young to be a memory is not part of one', () => {
  const audio = recordingAudio();
  const room = quiet({
    whispers: [voice({ createdAt: WALL - 1_000 })],
    active: [{
      ghost: trace(),
      startedAt: NOW - RECALL_PRESENTATION.ghost.durationMs * DISTURBED_VOICE_PROGRESS - 10,
      kind: 'ghost',
      disturbance: { loss: 0.5, at: { x: 0.5, y: 0.5 }, voicePlayed: false, admitted: false },
    }],
    audio,
  });
  new RoomEmergence().detect(room);
  assert.equal(audio.played.length, 0);
});

void test('a voice arrives only once the memory has been on the wall a while', () => {
  const at = (progress: number) => {
    const audio = recordingAudio();
    const room = quiet({
      whispers: [voice()],
      active: [{
        ghost: trace(),
        startedAt: NOW - RECALL_PRESENTATION.ghost.durationMs * progress,
        kind: 'ghost',
        disturbance: { loss: 0.5, at: { x: 0.5, y: 0.5 }, voicePlayed: false, admitted: false },
      }],
      audio,
    });
    new RoomEmergence().detect(room);
    return audio.played.length;
  };
  assert.equal(at(DISTURBED_VOICE_PROGRESS - 0.01), 0);
  assert.equal(at(DISTURBED_VOICE_PROGRESS), 1, 'the boundary is inclusive');
});

void test('a resting stillness clock is cleared by a reset, and only by one', () => {
  const emergence = new RoomEmergence();
  const standing = () => quiet({ ghosts: [trace()], tracks: [track({ stillFor: STILLNESS_SECONDS })] });
  const first = standing();
  emergence.detect(first);
  assert.equal(first.active[0].kind, 'stillness');
  const blocked = standing();
  emergence.detect(blocked);
  assert.ok(blocked.active.every((active) => active.kind !== 'stillness'));
  emergence.reset();
  const after = standing();
  emergence.detect(after);
  assert.equal(after.active[0].kind, 'stillness');
});

void test('the first tick of a session banks no time to roll against', () => {
  // A roll is against elapsed wall-clock time, so the tick that has no previous
  // tick has nothing to roll. Treating the page clock as elapsed time would
  // fire the room's whole repertoire in the first frame after it opens.
  const room = quiet({ ghosts: [trace()], random: () => 0 });
  const outcome = new RoomEmergence().detect(room);
  assert.equal(room.active.length, 0);
  assert.equal(outcome.event, undefined);
});

void test('a room that has forgotten everything does not roll for a memory', () => {
  const room = quiet({ ghosts: [], emptySeconds: 600, random: () => 0 });
  const outcome = afterFirstTick(new RoomEmergence(), room);
  assert.equal(room.active.length, 0);
  assert.equal(outcome.event, undefined);
});

void test('a retrace says its line in the middle of the stretch that was repeated', () => {
  // Not at the visitor's feet: the interesting place is the ground they went
  // back over, which is behind them by the time the room notices.
  const path = Array.from({ length: RETRACE_MIN_POINTS + 4 }, (_unused, index) => {
    const half = Math.floor((RETRACE_MIN_POINTS + 4) / 2);
    const along = index < half ? index / half : (index - half) / half;
    return { x: 0.1 + along * 0.8, y: 0.5, t: index * 100 };
  });
  const walker = track({ path });
  const room = quiet({ tracks: [walker] });
  const outcome = new RoomEmergence().detect(room);
  assert.deepEqual(outcome.utterances.map((said) => said.kind), ['return']);
  const at = outcome.utterances[0].at;
  assert.ok(at.x < walker.position.x, 'the line belongs behind them, not under them');
  assert.ok(at.x > path[0].x);
});

void test('a false memory says its line in the middle of the path it invented', () => {
  const room = quiet({ ghosts: [trace({ id: 'a' }), trace({ id: 'b' })], random: () => 0 });
  const outcome = afterFirstTick(new RoomEmergence(), room);
  assert.deepEqual(outcome.utterances.map((said) => said.kind), ['false']);
  const fabricated = room.ghosts.at(-1)!;
  assert.deepEqual(outcome.utterances[0].at, fabricated.path[Math.floor(fabricated.path.length / 2)]);
});

void test('a false memory carries both of the traces it was made from', () => {
  const room = quiet({ ghosts: [trace({ id: 'a' }), trace({ id: 'b' })], random: () => 0 });
  afterFirstTick(new RoomEmergence(), room);
  const lineage = room.ghosts.at(-1)!.lineage;
  assert.ok(lineage.includes('a') && lineage.includes('b'), `lineage was ${lineage.join(', ')}`);
});

void test('a crossing is filed as a crossing, about the person who crossed', () => {
  // Weaker than anything the visitor chose to do. Filing it as a revisit would
  // make the room's coincidence count as strongly as their act.
  const filed: Array<[string, string]> = [];
  const attention = new AttentionRuntime();
  const observe = attention.observe.bind(attention);
  attention.observe = (kind, trackId, now) => {
    filed.push([kind, trackId]);
    observe(kind, trackId, now);
  };
  const room = quiet({
    ghosts: [trace()],
    attention,
    tracks: [track({
      id: 'crosser',
      previous: { x: 0.15, y: 0.3, t: NOW - 200 },
      position: { x: 0.5, y: 0.55, t: NOW },
    })],
  });
  new RoomEmergence().detect(room);
  assert.deepEqual(filed, [['crossing', 'crosser']]);
});

void test('a disturbed memory resumes from the crossing, not from its beginning', () => {
  // The remainder of the path, not the whole of it: the part already walked
  // past is behind the visitor and showing it again is a different memory.
  const long = trace({
    id: 'long',
    // Along the line the visitor below walks, and continuing past where they
    // stop, so the memory has a remainder to resume with.
    path: Array.from({ length: 10 }, (_unused, index) => ({
      x: 0.15 + index * 0.07, y: 0.3 + index * 0.05, t: index * 100,
    })),
  });
  const room = quiet({
    ghosts: [long],
    tracks: [track({
      previous: { x: 0.15, y: 0.3, t: NOW - 200 },
      position: { x: 0.5, y: 0.55, t: NOW },
    })],
  });
  new RoomEmergence().detect(room);
  const surfaced = room.active[0].ghost.path;
  assert.ok(
    surfaced.length < long.path.length + 1,
    `the whole path resurfaced: ${surfaced.length} of ${long.path.length}`,
  );
  assert.deepEqual(surfaced.at(-1), long.path.at(-1), 'and it still runs to the end');
});

/**
 * A track ends when its visitor leaves, so its last position sits at the edge
 * of the room and the line clamped itself into a corner. The room speaks along
 * the route the two of them shared instead.
 */
void test('a convergence speaks from the shared route, not from where the track ended', () => {
  const walked = [
    { x: 0.1, y: 0.5 },
    { x: 0.5, y: 0.5 },
    { x: 0.98, y: 0.5 },
  ];
  const spoken = convergenceVoicePoint(walked);
  assert.deepEqual(spoken, walked[1]);
  assert.notDeepEqual(spoken, walked.at(-1), 'never the last position');

  // Even lengths take the later of the two middles, which is still inside.
  assert.deepEqual(convergenceVoicePoint([{ x: 0, y: 0 }, { x: 1, y: 1 }]), { x: 1, y: 1 });
  // A path with no points cannot come from a captured trace; it is a place
  // rather than an absence the caller would have to handle as it speaks.
  assert.deepEqual(convergenceVoicePoint([]), { x: 0.5, y: 0.5 });
});
