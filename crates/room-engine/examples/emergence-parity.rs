//! The native leg of the emergence parity gate.
//!
//! Reads a scenario written by `scripts/emergence-parity.ts` and prints what
//! this build of `room_engine::emergence` decides tick by tick, so it can be
//! compared against `RoomEmergence.detect()` in `lib/room-emergence.ts`,
//! which remains authoritative in the gallery until this agrees with it.
//!
//! # Why this one needs a shared random stream
//!
//! Five of the six branches draw, in an order that is part of the contract.
//! Like `memory-parity`, the scenario carries a seed rather than a list of
//! draws: a scenario that carried the draws could not catch a leg that
//! consumed them in the wrong order.
//!
//! # Why the scenario is not JSON
//!
//! The same reason every other harness here gives:
//! `serde_json` 1.0.151 does not parse every `f64` to the nearest
//! representable value. The scenario arrives as raw little-endian `f64`.
//! Results go back as JSON, which is safe in that direction.
//!
//! Usage: `cargo run -p room-engine --example emergence-parity -- scenario.bin`

use std::error::Error;

use room_engine::disturbance::MemoryCollisions;
use room_engine::emergence::{ActiveGhost, Disturbance, EmergenceRoom, EmergenceState, detect};
use room_engine::rng::Rng;
use room_engine::tracking::Track;
use room_protocol::{
    Extent, Ghost, Lifecycle, Lineage, MemoryId, PathPoints, Point, RecallKind, TrackId, TrackPath,
    Vec2, Whisper,
};

const MAGIC: &[u8] = b"ROOMEMR1";

/// A quarter turn, matching `mapCameraPoint`'s `rotation === 90` case, same
/// choice `disturbance-parity` and `personality-parity` made: fixed and
/// shared by both legs so a bug in the plumbing that carries `project`
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
    still_for: f64,
    path: Vec<Point>,
}

