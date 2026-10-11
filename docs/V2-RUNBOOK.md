# Working on the Rust half

Everything here is optional for ordinary frontend work. `npm run dev`,
`npm test` and `npm run typecheck` do not need a Rust toolchain, do not build
WASM, and do not read `crates/`. That is deliberate: the migration is not
allowed to make changing a button slower.

## What you need, and only when

| Task | Needs |
| --- | --- |
| frontend iteration, the TypeScript suite | node |
| `cargo test`, `cargo clippy`, `cargo fmt` | the pinned toolchain |
| `npm run build:wasm`, `npm run test:parity` | the toolchain, the wasm32 target, `wasm-bindgen-cli` |
| `roomd` | the toolchain, and a built `dist/client` |

The toolchain is pinned in `rust-toolchain.toml`. `rustup` reads it
automatically and installs the `wasm32-unknown-unknown` target listed there; a
gallery machine rebuilt six months from now has to produce the same engine, and
"whatever stable is current" does not.

## wasm-bindgen must match the crate exactly

`crates/room-wasm` depends on `wasm-bindgen` at an exact version, and the CLI
that generates the glue must be that same version or the module it produces
will not load. `scripts/build-wasm.mjs` checks this before doing anything and
tells you the version it wants.

Install it one of two ways:

```bash
cargo install wasm-bindgen-cli --version <the version the script names>
# or, if you keep it out of ~/.cargo:
WASM_BINDGEN=/path/to/wasm-bindgen npm run build:wasm
```

The script also looks for `.tools/wasm-bindgen` relative to the repository root,
which is where a downloaded release archive can be unpacked. `.tools/` and
`public/wasm/` are both ignored by git: they are build products, and the
repository holds sources.

## The commands

```bash
npm run build:wasm     # cargo build --target wasm32 + wasm-bindgen glue
npm run test:rust      # fmt --check, clippy -D warnings, cargo test --workspace
npm run test:parity    # build:wasm, typecheck the harnesses, then run them
npm run check:rust     # both of the above
npm run check          # the full release gate, which now includes check:rust
```

`npm run test:parity` writes `reports/v2/wasm-parity.json`,
`reports/v2/tracking-parity.json`, `reports/v2/attention-parity.json` and
`reports/v2/behavior-parity.json`. Read them rather than the console output:
they carry the tolerances, the worst measured error and the per-frame cost.

Two of the reports carry a count of how often the decision under test was
actually reached, because a frame count on its own is not evidence that
anything was compared:

* the attention report carries `spells`, and the gate fails below eight.
  Interest is rare by design — a forty-five-second hold inside a refractory
  eight minutes — so a run can agree over seventy thousand frames while never
  once reaching the decision.
* the behaviour report carries `noticed`, a count per kind, and the gate fails
  if any of the six is zero. Six detectors give six ways to build a session
  that agrees about nothing.

The behaviour report also splits its timing three ways — `encodeMsPerFrame`,
`wasmMsPerFrameIncludingCopies`, `decodeMsPerFrame` — because this is the one
subsystem where Rust is measurably slower than the TypeScript, and a single
number cannot say where the time goes. It is not the boundary; see
`docs/ARCHITECTURE.md`.

## Why the parity harnesses are typechecked separately

They import `public/wasm/`, which is generated. Checking them from the main
`tsconfig.json` would mean either `npm run typecheck` fails on a clean checkout
or every frontend change rebuilds the Rust workspace first. They are excluded
there and checked by `tsconfig.parity.json`, which `npm run test:parity` runs
immediately after building the module they import.

## The renderer gates

`npm run test:render` runs the pixel suite over both backends in headless
Chrome, compares them, and then runs three of the four gates that stand between
WebGPU and being the exhibition default: device-loss recovery, GPU allocation
over a long run, and frame pacing. The fourth needs the gallery's own machine
and a day.

The pacing line reports GPU completion time, not CPU submit time. Timing
`render()` measures how long it took to *describe* a frame — on this machine
that came back as 0.000 ms, under the clock's resolution — so each sample is
awaited to completion. There is a floor under the median for that reason: a
gate that cannot fail is not a gate.

`ALLOW_NO_WEBGPU=1` is for a machine that genuinely has no WebGPU. It skips
the WebGPU suite *and* these gates, and it has to be said out loud rather than
discovered from an absent line of output.


`npm run test:render` builds `scripts/render-regression/browser.ts`, serves it on
loopback and runs it in headless Chrome against a real GPU. It exercises WebGL at
all three profiles and WebGPU at the extremes, then compares the two: the field
must be lit, moving, black under blackout, reversible, and a body must brighten
the room *where the body is* — which is the check a vertical flip cannot pass.

To watch WebGPU drive a real room rather than a test: open the console with **O**
and set **Graphics backend** to WebGPU. The renderer line says which backend is
actually running, and names the reason when it is not the one you picked. It
takes effect where you stand; it used to need a page reload and did not say so,
for the reason in the third bullet below.

Chrome is launched with `--enable-unsafe-webgpu`. If this machine has no WebGPU
the run fails rather than quietly skipping the backend; `ALLOW_NO_WEBGPU=1` says
out loud that you accept an unchecked backend.

Three things that will waste an afternoon if you do not know them:

* **WebGPU does not throw when a frame is invalid.** `submit` drops the command
  buffer, the canvas keeps its previous contents, and the wall shows a frozen
  image. The renderer takes an `onError` callback fed from `uncapturederror`,
  and the regression suite fails on anything it collects.
