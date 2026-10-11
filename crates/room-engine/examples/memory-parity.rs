//! The native leg of the memory parity gate.
//!
//! Reads a scenario written by `scripts/memory-parity.ts` and prints what this
//! build does with it, so that the same Rust compiled for `aarch64` and for
//! `wasm32` can be compared on the same input — and so that both can be
//! compared against the TypeScript the gallery is running.
//!
//! # Why this one needs a shared random stream and the others did not
//!
//! Tracking, interest, the memory field and behaviour detection are all
//! deterministic given their observations. Recall is not: what a memory
//! becomes when it is replayed depends on a draw, and so does which memory is
//! reached for. Comparing two implementations of that is meaningless unless
//! they are given the same numbers in the same order, which is why
//! `room_engine::rng` and `lib/room-rng.ts` exist and why the scenario carries
//! a seed rather than a list of draws: a scenario that carried the draws could
//! not catch a leg that consumed them in the wrong order.
//!
//! # Why the scenario is not JSON
//!
//! The same reason every other harness here gives: `serde_json` 1.0.151 does
//! not parse every `f64` to the nearest representable value. A fidelity one
//! unit in the last place out is a different mutation on every subsequent
//! recall, so the scenario arrives as raw little-endian `f64`. Results go back
//! as JSON, which is safe in that direction.
//!
//! Usage: `cargo run -p room-engine --example memory-parity -- scenario.bin`

use std::error::Error;

use room_engine::memory::{choose_rare, create_false_memory, remember_ghost, remember_whisper};
use room_engine::rng::Rng;
use room_protocol::{Envelope, Ghost, Lineage, MemoryId, PathPoints, Point, Vec2, Whisper};

/// File magic. Bumped if the layout below ever changes, so a stale scenario
/// fails loudly rather than decoding as a different session.
const MAGIC: &[u8] = b"ROOMMEM1";

/// One scenario: a collection of memories, a seed, and a run of recalls.
#[derive(Debug)]
struct Scenario {
    name: String,
    seed: u64,
    /// Recalls to perform, as `(kind, index, index, now)`. See the encoder.
    steps: Vec<[f64; 4]>,
    ghosts: Vec<Ghost>,
    whispers: Vec<Whisper>,
}

/// A cursor over the scenario file. Every read is checked; a truncated file is
/// an error, never a short session that looks like a quiet gallery.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Result<Self, Box<dyn Error>> {
        if bytes.get(..MAGIC.len()) != Some(MAGIC) {
            return Err("not a memory scenario file".into());
        }
        Ok(Self {
            bytes,
            at: MAGIC.len(),
        })
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], Box<dyn Error>> {
        let end = self.at.checked_add(count).ok_or("scenario is truncated")?;
        let slice = self
            .bytes
            .get(self.at..end)
            .ok_or("scenario is truncated")?;
        self.at = end;
        Ok(slice)
    }

    fn u32(&mut self) -> Result<usize, Box<dyn Error>> {
        let bytes: [u8; 4] = self.take(4)?.try_into()?;
        Ok(u32::from_le_bytes(bytes) as usize)
    }

    fn f64(&mut self) -> Result<f64, Box<dyn Error>> {
        let bytes: [u8; 8] = self.take(8)?.try_into()?;
        Ok(f64::from_le_bytes(bytes))
    }

    fn text(&mut self) -> Result<String, Box<dyn Error>> {
        let length = self.u32()?;
        Ok(String::from_utf8(self.take(length)?.to_vec())?)
    }

    fn id(&mut self) -> Result<MemoryId, Box<dyn Error>> {
        let raw = self.text()?;
        MemoryId::new(&raw).map_err(|error| format!("{raw}: {error}").into())
    }

    fn ghost(&mut self) -> Result<Ghost, Box<dyn Error>> {
        let id = self.id()?;
        let created_at = self.f64()?;
        let last_replayed_at = self.f64()?;
        let points = self.u32()?;
        let mut path = PathPoints::new();
        for _ in 0..points {
            path.push(Point::new(self.f64()?, self.f64()?, self.f64()?));
        }
        Ok(Ghost {
            id,
            created_at,
            last_replayed_at,
            path,
            dwell_seconds: self.f64()?,
            intensity: self.f64()?,
            strength: self.f64()?,
            fidelity: self.f64()?,
            recall_count: u32::try_from(self.u32()?)?,
            lineage: Lineage::new(),
            false_memory: false,
            day: u32::try_from(self.u32()?)?,
        })
    }

    fn whisper(&mut self) -> Result<Whisper, Box<dyn Error>> {
        let id = self.id()?;
        let created_at = self.f64()?;
        let points = self.u32()?;
        let mut envelope = Envelope::new();
        for _ in 0..points {
            envelope.push(self.f64()?);
        }
        Ok(Whisper {
            id,
            created_at,
            last_replayed_at: self.f64()?,
            duration: self.f64()?,
            envelope,
            brightness: self.f64()?,
            position: Vec2::new(self.f64()?, self.f64()?),
            strength: self.f64()?,
            fidelity: self.f64()?,
            recall_count: u32::try_from(self.u32()?)?,
            lineage: Lineage::new(),
            day: u32::try_from(self.u32()?)?,
        })
    }

    fn scenarios(&mut self) -> Result<Vec<Scenario>, Box<dyn Error>> {
        let count = self.u32()?;
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            let name = self.text()?;
            let seed = self.f64()?;
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let seed = seed as u64;
            let ghost_count = self.u32()?;
            let mut ghosts = Vec::with_capacity(ghost_count);
            for _ in 0..ghost_count {
                ghosts.push(self.ghost()?);
            }
            let whisper_count = self.u32()?;
            let mut whispers = Vec::with_capacity(whisper_count);
            for _ in 0..whisper_count {
                whispers.push(self.whisper()?);
            }
            let step_count = self.u32()?;
            let mut steps = Vec::with_capacity(step_count);
            for _ in 0..step_count {
                steps.push([self.f64()?, self.f64()?, self.f64()?, self.f64()?]);
            }
            out.push(Scenario {
                name,
                seed,
                steps,
                ghosts,
                whispers,
            });
        }
        if self.at != self.bytes.len() {
            return Err("scenario file has trailing bytes".into());
        }
        Ok(out)
    }
}

