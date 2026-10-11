//! The native leg of the personality parity gate.
//!
//! Reads a scenario written by `scripts/personality-parity.ts` and prints what
//! this build of `room_engine::personality` decides for each step, so it can
//! be compared against `choosePersonality` in `lib/memory-engine.ts`, which
//! remains authoritative in the gallery until this agrees with it.
//!
//! # Why the scenario is not JSON
//!
//! `choose_personality` carries no state between calls and draws from no RNG,
//! so there is no compounding here the way there is in recall. But the risk
//! `behavior-parity.rs` and `memory-parity.rs` document is not only about
//! compounding: `serde_json` 1.0.151 does not parse every `f64` to the nearest
//! representable value on its own, one value at a time. This harness exists
//! specifically to compare exact threshold values (a density of precisely
//! `0.004`, a speed of precisely `0.18`) against strict `<`/`>` comparisons, which
//! is exactly the case a single one-ULP rounding error would falsify silently.
//! The scenario therefore arrives as raw little-endian `f64`, like every other
//! parity harness here. Results go back as JSON, which is safe in that
//! direction.
//!
//! Usage: `cargo run -p room-engine --example personality-parity -- scenario.bin`

use std::error::Error;

use room_engine::personality::{TrackActivity, choose_personality};
use room_protocol::Personality;

/// File magic. Bumped if the layout below ever changes, so a stale scenario
/// fails loudly rather than decoding as a different session.
const MAGIC: &[u8] = b"ROOMPER1";

/// One independent call to `choose_personality`. Steps do not chain: `previous`
/// is given explicitly, matching how the TypeScript caller supplies it (the
/// engine holds no personality state of its own).
struct Step {
    tracks: Vec<TrackActivity>,
    empty_seconds: f64,
    density: f64,
    previous: Personality,
}

struct Scenario {
    name: String,
    steps: Vec<Step>,
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
            return Err("not a personality scenario file".into());
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

    fn u8(&mut self) -> Result<u8, Box<dyn Error>> {
        let bytes: [u8; 1] = self.take(1)?.try_into()?;
        Ok(u8::from_le_bytes(bytes))
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

    /// Wire order matches `scripts/personality-parity.ts`'s `PERSONALITIES`.
    fn personality(&mut self) -> Result<Personality, Box<dyn Error>> {
        match self.u8()? {
            0 => Ok(Personality::Dormant),
            1 => Ok(Personality::Curious),
            2 => Ok(Personality::Attentive),
            3 => Ok(Personality::Crowded),
            4 => Ok(Personality::Overwhelmed),
            5 => Ok(Personality::Lonely),
            6 => Ok(Personality::Remembering),
            7 => Ok(Personality::Forgetting),
            other => Err(format!("unknown personality tag {other}").into()),
        }
    }

    fn step(&mut self) -> Result<Step, Box<dyn Error>> {
        let track_count = self.u32()?;
        let mut tracks = Vec::with_capacity(track_count);
        for _ in 0..track_count {
            tracks.push(TrackActivity {
                speed: self.f64()?,
                still_for: self.f64()?,
            });
        }
        Ok(Step {
            tracks,
            empty_seconds: self.f64()?,
            density: self.f64()?,
            previous: self.personality()?,
        })
    }

    fn scenarios(&mut self) -> Result<Vec<Scenario>, Box<dyn Error>> {
        let count = self.u32()?;
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            let name = self.text()?;
            let step_count = self.u32()?;
            let mut steps = Vec::with_capacity(step_count);
            for _ in 0..step_count {
                steps.push(self.step()?);
            }
            out.push(Scenario { name, steps });
        }
        if self.at != self.bytes.len() {
            return Err("scenario file has trailing bytes".into());
        }
        Ok(out)
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: personality-parity <scenario.bin>")?;
    let bytes = std::fs::read(path)?;
    let scenarios = Reader::new(&bytes)?.scenarios()?;

    let mut out = Vec::with_capacity(scenarios.len());
    for scenario in scenarios {
        let results: Vec<&str> = scenario
            .steps
            .iter()
            .map(|step| {
                choose_personality(
                    &step.tracks,
                    step.empty_seconds,
                    step.density,
                    step.previous,
                )
                .as_str()
            })
            .collect();
        out.push(serde_json::json!({ "name": scenario.name, "steps": results }));
    }
    println!("{}", serde_json::to_string(&out)?);
    Ok(())
}