* **A canvas is spent by the first graphics API it is asked for.** Permanently,
  in both directions, and merely *asking* is enough — destroying the device does
  not give it back. So every renderer construction takes a fresh element from
  `gpu-surface.ts` rather than reusing the one in the render tree. Before that,
  switching backend in the console could not work, and a WebGPU device that did
  not come back could not fall back to WebGL2: the room ran Canvas 2D traces for
  the rest of the day on hardware that could have run the particle field. All of
  it silent, because a dark room lit only by the field looks the same either way.
* **`layout: 'auto'` gives every pipeline its own bind group layout.** Two
  pipelines that differ only in blend state cannot share a bind group made
  against one of them. Both render pipelines take an explicit shared layout.

## roomd

```bash
npm run build
cargo run -p roomd -- --root dist/client --port 7341
cargo run -p roomd -- --root dist/client --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Without `--browser` it is a static server on loopback and nothing else, which is
the useful shape for development. With one it owns the browser process: kiosk
flags, its own profile directory, health at `/health`, and restart with backoff
when the child exits or stops making progress.

The room reports to it while it runs. `curl http://127.0.0.1:7341/health` shows
the last beat, how old it is, whether sensing has stalled and the bounded event
log. Verified by hand as well as by tests: posting
`{"entered":true,"engineTick":12,"renderFrame":340,"sensorFrame":56}` to
`/supervisor/heartbeat` answers 204 and appears in `/health`; the same payload
with one extra field answers 400, because the supervisor would rather see
nothing than something it half understands.

It is not yet the exhibition launcher. `npm run exhibit` is, and it stays that
way until `roomd` has been through the recovery and soak gates in
`docs/ARCHITECTURE.md`.

## Reproducing a session

The room runs on one seeded stream. The operator console reports the seed on
the **Random seed** line; `?seed=<n>` pins it. Given the same seed and the same
observations, the room makes the same decisions — which memory surfaces, how far
it mutates, where a whisper lands.

```bash
cargo run -p room-engine --example rng-vectors > tests/vectors/rng.json
```

regenerates the shared vectors that hold `lib/room-rng.ts` and
`room_engine::rng` to the same stream. **Expect an empty diff.** A non-empty one
means the generator moved, and every saved room will resume into a stream that
no longer exists; the Rust and TypeScript suites both read that file, so neither
half can drift quietly.

A seed alone does not reproduce a session. It reproduces the *decisions* given
the same observations, which is why the anonymous event recorder exists: a
reproduction needs the seed, the clock and the observation log together.

## Do not run the gates concurrently

`npm run check` runs them in sequence for a reason. `npm run test:mutation`
forks a test runner per mutant, `npm run test:render` launches headless Chrome
with a GPU backend, and a release-profile `cargo build` will use every core it
can find. Any two of those at once is unpleasant; all three at once wedged this
machine hard enough to need a restart. Run one, wait, run the next.

## If a parity run fails

1. Read the report, not the assertion. `disagreements` names the scenario, the
   frame and the field.
2. Check which leg failed. `worstTypescriptVsWasm` moving is a migration
   defect: the Rust no longer does what the gallery does.
   `worstNativeVsWasm` moving on its own is a cross-target difference, and the
   first suspect is the transport rather than the engine — see the note in
   `docs/ARCHITECTURE.md` about `serde_json` and `f64`. For attention both are
   currently *exactly* zero rather than merely inside tolerance, because those
   rules reach no `libm` function at all; anything non-zero there is a real
   change.
3. Do not widen the tolerance to make it pass. It is stated in the harness with
   the reason for its value; a measured error approaching it is a finding.

## Run the live WASM subsystems

```bash
npm run build:wasm
npm run build
npm start
```

Open `http://127.0.0.1:3000/?tracking=wasm&attention=wasm&field=wasm&behavior=wasm`,
enter the room, and press **O**. The **Tracking**, **Interest**, **Memory
field** and **Behaviours** lines must each say
`Rust/WASM ... (verified against TS)`. Each query parameter is independent and
any may be left off; without it that subsystem runs TypeScript. All four keep a
live TypeScript companion and retire WASM on any disagreement, so a line that
has reverted names the reason and keeps it there — the rolling event field would
have overwritten it within a second.

Interest is rare on purpose, so an **Interest** line that never leaves
`Rust/WASM` is not evidence the engine was ever exercised. Dwell in one spot for
a minute or so; a spell is a forty-five-second hold inside a refractory eight
minutes. The same caution applies to **Behaviours**, and more strongly: every
detector has a cooldown between twenty seconds and a minute, and most of them
need two people. Wave at the camera from a standstill, then walk in from the
edge alongside somebody, to exercise two of the six. Graphics backend is a
separate operator setting and takes effect immediately.

WASM files are local build products copied into the static artifact. An absent
or unloadable build falls back within five seconds. A runtime trap or parity
failure uses the TypeScript companion's current state, without restarting the
room or losing track histories. The tracking line retains the fallback reason.
Reload to retry WASM; the room does not repeatedly switch engines during a visit.
This mode intentionally runs both trackers, and is not a performance optimisation.

`npm run test:parity` now also drives the shell's adapter with real WASM on all
eight tracking scenarios. Unit tests cover missing/slow loads, malformed output,
traps, reset, disposal and continuity. Gallery hardware and a 24-hour soak remain
required before promoting the mode to the exhibition default.
