# V2 architecture and migration

## Decision

Keep the browser shell and existing artwork running throughout migration. Rust
is a determinism and ownership boundary, not a demonstrated speed improvement.
The measured 108 microsecond camera pipeline stays in TypeScript. WebGL remains
the exhibition default until WebGPU passes the same visual and recovery gates.

## Current ownership (audit, September 15 2026)

| Concern | Current implementation | Destination |
| --- | --- | --- |
| camera/background/components | `motion-tracker.ts`, `sensor-inputs.ts` | TS sensor adapter |
| anonymous association/recovery | `TrackingRuntime`: Rust/WASM default, verified TypeScript companion (`?tracking=ts` opts out) | Rust once the shell reads it |
| field deposit and decay | `FieldRuntime`: Rust/WASM default, verified TypeScript companion (`?field=ts` opts out) | Rust once the shell reads it |
| path mutation, personality | `memory-engine.ts`; parity-verified natively as `room_engine::memory`/`room_engine::path` (path mutation, as part of the recall port) and `room_engine::personality` | pure `room-engine` primitives, reached — TypeScript remains what the gallery runs; no live boundary is planned, for the same reason as recall, below |
| recall scheduling and collisions | `room-emergence.ts`; parity-verified natively as `room_engine::emergence` (the six-branch scheduler) and `room_engine::disturbance` (the crossing detector) | pure `room-engine` primitives, reached — TypeScript remains what the gallery runs; no live boundary is planned, for the same reason as recall, above |
| evidence, interest | `AttentionRuntime`: Rust/WASM default, verified TypeScript companion (`?attention=ts` opts out) | Rust once the shell reads it |
| behaviour detection | `BehaviorRuntime`: Rust/WASM default, verified TypeScript companion (`?behavior=ts` opts out) | Rust once the shell reads it |
| life cycle and forgetting | `room-lifecycle.ts`, `room-upkeep.ts` | pure engine |
| session PCM and playback | `session-audio.ts`, `audio-memory.ts`, `room-speech.ts` | TS only; bounded RAM |
| storage and anonymous replay | `persistence.ts`, `session-export.ts`, `debug-recorder.ts` | validated TS persistence adapter |
| renderer input | `swarm-frame.ts`, `room-bodies.ts`, `room-frame.ts` | backend-independent snapshot |
| particles | `swarm-renderer.ts` (default), `webgpu-renderer.ts` (opt-in), on surfaces owned by `gpu-surface.ts` | WebGL default until WebGPU clears its gates |
| UI and device lifecycle | `room-installation.tsx`, operator components | React shell |
| server and watchdog | `static-server.mjs`, `exhibit.mjs`, `liveness.ts` | opt-in native `roomd` |

The initial working tree contained untracked protocol and arithmetic crates, but
no engine crate entrypoint, WASM adapter or supervisor. Those files are migration
work, not evidence of a functioning second runtime.

## What has actually moved

All four `?x=wasm` flags named below now default on; `=ts` is each one's
explicit opt-out back to TypeScript alone. The per-subsystem paragraphs below
still describe the flag by its explicit spelling for precision, but that
spelling is no longer required to reach Rust/WASM — only to leave it.

Ported and measured against the TypeScript it came from:

* memory field deposit and decay (`room_engine::field`), 12 virtual hours, zero
  error against `memory-engine.ts`. The live `FieldRuntime` adapter runs the
  same 43,200 steps against real WASM in that gate without falling back, plus a
  steep-decay segment that separates deposit-then-decay from the reverse — at
  the room's own rate the two orders differ by less than the tolerance in any
  one step. See `reports/v2/wasm-parity.json`.
* anonymous tracking (`room_engine::tracking`), 2,480 frames across eight
  synthetic sessions, zero disagreements against `AnonymousTrackManager` and a
  worst continuous-field difference of 1.1e-16. See
  `reports/v2/tracking-parity.json`.
