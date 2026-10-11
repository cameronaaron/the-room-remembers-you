//! The native leg of the tracking parity gate.
//!
//! Reads a scenario written by `scripts/tracking-parity.ts` and prints what
//! this build of the engine does with it, so that the same Rust source compiled
//! for `aarch64` and for `wasm32` can be compared on the same input. The two
//! targets reach different `libm` implementations for `hypot` and `powf`, and
//! "it is the same code" is not evidence that it produces the same room.
//!
//! # Why the scenario is not JSON
//!
//! It was, and the gate reported sixty-nine disagreements that were entirely
//! the transport's. **`serde_json` 1.0.151 does not parse every `f64` to the
//! nearest representable value**: `0.20400000000000001` comes back as `0.204`,
//! one unit in the last place low, where `str::parse::<f64>` gets it right.
//! Every scenario coordinate is a seventeen-digit decimal written by
//! `JSON.stringify`, so the native leg was being fed a *different session* from
//! the WASM leg and the difference showed up as a path point recorded a frame
//! late. Validate the instrument before trusting the measurement.
//!
//! The scenario therefore arrives as raw little-endian `f64`, which has no
//! rounding step to get wrong. The results go back as JSON, which is safe in
//! that direction: `serde_json` writes through `ryu`, whose shortest form round
//! trips under the correctly-rounded parser V8 has.
//!
//! Usage: `cargo run -p room-engine --example tracking-parity -- scenario.bin`

use std::error::Error;

use room_engine::track_engine::{Field, HEADER_FIELDS, RECORD_FIELDS, TrackEngine};

/// One sensing frame: when it happened and what was detected.
#[derive(Debug)]
struct Frame {
    now: f64,
    /// Five values per region, already flattened by the caller.
    blobs: Vec<f64>,
}

#[derive(Debug)]
struct Scenario {
    name: String,
    frames: Vec<Frame>,
}

/// File magic. Bumped if the layout below ever changes, so a stale scenario
/// fails loudly rather than decoding as a different session.
const MAGIC: &[u8] = b"ROOMSCN1";

/// A cursor over the scenario file. Every read is checked; a truncated file is
/// an error, never a short session that looks like a quiet gallery.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Result<Self, Box<dyn Error>> {
        if bytes.get(..MAGIC.len()) != Some(MAGIC) {
            return Err("not a room scenario file".into());
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
                let now = self.f64()?;
                let values = self.u32()?;
                let mut blobs = Vec::with_capacity(values);
                for _ in 0..values {
                    blobs.push(self.f64()?);
                }
                frames.push(Frame { now, blobs });
            }
            out.push(Scenario { name, frames });
        }
        if self.at != self.bytes.len() {
            return Err("scenario file has trailing bytes".into());
        }
        Ok(out)
    }
}

/// The values compared across runtimes, per active track.
///
/// Not the whole record: an id is minted independently on each side and a full
/// path multiplies the report by three hundred without adding a claim the last
/// point does not already make.
const REPORTED: [Field; 11] = [
    Field::X,
    Field::Y,
    Field::Speed,
    Field::StillFor,
    Field::DwellSeconds,
    Field::Confidence,
    Field::Sightings,
    Field::Occluded,
    Field::Active,
    Field::VelocityX,
    Field::VelocityY,
];

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: tracking-parity <scenario.bin>")?;
    let bytes = std::fs::read(path)?;
    let scenarios = Reader::new(&bytes)?.scenarios()?;
    let mut out = Vec::with_capacity(scenarios.len());
    for scenario in scenarios {
        let mut engine = TrackEngine::new();
        let mut frames = Vec::with_capacity(scenario.frames.len());
        for frame in scenario.frames {
            let produced = engine.step(&frame.blobs, frame.now)?;
            frames.push(summarise(&produced)?);
        }
        out.push(serde_json::json!({ "name": scenario.name, "frames": frames }));
    }
    println!("{}", serde_json::to_string(&out)?);
    Ok(())
}

/// Reduce one engine frame to the numbers the gate compares.
fn summarise(frame: &[f64]) -> Result<Vec<f64>, Box<dyn Error>> {
    let header: &[f64] = frame.get(..HEADER_FIELDS).ok_or("frame has no header")?;
    let mut out = header.to_vec();
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let active = header.first().copied().unwrap_or(0.0) as usize;
    let mut cursor = HEADER_FIELDS;
    for _ in 0..active {
        let record = frame
            .get(cursor..cursor + RECORD_FIELDS)
            .ok_or("record is truncated")?;
        for field in REPORTED {
            out.push(*record.get(field as usize).ok_or("field is missing")?);
        }
        let length = *record
            .get(Field::PathLength as usize)
            .ok_or("path length is missing")?;
        out.push(length);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let points = length as usize;
        cursor += RECORD_FIELDS + points * 3;
    }
    Ok(out)
}