impl WireTrack {
    fn to_track(&self) -> Track {
        let mut path = TrackPath::new();
        for &point in &self.path {
            path.push(point);
        }
        Track {
            id: TrackId(self.id),
            born_at: 0.0,
            last_seen: self.position.t,
            position: self.position,
            previous: self.previous,
            velocity: Vec2::new(0.0, 0.0),
            speed: 0.0,
            still_for: self.still_for,
            dwell_seconds: 0.0,
            path,
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
    ghost_frequency: f64,
    lifecycle: Lifecycle,
    empty_seconds: f64,
    now: f64,
    wall: f64,
    attention: Option<(u32, f64)>,
    has_recording: bool,
}

struct Scenario {
    name: String,
    seed: u64,
    ghosts: Vec<Ghost>,
    whispers: Vec<Whisper>,
    ticks: Vec<Tick>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Result<Self, Box<dyn Error>> {
        if bytes.get(..MAGIC.len()) != Some(MAGIC) {
            return Err("not an emergence scenario file".into());
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
            path.push(self.point()?);
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
        let mut envelope = room_protocol::Envelope::new();
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
        let still_for = self.f64()?;
        let point_count = self.u32()?;
        let mut path = Vec::with_capacity(point_count);
        for _ in 0..point_count {
            path.push(self.point()?);
        }
        Ok(WireTrack {
            id,
            position,
            previous,
            extent,
            occluded,
            sightings,
            still_for,
            path,
        })
    }

    fn lifecycle(&mut self) -> Result<Lifecycle, Box<dyn Error>> {
        match self.u8()? {
            0 => Ok(Lifecycle::Opening),
            1 => Ok(Lifecycle::Active),
            2 => Ok(Lifecycle::Closing),
            3 => Ok(Lifecycle::AfterHours),
            other => Err(format!("unknown lifecycle tag {other}").into()),
        }
    }

    fn tick(&mut self) -> Result<Tick, Box<dyn Error>> {
        let track_count = self.u32()?;
        let mut tracks = Vec::with_capacity(track_count);
        for _ in 0..track_count {
            tracks.push(self.wire_track()?);
        }
        let ghost_frequency = self.f64()?;
        let lifecycle = self.lifecycle()?;
        let empty_seconds = self.f64()?;
        let now = self.f64()?;
        let wall = self.f64()?;
        let attention = if self.u8()? != 0 {
            Some((u32::try_from(self.u32()?)?, self.f64()?))
        } else {
            None
        };
        let has_recording = self.u8()? != 0;
        Ok(Tick {
            tracks,
            ghost_frequency,
            lifecycle,
            empty_seconds,
            now,
            wall,
            attention,
            has_recording,
        })
    }

    fn scenarios(&mut self) -> Result<Vec<Scenario>, Box<dyn Error>> {
        let count = self.u32()?;
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            let name = self.text()?;
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let seed = self.f64()? as u64;
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
            let tick_count = self.u32()?;
            let mut ticks = Vec::with_capacity(tick_count);
            for _ in 0..tick_count {
                ticks.push(self.tick()?);
            }
            out.push(Scenario {
                name,
                seed,
                ghosts,
                whispers,
                ticks,
            });
        }
        if self.at != self.bytes.len() {
            return Err("scenario file has trailing bytes".into());
        }
        Ok(out)
    }
}

/// One ghost, flattened for comparison. Field order matches
/// `examples/memory-parity.rs`'s `describe_ghost`.
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

fn recall_kind_tag(kind: RecallKind) -> u8 {
    match kind {
        RecallKind::Ghost => 0,
        RecallKind::Stillness => 1,
        RecallKind::Empty => 2,
        RecallKind::Return => 3,
        RecallKind::Convergence => 4,
        RecallKind::False => 5,
    }
}

fn describe_active(active: &ActiveGhost) -> serde_json::Value {
    serde_json::json!({
        "ghost": describe_ghost(&active.ghost),
        "startedAt": active.started_at,
        "kind": recall_kind_tag(active.kind),
        "disturbance": active.disturbance.map(|d: Disturbance| {
            serde_json::json!({
                "loss": d.loss,
                "at": [d.at.x, d.at.y],
                "voicePlayed": d.voice_played,
                "admitted": d.admitted,
            })
        }),
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: emergence-parity <scenario.bin>")?;
    let bytes = std::fs::read(path)?;
    let scenarios = Reader::new(&bytes)?.scenarios()?;

    let mut out = Vec::with_capacity(scenarios.len());
    for scenario in scenarios {
        let mut rng = Rng::new(scenario.seed);
        let mut ghosts = scenario.ghosts.clone();
        let mut whispers = scenario.whispers.clone();
        let mut active: Vec<ActiveGhost> = Vec::new();
        let mut collisions = MemoryCollisions::default();
        let mut state = EmergenceState::new();
        let mut steps = Vec::with_capacity(scenario.ticks.len());

        for tick in &scenario.ticks {
            let tracks: Vec<Track> = tick.tracks.iter().map(WireTrack::to_track).collect();
            let attention = tick.attention.map(|(id, weight)| (TrackId(id), weight));
            let has_recording = tick.has_recording;
            let mut room = EmergenceRoom {
                tracks: &tracks,
                ghosts: &mut ghosts,
                whispers: &mut whispers,
                active: &mut active,
                collisions: &mut collisions,
                ghost_frequency: tick.ghost_frequency,
                // Matches `typescriptLeg`'s room literal in
                // `scripts/emergence-parity.ts`, which hardcodes the same.
                day: 1,
                lifecycle: tick.lifecycle,
                empty_seconds: tick.empty_seconds,
                now: tick.now,
                wall: tick.wall,
                attention,
            };
            let outcome = detect(
                &mut state,
                &mut room,
                &project,
                &|_: &MemoryId| has_recording,
                &mut rng,
            );
            let utterances: Vec<_> = outcome
                .utterances
                .iter()
                .map(|u| serde_json::json!({ "kind": u.kind as u8, "at": [u.at.x, u.at.y] }))
                .collect();
            let voice_cues: Vec<_> = outcome
                .voice_cues
                .iter()
                .map(|c| serde_json::json!({ "whisperIndex": c.whisper_index, "loss": c.loss }))
                .collect();
            steps.push(serde_json::json!({
                "utterances": utterances,
                "event": outcome.event,
                "voiceCues": voice_cues,
                "ghosts": ghosts.iter().map(describe_ghost).collect::<Vec<_>>(),
                "whispers": whispers.iter().map(describe_whisper).collect::<Vec<_>>(),
                "active": active.iter().map(describe_active).collect::<Vec<_>>(),
            }));

            // `detect` never removes a finished presentation — that is
            // `composeRoomBodies`'s job in the real shell, not the
            // scheduler's. Both legs prune identically here; see the
            // matching step in `scripts/emergence-parity.ts`.
            let now = tick.now;
            active.retain(|entry| now - entry.started_at < entry.kind.duration_ms());
        }

        out.push(
            serde_json::json!({ "name": scenario.name, "steps": steps, "draws": rng.draws() }),
        );
    }
    println!("{}", serde_json::to_string(&out)?);
    Ok(())
}