* behaviour detection (`room_engine::behavior`), 19,616 frames across twelve
  synthetic sessions, zero disagreements against `behaviors.ts` and a worst
  difference of **exactly zero** on both legs. All six detectors fire in the
  run — 42 events — and the harness fails if any of them never does, because
  six detectors give six ways to build a session that agrees about nothing.
  See `reports/v2/behavior-parity.json`.
* the recall primitives (`room_engine::memory`), 2,260 steps across six
  synthetic sessions — 157 composites and 282 weighted choices — zero
  disagreements against `memory-engine.ts` and `memory-records.ts` and a worst
  difference of **exactly zero**. This is the first subsystem whose behaviour
  depends on randomness, so the two legs are given the same seed rather than
  the same draws: a scenario carrying the draws could not catch a leg that
  consumed them in the wrong order, and the harness compares the draw count as
  well as the values. Path mutation is inside this port, not a separate one —
  `remember_ghost`/`remember_whisper` and the geometry underneath them in
  `room_engine::path` are what "path mutation" in the ownership table above
  names. See `reports/v2/behavior-parity.json`'s neighbour,
  `reports/v2/memory-parity.json`.
* the room's mood (`room_engine::personality`), 26 independent calls across
  four synthetic scenarios built specifically to hover on both sides of every
  threshold the rule has — a track count, a stillness duration, a speed, two
  durations of emptiness, two memory densities — zero disagreements against
  `choosePersonality` and all eight moods reached at least once. Unlike every
  other ported rule this one draws from no RNG and holds no state, so the
  scenario is the exact boundary values rather than a long session; see
  `reports/v2/personality-parity.json`.
* whether a visitor is crossing a stored memory's path (`room_engine::disturbance`),
  eight synthetic scenarios, 14 independent ticks, six actual crossings —
  including one caught only by the segment-intersection test, not the
  radius-entry one, and one produced by sub-threshold movement accumulating on
  the anchor across three ticks rather than resetting — plus five `memory_loss`
  cases and five `disturbance_frame` cases sampled across their own
  boundaries (the five-minute grace period, the six-hour ramp, the `loss >
  0.2` branch). Zero disagreements against `MemoryCollisions`, `memoryLoss`
  and `disturbanceFrame`. See `reports/v2/disturbance-parity.json`.
* the recall scheduler (`room_engine::emergence`), ten synthetic scenarios,
  92 ticks, matching seeded draw counts on every tick — the first ported
  function whose correctness depends on mutating three collections
  (`ghosts`, `whispers`, `active`) in place *and* a shared random stream *and*
  a returned decision, together. All six ways the room reaches for something
  — stillness, retrace (plus the stationary path that must not read as one),
  false memory, an ordinary recall, its empty-room variant, and a crossing —
  fired and agreed, including the fixed priority order itself (stillness
  outranking an available crossing on the same tick) and a disturbed recall
  qualifying a voice and later being admitted. Zero disagreements against
  `RoomEmergence.detect()`. One real bug this run caught before it shipped:
  the first draft silently dropped `EmergenceRoom.day`, which only the
  retrace branch reads, and every scenario but the retrace one agreed by
  coincidence. See `reports/v2/emergence-parity.json`.
* the room's interest (`room_engine::attention`), 75,560 frames across nine
  synthetic sessions covering eleven spells of interest, zero disagreements
  against `attention.ts` and `attention-evidence.ts` and a worst difference of
  **exactly zero** on both legs. The live `AttentionRuntime` adapter runs
  against real WASM in the same gate and reaches the same eleven spells. See
  `reports/v2/attention-parity.json`.

The shell now calls `TrackingRuntime`, which loads the local WASM build by
default and consumes Rust's tracking output; `?tracking=ts` opts back out to
TypeScript alone. A TypeScript companion advances on the same anonymous
observations and checks each returned frame against the existing 1e-6 parity
tolerance. A trap, malformed output or disagreement retires WASM and
immediately supplies the companion's current tracks, including their paths and
unchanged IDs. No observation replay buffer is retained. Startup has a
five-second limit; late allocations are freed, and unmount disposes the engine.
The operator console reports the active tracker and a persistent fallback reason.

