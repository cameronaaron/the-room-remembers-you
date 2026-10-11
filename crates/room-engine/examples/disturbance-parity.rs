//! The native leg of the disturbance parity gate.
//!
//! Reads a scenario written by `scripts/disturbance-parity.ts` and prints
//! what this build of `room_engine::disturbance` decides for it, so it can be
//! compared against `lib/memory-disturbance.ts`, which remains authoritative
//! in the gallery until this agrees with it. Nothing here draws, so unlike
//! `memory-parity` there is no shared random stream to reproduce — the
//! scenario carries no seed.
//!
//! # Why the scenario is not JSON
//!
//! The same reason every other harness here gives: `serde_json` 1.0.151 does
//! not parse every `f64` to the nearest representable value. Several
//! scenarios here exist specifically to hover a projected point right at a
//! body radius, which is exactly the case a one-ULP rounding error would
//! falsify silently. The scenario arrives as raw little-endian `f64`. Results
//! go back as JSON, which is safe in that direction.
//!
//! Usage: `cargo run -p room-engine --example disturbance-parity -- scenario.bin`

use std::error::Error;

use room_engine::disturbance::{MemoryCollisions, disturbance_frame, memory_loss};
use room_engine::tracking::Track;
use room_protocol::{
    Extent, Ghost, Lineage, MemoryId, PathPoints, Point, TrackId, TrackPath, Vec2,
};

/// File magic. Bumped if the layout below ever changes, so a stale scenario
/// fails loudly rather than decoding as a different session.
const MAGIC: &[u8] = b"ROOMDIS1";

/// A quarter turn, matching `mapCameraPoint`'s `rotation === 90` case. Fixed
/// and shared by both legs so a bug in the plumbing that carries `project`
/// through cannot hide behind an accidental identity mapping.
fn project(point: Point) -> Vec2 {
    Vec2::new(1.0 - point.y, point.x)
}

struct WireTrack {
    id: u32,
    position: Point,
    previous: Point,
    extent: Extent,
    occluded: bool,
    sightings: u32,
}

impl WireTrack {
    fn to_track(&self) -> Track {
        Track {
            id: TrackId(self.id),
            born_at: 0.0,
            last_seen: self.position.t,
            position: self.position,
            previous: self.previous,
            velocity: Vec2::new(0.0, 0.0),
            speed: 0.0,
            still_for: 0.0,
            dwell_seconds: 0.0,
            path: TrackPath::new(),
            active: true,
            occluded: self.occluded,
            confidence: 1.0,
            sightings: self.sightings,
            extent: self.extent,
        }
    }
}

struct Tick {
    tracks: Vec<WireTrack>,
    ghosts: Vec<Ghost>,
    now: f64,
}

struct CrossingScenario {
    name: String,
    ticks: Vec<Tick>,
}

struct LossCase {
    created_at: f64,
    fidelity: f64,
    now: f64,
}

struct FrameCase {
    path: Vec<Point>,
    progress: f64,
    loss: f64,
}

