//! The native leg of the interest parity gate.
//!
//! Reads a scenario written by `scripts/attention-parity.ts` and prints what
//! this build of the engine does with it, so that the same Rust source compiled
//! for `aarch64` and for `wasm32` can be compared on the same input. That is a
//! weaker claim here than it is for tracking — the interest rules are
//! comparisons and one division, with no `hypot` or `powf` anywhere — which is
//! exactly why it is worth running: a leg that cannot plausibly diverge and
//! then does is a finding about the toolchain rather than the artwork.
//!
//! # Why the scenario is not JSON
//!
//! The same reason the tracking harness gives, and it is not hypothetical
//! here either: **`serde_json` 1.0.151 does not parse every `f64` to the
//! nearest representable value**. `0.20400000000000001` comes back as `0.204`,
//! one unit in the last place low, where `str::parse::<f64>` is exact. A
//! timestamp one ULP early is a filing on the wrong side of a 20 000 ms gate,
//! which is a different session. The scenario therefore arrives as raw
//! little-endian `f64`. Results go back as JSON, which is safe in that
//! direction: `ryu`'s shortest form round trips through V8's correctly-rounded
//! parser.
//!
//! Usage: `cargo run -p room-engine --example attention-parity -- scenario.bin`

use std::error::Error;

use room_engine::attention_engine::AttentionEngine;

/// File magic. Bumped if the layout below ever changes, so a stale scenario
/// fails loudly rather than decoding as a different session.
const MAGIC: &[u8] = b"ROOMATT1";

#[derive(Debug)]
struct Scenario {
    name: String,
    /// One packed engine frame per sensing tick, already in the layout
    /// `AttentionEngine::step` reads.
    frames: Vec<Vec<f64>>,
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
            return Err("not an attention scenario file".into());
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

    fn scenarios(&mut self) -> Result<Vec<Scenario>, Box<dyn Error>> {
        let count = self.u32()?;
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            let name = self.text()?;
            let frame_count = self.u32()?;
            let mut frames = Vec::with_capacity(frame_count);
            for _ in 0..frame_count {
                let values = self.u32()?;
                let mut frame = Vec::with_capacity(values);
                for _ in 0..values {
                    frame.push(self.f64()?);
                }
                frames.push(frame);
            }
            out.push(Scenario { name, frames });
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
        .ok_or("usage: attention-parity <scenario.bin>")?;
    let bytes = std::fs::read(path)?;
    let scenarios = Reader::new(&bytes)?.scenarios()?;
    let mut out = Vec::with_capacity(scenarios.len());
    for scenario in scenarios {
        let mut engine = AttentionEngine::new();
        let mut frames = Vec::with_capacity(scenario.frames.len());
        for frame in &scenario.frames {
            // Every scenario the harness writes is a frame this engine
            // accepts, so a refusal here is the harness disagreeing with the
            // engine about the layout. That fails the run loudly rather than
            // printing a short scenario, which the comparison would otherwise
            // read as agreement on every frame it never reached.
            match engine.step(frame) {
                Ok(values) => frames.push(values),
                Err(error) => {
                    return Err(format!("{}: {}", scenario.name, error.message()).into());
                }
            }
        }
        out.push(serde_json::json!({ "name": scenario.name, "frames": frames }));
    }
    println!("{}", serde_json::to_string(&out)?);
    Ok(())
}