This is not a completed Rust brain: TypeScript remains the required,
continuously-running companion and the sole fallback of record, and every
frame is still checked against it. What changed is which implementation drives
the frame when both agree — Rust/WASM now, rather than TypeScript. Running
both implementations still buys failure continuity, not speed. The tracking
parity harness exercises the live adapter with real WASM across the same
eight scenarios, including reset; hardware soak remains pending, and
`npm run test:parity`/`check:rust` are local developer scripts only — this
repo has no CI, so parity is not continuously re-verified between runs of them.

Both backends now satisfy one `RoomRenderer` interface, and `npm run test:render`
runs the same pixel suite over each in headless Chrome and then compares them:
across CHEAP and FULL, room and paper, the two agree on how much of the wall is
lit and how much of it is moving to within **0.40 percentage points**, and on how
much a standing body brightens the room around it to within **6%**. That is
visual parity on this machine.

Three of the four remaining gates now run in the same suite, because a gate
that needs a browser and is not run is not a gate:

* **Device loss recovers.** The harness owns the device and destroys it, which
  produces the state the browser reports for a real loss. The loss is reported
  rather than discovered from a frozen wall, the dead renderer accepts every
  call and draws nothing, and a rebuild on a fresh canvas draws 25% of the wall
  again. A canvas is spent once it has held a WebGPU context, so the rebuild
  gets a new element — the rule `gpu-surface.ts` already holds.