/// What a step asked for. The wire codes match `scripts/memory-parity.ts`.
const RECALL_GHOST: f64 = 0.0;
const RECALL_WHISPER: f64 = 1.0;
const COMPOSE: f64 = 2.0;
const CHOOSE: f64 = 3.0;

/// One ghost, flattened for comparison. Field order matches the encoder.
fn describe_ghost(ghost: &Ghost) -> serde_json::Value {
    serde_json::json!({
        "id": ghost.id.as_str(),
        "lastReplayedAt": ghost.last_replayed_at,
        "dwellSeconds": ghost.dwell_seconds,
        "intensity": ghost.intensity,
        "strength": ghost.strength,
        "fidelity": ghost.fidelity,
        "recallCount": ghost.recall_count,
        "falseMemory": ghost.false_memory,
        "day": ghost.day,
        "lineage": ghost.lineage.iter().map(MemoryId::as_str).collect::<Vec<_>>(),
        "path": ghost.path.iter().flat_map(|p| [p.x, p.y, p.t]).collect::<Vec<f64>>(),
    })
}

fn describe_whisper(whisper: &Whisper) -> serde_json::Value {
    serde_json::json!({
        "id": whisper.id.as_str(),
        "lastReplayedAt": whisper.last_replayed_at,
        "strength": whisper.strength,
        "fidelity": whisper.fidelity,
        "recallCount": whisper.recall_count,
        "envelope": whisper.envelope.iter().copied().collect::<Vec<f64>>(),
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: memory-parity <scenario.bin>")?;
    let bytes = std::fs::read(path)?;
    let scenarios = Reader::new(&bytes)?.scenarios()?;

    let mut out = Vec::with_capacity(scenarios.len());
    for scenario in scenarios {
        let mut rng = Rng::new(scenario.seed);
        let mut ghosts = scenario.ghosts.clone();
        let mut whispers = scenario.whispers.clone();
        let mut results = Vec::with_capacity(scenario.steps.len());

        for step in &scenario.steps {
            let (kind, first, second, now) = (step[0], step[1], step[2], step[3]);
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let (first, second) = (first as usize, second as usize);
            let result = if kind == RECALL_GHOST {
                let Some(held) = ghosts.get(first) else {
                    return Err(format!("{}: no ghost {first}", scenario.name).into());
                };
                let recalled = remember_ghost(held, now, &mut rng);
                let described = describe_ghost(&recalled);
                if let Some(slot) = ghosts.get_mut(first) {
                    *slot = recalled;
                }
                described
            } else if kind == RECALL_WHISPER {
                let Some(held) = whispers.get(first) else {
                    return Err(format!("{}: no whisper {first}", scenario.name).into());
                };
                let recalled = remember_whisper(held, now, &mut rng);
                let described = describe_whisper(&recalled);
                if let Some(slot) = whispers.get_mut(first) {
                    *slot = recalled;
                }
                described
            } else if kind == COMPOSE {
                let (Some(one), Some(other)) = (ghosts.get(first), ghosts.get(second)) else {
                    return Err(format!("{}: no pair {first},{second}", scenario.name).into());
                };
                let made = create_false_memory(one, other, now, whispers.first());
                let described = describe_ghost(&made);
                ghosts.push(made);
                described
            } else if kind == CHOOSE {
                let chosen = choose_rare(&ghosts, now, &mut rng);
                serde_json::json!({ "chose": chosen.map(|index| {
                    ghosts.get(index).map_or("", |ghost| ghost.id.as_str())
                }) })
            } else {
                return Err(format!("{}: unknown step {kind}", scenario.name).into());
            };
            results.push(result);
        }

        out.push(serde_json::json!({
            "name": scenario.name,
            "steps": results,
            "draws": rng.draws(),
        }));
    }
    println!("{}", serde_json::to_string(&out)?);
    Ok(())
}