/// A cursor over the scenario file. Every read is checked; a truncated file
/// is an error, never a short session that looks like a quiet gallery.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Result<Self, Box<dyn Error>> {
        if bytes.get(..MAGIC.len()) != Some(MAGIC) {
            return Err("not a disturbance scenario file".into());
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

    fn point(&mut self) -> Result<Point, Box<dyn Error>> {
        Ok(Point::new(self.f64()?, self.f64()?, self.f64()?))
    }

    fn wire_track(&mut self) -> Result<WireTrack, Box<dyn Error>> {
        let id = u32::try_from(self.u32()?)?;
        let position = self.point()?;
        let previous = self.point()?;
        let extent = Extent {
            width: self.f64()?,
            height: self.f64()?,
        };
        let occluded = self.u8()? != 0;
        let sightings = u32::try_from(self.u32()?)?;
        Ok(WireTrack {
            id,
            position,
            previous,
            extent,
            occluded,
            sightings,
        })
    }

    fn ghost(&mut self) -> Result<Ghost, Box<dyn Error>> {
        let raw = self.text()?;
        let id = MemoryId::new(&raw).map_err(|error| format!("{raw}: {error}"))?;
        let created_at = self.f64()?;
        let point_count = self.u32()?;
        let mut path = PathPoints::new();
        for _ in 0..point_count {
            path.push(self.point()?);
        }
        Ok(Ghost {
            id,
            created_at,
            last_replayed_at: 0.0,
            path,
            dwell_seconds: 0.0,
            intensity: 0.5,
            strength: 0.5,
            fidelity: 1.0,
            recall_count: 0,
            lineage: Lineage::new(),
            false_memory: false,
            day: 1,
        })
    }

    fn tick(&mut self) -> Result<Tick, Box<dyn Error>> {
        let track_count = self.u32()?;
        let mut tracks = Vec::with_capacity(track_count);
        for _ in 0..track_count {
            tracks.push(self.wire_track()?);
        }
        let ghost_count = self.u32()?;
        let mut ghosts = Vec::with_capacity(ghost_count);
        for _ in 0..ghost_count {
            ghosts.push(self.ghost()?);
        }
        let now = self.f64()?;
        Ok(Tick {
            tracks,
            ghosts,
            now,
        })
    }

    fn crossing_scenarios(&mut self) -> Result<Vec<CrossingScenario>, Box<dyn Error>> {
        let count = self.u32()?;
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            let name = self.text()?;
            let tick_count = self.u32()?;
            let mut ticks = Vec::with_capacity(tick_count);
            for _ in 0..tick_count {
                ticks.push(self.tick()?);
            }
            out.push(CrossingScenario { name, ticks });
        }
        Ok(out)
    }

    fn loss_cases(&mut self) -> Result<Vec<LossCase>, Box<dyn Error>> {
        let count = self.u32()?;
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            out.push(LossCase {
                created_at: self.f64()?,
                fidelity: self.f64()?,
                now: self.f64()?,
            });
        }
        Ok(out)
    }

    fn frame_cases(&mut self) -> Result<Vec<FrameCase>, Box<dyn Error>> {
        let count = self.u32()?;
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            let point_count = self.u32()?;
            let mut path = Vec::with_capacity(point_count);
            for _ in 0..point_count {
                path.push(self.point()?);
            }
            out.push(FrameCase {
                path,
                progress: self.f64()?,
                loss: self.f64()?,
            });
        }
        Ok(out)
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: disturbance-parity <scenario.bin>")?;
    let bytes = std::fs::read(path)?;
    let mut reader = Reader::new(&bytes)?;
    let scenarios = reader.crossing_scenarios()?;
    let losses = reader.loss_cases()?;
    let frames = reader.frame_cases()?;
    if reader.at != reader.bytes.len() {
        return Err("scenario file has trailing bytes".into());
    }

    let crossings: Vec<_> = scenarios
        .iter()
        .map(|scenario| {
            let mut collisions = MemoryCollisions::default();
            let hits: Vec<_> = scenario
                .ticks
                .iter()
                .map(|tick| {
                    let tracks: Vec<Track> = tick.tracks.iter().map(WireTrack::to_track).collect();
                    let hit = collisions.find(&tracks, &tick.ghosts, tick.now, project);
                    hit.map(|collision| {
                        serde_json::json!({
                            "ghostIndex": collision.ghost_index,
                            "at": [collision.at.x, collision.at.y],
                            "segmentIndex": collision.segment_index,
                            "trackId": collision.track_id.0,
                        })
                    })
                })
                .collect();
            serde_json::json!({ "name": scenario.name, "hits": hits, "tracked": collisions.tracked() })
        })
        .collect();

    let loss_results: Vec<f64> = losses
        .iter()
        .map(|case| memory_loss(case.created_at, case.fidelity, case.now))
        .collect();

    let frame_results: Vec<_> = frames
        .iter()
        .map(|case| {
            let result = disturbance_frame(&case.path, case.progress, case.loss);
            serde_json::json!({
                "end": result.end,
                "fade": result.fade,
                "path": result.path.iter().flat_map(|p| [p.x, p.y, p.t]).collect::<Vec<f64>>(),
            })
        })
        .collect();

    println!(
        "{}",
        serde_json::json!({ "crossings": crossings, "losses": loss_results, "frames": frame_results })
    );
    Ok(())
}