* **GPU memory stays bounded.** WebGPU exposes no memory counter, so the
  device's constructors are counted instead, and the claim is the strong one:
  after the first frames, **3,000 frames of a steady scene allocate nothing**
  — no buffer, no texture, no bind group. A resize allocates nothing either
  (the swapchain is the browser's to rebuild), and a memory field of a new size
  costs exactly one texture, once.
* **Frames are paced.** 359,936 particles complete in a median of **2.10 ms**
  of GPU time, p99 2.30 ms, worst 3.60 ms — 1.7x the median, against a gate of
  8x. The absolute numbers describe this machine, not a gallery; what the gate
  asserts is the shape, because a worst frame many times its median means
  something is happening per frame on any hardware.

The first attempt at that last gate timed `render()` and reported a median of
**0.000 ms**: `render` records commands and submits, and the GPU does the work
afterwards, so it was measuring how long it took to describe a frame. The gate
refused itself on a floor under the median, which is why there is one.

The fourth gate — a soak on the machine the gallery actually uses — needs that
machine and a day, so **WebGL stays the default and `auto` never selects
WebGPU**.

The shell selects between them. `renderer-startup.ts` owns the decision and the
construction; `room-installation.tsx` makes one call and gets a backend, a label
and a sentence. An operator picks the API under **Graphics backend** in the
console, `auto` means WebGL2, and a selection this machine cannot honour falls
back and says so on the renderer line itself.

The shell also reports to `roomd` now. Two heartbeats, not one field added to
the existing beat: the Node launcher reads *rates* and `roomd` reads *counters*,
and a rate can be reported by a loop that has stopped. `supervisor-beat.ts`
sends `entered`, `engineTick`, `renderFrame` and `sensorFrame` to loopback only,
and `roomd` holds the arrival time itself — so a frozen renderer with a
responsive page, a stalled engine, a dead page and an unplugged camera are four
different findings, and only the first three restart anything.

The room's interest is the second subsystem to go live, on the same terms and
through the same shape. With `?attention=wasm`, `AttentionRuntime` consumes
Rust's per-frame decision while a TypeScript companion advances on the same
evidence and checks it; a trap, a malformed frame or a disagreement retires WASM
and leaves the companion holding an unbroken spell. That continuity is the
reason for the duplication: interest is rare and a spell lasts sixty-four
seconds, so restarting one empty mid-spell would read as the room losing its
train of thought, which is the one thing the subsystem exists to suggest it has.
It also absorbed `EvidenceGate`, because in Rust the twenty-second spacing lives
inside `AttentionEngine` and half a subsystem either side of a boundary is not a
migration. The console reports the active engine and a persistent fallback
reason on its own line.

Porting it forced one deliberate change to the read model, recorded in
`ENGINEERING-STANDARDS.md`: interest is now a per-frame decision rather than a
curve any caller may sample. The divergence that buys is bounded and measured —
at most a 1.45 deposit multiplier being 0.0047 out, during the attack and fade
only — and in exchange the two implementations agree by construction rather than
approximately.

The particle field's canvas is now owned by `gpu-surface.ts` rather than by the
render tree. A canvas element is consumed by the first graphics API it is asked
for, permanently and in both directions — measured, not assumed — so every
renderer construction takes a fresh element. Without that the operator's
backend selector could not change a backend, and a WebGPU device that did not
come back could not fall back to WebGL2. `renderer-mount.ts` owns the recovery
escalation that used to live in an effect.

The memory field is the third and last of the ported engines to go live. With
`?field=wasm`, `FieldRuntime` sends one batch per analysis frame — four numbers
per deposit, no media and no identity — and compares the returned 2,304 cells
against the companion field the renderer is already pointed at. The difference
from the other two is that callers *hold* this one: the swarm uploads it as a
texture and `memoryDensity` reads it to choose the room's personality, so the
companion's `Float32Array` is the field, handed out once and never reassigned.
A fallback therefore changes nothing anyone is holding. `upkeep` now returns
what it decayed so the engine can be given exactly the same thing rather than
re-deriving it.

Behaviour detection is the fourth to go live, behind `?behavior=wasm`, on the
same terms. It differs from the other three in what has to cross: `revisit` is
a claim about minutes, so it reads the tracker's whole path rather than a
window of it, and the path belongs to the tracker. A mirror of it on the far
side would be cheaper on the wire and would desynchronise silently, which in a
revisit detector is indistinguishable from a room with no returning visitors —
so the path is copied whole, once per frame, and the copy is measured below
rather than asserted to be free.

Porting it added one bound to the TypeScript: `behaviors.ts` held a track's
samples inside a time window, which is a bound in practice and not in the type.
A caller stepping its clock in fractions of a millisecond — a replay running
flat out — could grow one record without limit. Both implementations now hold
the same `SAMPLES_MAX`, so they agree by construction in a regime neither will
ever reach.

The room now has one random stream rather than a dozen calls to
`Math.random()`. `lib/room-rng.ts` is the JavaScript half of
`room_engine::rng` — sfc32 seeded through splitmix32, chosen because every
operation is a 32-bit add, xor, shift or rotate that JavaScript expresses
exactly — and `tests/vectors/rng.json`, generated from the Rust and read by
both suites, is the evidence that they are one generator. Neither can drift
without a test going red.

That was a documentation defect before it was a feature: `rng.rs` had claimed
`lib/room-rng.ts` and the vectors existed since the crate was added, and
neither did. The generator was real; the thing that made it a shared stream
was not.

Threading it found the actual gap. `EmergenceRoom.random` existed, but it
reached only the two rate rolls: `chooseRareGhost`, `recallGhost`,
`rememberWhisper` and `convergenceRecall` each defaulted to `Math.random`
separately, so *which* memory surfaced and how far it mutated were ambient even
in a session that had supplied a stream. Those are now drawn from the room's
generator, and the last direct `Math.random()` in authoritative behaviour — the
position a whisper takes on the wall, which is written into `WhisperMemory` and
so is a durable fact rather than a rendering choice — takes it too. The renderer
keeps its own: where a particle starts is how a memory manifests, which is the
renderer's decision to make.

`?seed=<n>` pins a session and the operator console reports the seed, because a
seed nobody can read is a seed nobody can replay.

Porting the memory primitives found two bounds the TypeScript did not have and
the Rust already declared, which is the migration doing the job it is for.

* **A composite's id was unbounded.** A false memory's id embedded both of its
  parents' ids, so a composite of two composites embedded theirs. Measured:
  the length roughly 2.6x'd per generation and reached 38,312 characters by the
  eighth, written to disk on every save. `MEMORY_ID_MAX` is 64, so the Rust
  could not represent it — which is how it was found. A composite is now named
  *after* its parents rather than *from* them, and the provenance stays in
  `lineage`, which the recall rules already require and which is bounded at
  `LINEAGE_MAX`.
* **One unreadable memory failed the whole room.** `MemoryId::deserialize` had
  promised since the crate was written that an invalid id fails its record
  rather than the room. It did not: serde aborts a document on the first
  element it cannot read. A gallery holding one over-long composite id would
  have opened to an empty room. `PersistentState::parse` now filters the
  collections at the one seam where each record can be tried by itself, and
  `parse_reporting` returns how many were dropped so the console can say so.

The long ids are already on disk in every gallery that has been running, so
neither fix is retrospective: the first stops minting them, the second stops
them costing the room.

Porting the recall primitives also widened one protocol type. `Envelope` was
`Bounded<f32, 32>`, which holds a three-decimal amplitude perfectly well — but
every recall reads the stored envelope, smooths each point against its
neighbour, scales it by a draw and stores the result, and a voice reached for
all evening goes through that dozens of times. In `f32` each pass quantises, so
the Rust would have drifted away from the TypeScript slowly, invisibly, and
only in rooms that had been running long enough that nobody could reproduce it.
Thirty-two `f64` against thirty-two `f32`, at `WHISPERS_MAX`, is ten kilobytes.

Recall scheduling — the six-branch decision in `room-emergence.ts` about when
the room reaches for a memory at all, and the collision detector underneath
its crossing branch — is now parity-verified too (`room_engine::emergence`,
`room_engine::disturbance`), on the same terms as recall and personality: no
live boundary, TypeScript remains what the gallery runs. Tracking, interest,
the field and behaviour are live behind their own query parameters; life
cycle and forgetting (`room-lifecycle.ts`, `room-upkeep.ts`) are what remains
entirely TypeScript in the room brain.

## Parity method

`npm run test:parity` drives three runtimes on identical input: TypeScript,
`room-engine` compiled natively, and the same Rust compiled to `wasm32`. Both
comparisons run because they answer different questions — "did the migration
preserve the artwork" and "does a session replayed on a developer's machine
match the one the gallery ran".

Two things the harness taught, both recorded because a future reader would
otherwise rediscover them:

* **The scenario file is raw little-endian `f64`, not JSON.** `serde_json`
  1.0.151 does not always parse a seventeen-digit decimal to the nearest `f64`:
  `0.20400000000000001` comes back one unit in the last place low, where
  `str::parse::<f64>` is exact. Feeding scenarios through `JSON.stringify` gave
  the native leg a *different session* and produced sixty-nine disagreements
  that belonged entirely to the instrument. Results come back as JSON, which is
  safe: `ryu`'s shortest form round trips through V8's correctly-rounded parser.
* **A scenario nobody is chosen in agrees trivially.** Interest is rare by
  design — a spell is 64 seconds inside a refractory eight minutes — so a
  parity run can be built entirely out of sessions in which both runtimes
  correctly do nothing, and it will report zero disagreements over tens of
  thousands of frames. `reports/v2/attention-parity.json` carries a `spells`
  count and the harness fails below eight, because the frame count alone is not
  evidence that the decision under test was ever reached.
* **The same rounding applies to saved rooms**, which are JSON on disk.
  Coordinates restore to within one ULP, not exactly. Artistically that is
  nothing; for replay it is another reason a reproduction needs the observation
  log rather than a restored room. Pinned by
  `a_saved_coordinate_survives_json_to_within_one_unit_in_the_last_place`.

## Measured, not assumed

Per sensing frame, on this machine, including every copy across the boundary:

| | TypeScript | WASM |
| --- | --- | --- |
| tracking, mean over 2,480 frames | 0.0040 ms | 0.0033 ms |
| field step, mean over 43,200 steps | 0.0033 ms | 0.0031 ms |
| interest, mean over 73,360 frames | 0.00030 ms | 0.00023 ms |
| behaviour, mean over 19,616 frames | 0.0152 ms | 0.0381 ms |

At 24 Hz that is under a tenth of one percent of a 16.67 ms frame either way.
**Rust is not faster here in any sense that matters**, and the migration is not
justified by these numbers.

Behaviour is the first subsystem where Rust is measurably *slower*, and the
reason is not the boundary. Isolated, `step` costs 0.36 microseconds on an
empty frame and about 8 ns per path point copied. What costs is the follow
detector, which for every ordered pair, at each of four lags, scans the
leader's whole sample window for each of the follower's samples:

| visitors walking, per sensing frame | TypeScript | WASM |
| --- | --- | --- |
| 2 | 12 us | 13 us |
| 6 | 55 us | 167 us |
| 12, which is `TRACKS_MAX` | 156 us | 462 us |

The gap opens with the number of pairs, so what this measures is V8's JIT
beating a `wasm32` build on a tight numeric loop over a ring buffer — not a
boundary cost, and not something a coarser frame would fix.

The growth is the part that would bite, so it was measured to its ceiling
rather than extrapolated. Twelve people is 66 pairs and the most the room can
ever be asked for; at the 24 Hz the sensing loop runs at, 462 us is 1.1% of
wall time, on a loop that is not the render path. **The superlinear term is
real and it is bounded by a bound the room already holds**, which is why there
is no cleverer inner loop. A monotone two-pointer sweep would make it linear
and was rejected: the nearest-sample search breaks on a plateau of equal
timestamps, which the engine permits because it refuses only a clock that goes
*backwards*, and a detector that silently picks a different sample is exactly
the failure mode the voice rules call worse than silence. The measurement says
the incumbent is fast enough; novelty needs a reason better than that. What it buys is a deterministic core that can be
tested, replayed and debugged without a browser. `ENGINEERING-STANDARDS.md`
already records that the sensing pipeline was measured and deliberately left in
TypeScript; that decision stands.

## Contracts

* One coarse call per observation frame; rendering never calls WASM per particle.
* Rendering consumes values, never chooses recalls or changes memories.
* Browser camera pixels and microphone PCM never cross the engine boundary.
* Anonymous observation does not mean arbitrary input is safe: finite values,
  coordinate ranges, collection counts and serialized bytes require validation.
* Persistence continuity is distinct from deterministic replay. Replaying requires
  initial state, explicit clock, seed, observations and commands. A seed plus
  saved memories alone cannot reproduce live track/cooldown state.
* A renderer counter means work submitted, not proof that a projector displayed
  it. GPU completion and browser pixel tests are separate evidence.
* Device loss retires resources. A WebGPU canvas cannot become a WebGL canvas;
  fallback needs a fresh canvas or separate surfaces.
* Native HTTP listens only on loopback, bounds requests, rejects paths escaping
  the artifact root (including symlinks), and serves WASM with its proper MIME.
* Browser child exit, missing heartbeat, engine stall and render stall are
  different failures. Sensor loss degrades the artwork without a restart loop.

## Promotion gates

1. Compile/test the protocol and pure primitives; compare TS, native and WASM
   against the same inputs and explicit tolerances.
2. Move TS cognition behind one engine API without changing its behavior.
3. Port tracking, recall, interest and behavior in individually checked changes.
4. Make WASM authoritative only after semantic parity. Keep old state readable;
   do not overwrite gallery persistence with an incomplete migration schema.
5. Compare WebGPU and WebGL on room/paper, live bodies, simultaneous recalls,
   false-memory warmth, calibration and device loss. Measure frame pacing and
   retained resources before selecting WebGPU by default.
6. Exercise native recovery with child exits and independent counter stalls.
7. Run the existing release gate, a deterministic 12-hour day, then a 24-hour
   real-time hardware soak and real sensor disconnect/reconnect tests.

A short automated run cannot satisfy the 24-hour hardware gate. Do not label a
migration scaffold, a shadow engine or an optional renderer production parity.
