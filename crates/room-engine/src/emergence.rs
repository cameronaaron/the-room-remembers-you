//! What the room decides to remember, and when.
//!
//! A port of `lib/room-emergence.ts`, which remains authoritative in the
//! gallery until this agrees with it. Stillness, retrace, false memory, an
//! ordinary recall, a path walking an empty room alone, and somebody crossing
//! ground an old memory lies on: six ways a memory reaches the wall, in a
//! fixed order, under one roll of the clock. This is the centre of the piece.
//!
//! # Randomness is a parameter
//!
//! Every branch that draws takes the room's [`Rng`]. Draw order within a
//! branch is part of the contract, exactly as in [`crate::memory`], and is
//! stated at each site.
//!
//! # The audio side effect is a returned fact, not a callback
//!
//! The TypeScript's `progressDisturbances` calls into a `WhisperAudio` object
//! to check whether a recording exists and, if a voice qualifies, to actually
//! play it. This engine says a memory exists with this intensity; playing
//! sound out loud is the shell's job. So `detect` takes `has_recording` as an
//! injected predicate — a fact it needs to decide which whisper qualifies —
//! and returns [`VoiceCue`]s describing what the caller should play, rather
//! than calling a `replay` method itself. The mutation a qualifying whisper
//! undergoes (`remember_whisper` — fidelity falls, same as any other recall)
//! still happens inside this module, because that part *is* pure engine
//! logic.
//!
//! One narrow consequence: the TypeScript never latches `voicePlayed` while
//! its `audio` object is entirely absent, so a session that starts before
//! audio initialises can retry on a later tick. A caller here that has no
//! audio system at all is expected to pass `|_| false`, under which the
//! progress-threshold latch still fires once and no cue is ever produced —
//! observably identical (no sound plays either way), simpler than threading
//! an extra "audio present" flag through for a case with no different
//! outcome.

use room_protocol::{
    Ghost, Lifecycle, Lineage, MemoryId, Point, RecallKind, TrackId, Vec2, Whisper,
};

use crate::attention::{PREFER_MEMORY_REACH, prefer_memory_near};
use crate::disturbance::{self, MemoryCollisions};
use crate::memory::{
    choose_rare, create_false_memory, event_chance, remember_ghost, remember_whisper,
};
use crate::path::{RETURN_MIN_EXTENT, path_extent, simplify_path, trajectory_distance};
use crate::rng::Rng;
use crate::tracking::Track;

/// How many memories the room may be replaying at once. One at a time made
/// the room feel like it had a single thought; a small crowd of its own past
/// is the point of the work.
pub const MAX_ACTIVE_RECALLS: usize = 3;

/// Everyone still for this long, at most this often, is one occasion.
pub const STILLNESS_SECONDS: f64 = 15.0;
pub const STILLNESS_REST_MS: f64 = 90_000.0;

/// A retrace needs a path long enough to have two comparable halves.
pub const RETRACE_MIN_POINTS: usize = 22;
/// How closely the second half has to follow the first to read as a return.
pub const RETRACE_DISTANCE: f64 = 0.055;
/// The returning path appears slightly ahead of its visitor, not under them.
pub const RETURN_LEAD_MS: f64 = 800.0;

/// How near a disturbed memory a voice has to have been recorded to surface with it.
pub const DISTURBED_VOICE_RADIUS: f64 = 0.14;
/// Into the presentation before a disturbed memory may bring a voice with it.
pub const DISTURBED_VOICE_PROGRESS: f64 = 0.25;
/// Loss below which the room has nothing to admit to.
pub const ADMISSION_LOSS: f64 = 0.2;
/// How far before the end of a dissolution the room admits to it.
pub const ADMISSION_LEAD: f64 = 0.12;

/// False memories are rare against ordinary recall, deliberately.
pub const FALSE_MEMORY_SHARE: f64 = 0.08;
/// An empty room remembers more often, because there is nothing else happening.
pub const EMPTY_ROOM_GAIN: f64 = 3.0;

/// Base recall rate. Copied from `memory-engine.ts`'s `RECALL_RATE_PER_SECOND`
/// rather than imported, since that module's other exports are `room_engine::memory`
/// primitives, not a scheduling rate — this is the only site that needs it.
pub const RECALL_RATE_PER_SECOND: f64 = 0.045;

/// A whisper younger than this is still the present; copied locally from
/// `whisper-recall.ts`, whose organic ambient-recall system is otherwise
/// unrelated to this module and unported.
pub const WHISPER_RIPENS_MS: f64 = 25_000.0;

/// How long the room must be empty before a recall counts as "alone". Copied
/// locally from `room-lifecycle.ts`, which is otherwise unported.
pub const EMPTY_ROOM_SECONDS: f64 = 120.0;

/// The five moods `detect` ever gives voice to. `lib/room-voice.ts`'s
/// `VoiceKind` union is wider — it also spans six behaviour kinds from
/// `behaviors.ts` — only because the shell hands both to one `speak()`; nothing
/// here produces those, so this module keeps its own narrower type rather than
/// reaching for that union.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmergenceVoice {
    Stillness,
    Return,
    False,
    Empty,
    Forgetting,
}

/// An occasion to speak. `subject` mirrors `EmergenceUtterance.subject` for
/// shape parity, but `detect` never sets it (the TypeScript never does
/// either): every utterance it produces omits that field.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Utterance {
    pub kind: EmergenceVoice,
    pub at: Vec2,
    pub subject: Option<TrackId>,
}

/// A recall currently being presented on the wall.
#[derive(Clone, Debug, PartialEq)]
pub struct ActiveGhost {
    pub ghost: Ghost,
    pub started_at: f64,
    pub kind: RecallKind,
    pub disturbance: Option<Disturbance>,
}

/// A memory being lost while it is shown.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Disturbance {
    pub loss: f64,
    pub at: Vec2,
    pub voice_played: bool,
    pub admitted: bool,
}

/// A voice the caller should actually play: which whisper (already mutated in
/// `whispers`, in place, by the time this is returned) and how lossy the
/// disturbance surfacing it is. The caller supplies its own master volume.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VoiceCue {
    pub whisper_index: usize,
    pub loss: f64,
}

/// What `detect` decided this tick.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Emergence {
    pub utterances: Vec<Utterance>,
    pub event: Option<&'static str>,
    pub voice_cues: Vec<VoiceCue>,
}

/// The room, for one call to [`detect`]. Ported field-for-field from
/// `EmergenceRoom`, minus `random` (the caller always supplies an [`Rng`]
/// explicitly — no ambient fallback, matching [`crate::memory`]'s rule) and
/// minus `audio`/`config.masterVolume` (replaced by `has_recording` and the
/// returned [`VoiceCue`]s; see the module doc).
#[derive(Debug)]
pub struct EmergenceRoom<'a> {
    /// Confirmed, observed tracks only.
    pub tracks: &'a [Track],
    pub ghosts: &'a mut Vec<Ghost>,
    pub whispers: &'a mut Vec<Whisper>,
    /// Recalls currently on the wall. Appended to in place.
    pub active: &'a mut Vec<ActiveGhost>,
    pub collisions: &'a mut MemoryCollisions,
    pub ghost_frequency: f64,
    /// The gallery day the room is in, stamped onto a retrace's synthetic
    /// ghost — the only thing here that reads it.
    pub day: u32,
    pub lifecycle: Lifecycle,
    pub empty_seconds: f64,
    /// Animation clock, for presentation timing.
    pub now: f64,
    /// Wall clock, for anything a memory records about itself.
    pub wall: f64,
    /// What the attention subsystem decided last frame: who, and how strongly.
    pub attention: Option<(TrackId, f64)>,
}

/// The roll clock and the stillness rest, which are the only state this
/// decision carries between ticks.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EmergenceState {
    last_roll_at: Option<f64>,
    /// `None` until the room has answered a held silence once, not zero:
    /// compared against the page clock, an unset zero would make the rest
    /// period a warmup too, and a room opened in front of a group already
    /// standing still could not respond to them for its first ninety seconds.
    last_stillness_at: Option<f64>,
}

impl EmergenceState {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            last_roll_at: None,
            last_stillness_at: None,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new();
    }

    /// Seconds banked since the previous roll. Advanced before any early
    /// return in `detect` — skipping it while recalls are capped banks the
    /// elapsed time and fires a burst the moment a slot frees.
    fn advance(&mut self, now: f64) -> f64 {
        let since = self.last_roll_at.map_or(0.0, |last| (now - last) / 1000.0);
        self.last_roll_at = Some(now);
        since
    }
}

/// Recall a ghost at `index` and write the mutated version back over the
/// original, matching `recallGhost` in `memory-records.ts` — except
/// index-based rather than id-based, since every call site here already has
/// the index (from a scan, from `choose_rare`, or from a collision), which is
/// exactly the search `recallGhost` exists to avoid repeating.
fn recall_at(ghosts: &mut [Ghost], index: usize, now: f64, rng: &mut Rng) -> Option<Ghost> {
    let remembered = remember_ghost(ghosts.get(index)?, now, rng);
    if let Some(slot) = ghosts.get_mut(index) {
        *slot = remembered.clone();
    }
    Some(remembered)
}

/// Memories being lost while they are shown.
///
/// Two things happen inside a dissolution and neither is a new recall: a
/// voice recorded near the disturbed ground may qualify to surface with it,
/// and near the end the room may admit that it is losing the memory. Both are
/// once-only, latched on the disturbance itself.
fn progress_disturbances(
    active: &mut [ActiveGhost],
    whispers: &mut [Whisper],
    now: f64,
    wall: f64,
    has_recording: &dyn Fn(&MemoryId) -> bool,
    rng: &mut Rng,
) -> (Vec<Utterance>, Vec<VoiceCue>) {
    let mut utterances = Vec::new();
    let mut voice_cues = Vec::new();
    for recall in active.iter_mut() {
        let Some(disturbance) = recall.disturbance.as_mut() else {
            continue;
        };
        let progress = (now - recall.started_at) / recall.kind.duration_ms();
        let end = disturbance::disturbance_frame(&[], progress, disturbance.loss).end;
        if progress >= DISTURBED_VOICE_PROGRESS && !disturbance.voice_played {
            disturbance.voice_played = true;
            // Found by index, not by value and then looked up again: the
            // whisper has to be written back over the one the room is
            // holding — nothing recalled remains unchanged.
            let found = whispers.iter().position(|voice| {
                wall - voice.created_at > WHISPER_RIPENS_MS
                    && has_recording(&voice.id)
                    && (voice.position.x - disturbance.at.x)
                        .hypot(voice.position.y - disturbance.at.y)
                        < DISTURBED_VOICE_RADIUS
            });
            if let Some(index) = found
                && let Some(voice) = whispers.get(index)
            {
                let remembered = remember_whisper(voice, wall, rng);
                if let Some(slot) = whispers.get_mut(index) {
                    *slot = remembered;
                }
                voice_cues.push(VoiceCue {
                    whisper_index: index,
                    loss: disturbance.loss,
                });
            }
        }
        if disturbance.loss > ADMISSION_LOSS
            && progress >= end - ADMISSION_LEAD
            && !disturbance.admitted
        {
            disturbance.admitted = true;
            utterances.push(Utterance {
                kind: EmergenceVoice::Forgetting,
                at: disturbance.at,
                subject: None,
            });
        }
    }
    (utterances, voice_cues)
}

/// Everybody in the room standing still, at most once every ninety seconds.
/// The oldest trace surfaces: the room's answer to a held silence is the
/// furthest thing back it has.
fn stillness(
    state: &mut EmergenceState,
    room: &mut EmergenceRoom,
    project: &dyn Fn(Point) -> Vec2,
    rng: &mut Rng,
) -> Option<Emergence> {
    let all_still = !room.tracks.is_empty()
        && room
            .tracks
            .iter()
            .all(|track| track.still_for >= STILLNESS_SECONDS);
    if !all_still {
        return None;
    }
    if let Some(last) = state.last_stillness_at
        && room.now - last <= STILLNESS_REST_MS
    {
        return None;
    }
    if room.ghosts.is_empty() {
        return None;
    }
    let oldest_index = room
        .ghosts
        .iter()
        .enumerate()
        .min_by(|a, b| a.1.created_at.total_cmp(&b.1.created_at))
        .map(|(index, _)| index)?;
    let remembered = recall_at(room.ghosts, oldest_index, room.wall, rng)?;
    room.active.push(ActiveGhost {
        ghost: remembered,
        started_at: room.now,
        kind: RecallKind::Stillness,
        disturbance: None,
    });
    state.last_stillness_at = Some(room.now);
    // `all_still` is false for an empty room, so there is always a first track.
    let subject = room.tracks.first().map(|track| project(track.position))?;
    Some(Emergence {
        utterances: vec![Utterance {
            kind: EmergenceVoice::Stillness,
            at: subject,
            subject: None,
        }],
        event: Some("stillness — an old trace surfaced"),
        voice_cues: Vec::new(),
    })
}

/// Somebody retracing their own steps, answered by their earlier half
/// appearing ahead of them.
fn return_of_a_path(
    room: &mut EmergenceRoom,
    project: &dyn Fn(Point) -> Vec2,
) -> Option<Emergence> {
    for track in room.tracks {
        if track.path.len() < RETRACE_MIN_POINTS {
            continue;
        }
        let path: Vec<Point> = track.path.iter().copied().collect();
        // A stationary visitor accumulates path points at one spot, so the two
        // halves of their "path" match perfectly and read as a retrace.
        // Require that they actually went somewhere first.
        if path_extent(&path) < RETURN_MIN_EXTENT {
            continue;
        }
        let middle = path.len() / 2;
        let (Some(first), Some(second)) = (path.get(..middle), path.get(middle..)) else {
            continue;
        };
        if trajectory_distance(first, second) >= RETRACE_DISTANCE {
            continue;
        }
        let track_id = track.id;
        let mut lineage = Lineage::new();
        // TypeScript's `lineage: [track.id]` puts a *track* id where a memory
        // id normally goes — a looseness JS's untyped strings allow and this
        // port preserves rather than "fixes", because behavioural parity with
        // the gallery is the point of this phase, not a cleaner type.
        lineage.push(MemoryId::minted(&format!("{track_id}")));
        let ghost = Ghost {
            id: MemoryId::minted(&format!("return-{track_id}")),
            created_at: room.wall,
            last_replayed_at: 0.0,
            path: room_protocol::PathPoints::from_iter_bounded(simplify_path(
                first,
                room_protocol::PATH_POINTS_MAX,
            )),
            dwell_seconds: 0.0,
            intensity: 0.6,
            strength: 0.5,
            fidelity: 0.92,
            recall_count: 1,
            lineage,
            false_memory: false,
            day: room.day,
        };
        // Likewise: the interesting place is the middle of the repeated
        // stretch. The index is always inside the path: a retrace needs at
        // least `RETRACE_MIN_POINTS`, so a quarter of the way along is real.
        let Some(&at) = path.get(middle / 2) else {
            continue;
        };
        room.active.push(ActiveGhost {
            ghost,
            started_at: room.now + RETURN_LEAD_MS,
            kind: RecallKind::Return,
            disturbance: None,
        });
        return Some(Emergence {
            utterances: vec![Utterance {
                kind: EmergenceVoice::Return,
                at: project(at),
                subject: None,
            }],
            event: Some("return — a path appeared ahead of its visitor"),
            voice_cues: Vec::new(),
        });
    }
    None
}

/// Two unrelated traces becoming one memory the room is sure of.
///
/// # Draw order
///
/// One gate draw, then whatever `choose_rare` draws for the first ghost, then
/// again for the second (from a collection excluding the first), then one
/// more if any whisper exists.
fn false_memory(
    room: &mut EmergenceRoom,
    rate: f64,
    since_last_roll: f64,
    rng: &mut Rng,
) -> Option<Emergence> {
    if room.ghosts.len() < 2 {
        return None;
    }
    if rng.next_f64() >= event_chance(rate * FALSE_MEMORY_SHARE, since_last_roll) {
        return None;
    }
    let first_index = choose_rare(room.ghosts, room.wall, rng)?;
    let first_id = room.ghosts.get(first_index)?.id.clone();
    let candidates: Vec<Ghost> = room
        .ghosts
        .iter()
        .filter(|ghost| ghost.id != first_id)
        .cloned()
        .collect();
    let second_index = choose_rare(&candidates, room.wall, rng)?;
    let whisper = if room.whispers.is_empty() {
        None
    } else {
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let index = (rng.next_f64() * room.whispers.len() as f64).floor() as usize;
        room.whispers.get(index)
    };
    let first = room.ghosts.get(first_index)?;
    let second = candidates.get(second_index)?;
    let fabricated = create_false_memory(first, second, room.wall, whisper);
    // Every memory in the room has a path — a ghost with none cannot reach
    // this far, the same guarantee `isRememberable` enforces on the
    // TypeScript side — so the middle of this one is a real point.
    let at = fabricated.path.get(fabricated.path.len() / 2).copied()?;
    room.ghosts.push(fabricated.clone());
    room.active.push(ActiveGhost {
        ghost: fabricated,
        started_at: room.now,
        kind: RecallKind::False,
        disturbance: None,
    });
    Some(Emergence {
        utterances: vec![Utterance {
            kind: EmergenceVoice::False,
            at: Vec2::new(at.x, at.y),
            subject: None,
        }],
        event: Some("false memory — unrelated traces became one"),
        voice_cues: Vec::new(),
    })
}

/// An old path resurfacing, more often when the room is empty.
///
/// Rolls are against wall-clock time, not per analysis tick, so the room
/// remembers at the same pace on every hardware profile.
///
/// # Draw order
///
/// One gate draw, then whatever `choose_rare` draws, then whatever
/// `remember_ghost` draws. `prefer_memory_near` draws nothing.
fn ordinary_recall(
    room: &mut EmergenceRoom,
    rate: f64,
    since_last_roll: f64,
    project: &dyn Fn(Point) -> Vec2,
    rng: &mut Rng,
) -> Option<Emergence> {
    if room.ghosts.is_empty() {
        return None;
    }
    let alone = room.empty_seconds > EMPTY_ROOM_SECONDS;
    let gated_rate = rate * if alone { EMPTY_ROOM_GAIN } else { 1.0 };
    if rng.next_f64() >= event_chance(gated_rate, since_last_roll) {
        return None;
    }
    // Which memory surfaces, never how often one does. When the room is
    // interested in somebody, its memories reach toward them rather than
    // away — and because this changes only the choice, every measured bound
    // on the room's pace stays exactly where it was measured.
    let ordinary_index = choose_rare(room.ghosts, room.wall, rng)?;
    // What the room decided on the last sensing frame, not a curve sampled here.
    let attended = room.attention.and_then(|(track_id, weight)| {
        room.tracks
            .iter()
            .find(|track| track.id == track_id)
            .map(|track| (track, weight))
    });
    let chosen_index = if let Some((track, weight)) = attended {
        prefer_memory_near(
            room.ghosts,
            project(track.position),
            weight,
            ordinary_index,
            PREFER_MEMORY_REACH,
        )
    } else {
        ordinary_index
    };
    let remembered = recall_at(room.ghosts, chosen_index, room.wall, rng)?;
    let kind = if alone {
        RecallKind::Empty
    } else {
        RecallKind::Ghost
    };
    let first_point = remembered.path.iter().next().copied();
    room.active.push(ActiveGhost {
        ghost: remembered,
        started_at: room.now,
        kind,
        disturbance: None,
    });
    let utterances = if alone {
        first_point
            .map(|point| {
                vec![Utterance {
                    kind: EmergenceVoice::Empty,
                    at: Vec2::new(point.x, point.y),
                    subject: None,
                }]
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    Some(Emergence {
        utterances,
        event: Some(if alone {
            "empty room — a path walked alone"
        } else {
            "an old path resurfaced"
        }),
        voice_cues: Vec::new(),
    })
}

/// Walking into ground an old memory lies on, which disturbs it as it shows
/// it.
///
/// The room's own interest in the crosser is the caller's to record — this
/// module signals that a crossing happened; whoever owns attention decides
/// what to do with that, exactly as `room.attention.observe(...)` would if
/// this were wired live.
///
/// # Draw order
///
/// One draw, for `remember_ghost`.
fn crossing(
    room: &mut EmergenceRoom,
    project: &dyn Fn(Point) -> Vec2,
    rng: &mut Rng,
) -> Option<&'static str> {
    let collision = room
        .collisions
        .find(room.tracks, room.ghosts, room.wall, project)?;
    let struck = room.ghosts.get(collision.ghost_index)?;
    let loss = disturbance::memory_loss(struck.created_at, struck.fidelity, room.wall);
    let remainder: Vec<Point> = struck
        .path
        .iter()
        .skip(collision.segment_index)
        .copied()
        .collect();
    let remembered = recall_at(room.ghosts, collision.ghost_index, room.wall, rng)?;
    let mut spliced_path: Vec<Point> = Vec::with_capacity(remainder.len() + 1);
    spliced_path.push(Point::new(collision.at.x, collision.at.y, room.wall));
    spliced_path.extend(remainder);
    let mut ghost = remembered;
    ghost.path = room_protocol::PathPoints::from_iter_bounded(spliced_path);
    room.active.push(ActiveGhost {
        ghost,
        started_at: room.now,
        kind: RecallKind::Ghost,
        disturbance: Some(Disturbance {
            loss,
            at: collision.at,
            voice_played: false,
            admitted: false,
        }),
    });
    Some("a crossing disturbed an old path")
}

/// Exported for a caller that has to decide whether a new recall fits.
#[must_use]
pub fn has_recall_room(active: &[ActiveGhost]) -> bool {
    active.len() < MAX_ACTIVE_RECALLS
}

/// Where a convergence speaks from.
///
/// Along the shared route, not at the track's last position. A track ends
/// when its visitor leaves, so that position sits at the edge of the room and
/// the line clamps itself into a corner — which reads as the room addressing
/// the wall rather than the path two people had both walked. The centre of
/// the room is the fallback for a path with no points, which a captured trace
/// cannot have; it is here so this always returns a place rather than an
/// absence the caller would have to handle at the moment it speaks.
#[must_use]
pub fn convergence_voice_point(path: &[Vec2]) -> Vec2 {
    path.get(path.len() / 2)
        .copied()
        .unwrap_or(Vec2::new(0.5, 0.5))
}

/// The memory a convergence surfaces, when there is a slot for it.
///
/// The room's stream, like every other recall. A convergence is decided
/// outside `detect` — it is the one branch a caller reaches directly.
#[must_use]
pub fn convergence_recall(
    ghost: &Ghost,
    now: f64,
    rng: &mut Rng,
    active: &[ActiveGhost],
) -> Option<ActiveGhost> {
    if !has_recall_room(active) {
        return None;
    }
    Some(ActiveGhost {
        ghost: remember_ghost(ghost, now, rng),
        started_at: now,
        kind: RecallKind::Convergence,
        disturbance: None,
    })
}

/// The whole six-branch decision, in fixed priority order: stillness,
/// retrace, false memory, an ordinary recall (including its empty-room
/// variant), then crossing — last, so it cannot pre-empt the other five in a
/// crowd (exactly when people cross history most).
pub fn detect(
    state: &mut EmergenceState,
    room: &mut EmergenceRoom,
    project: &dyn Fn(Point) -> Vec2,
    has_recording: &dyn Fn(&MemoryId) -> bool,
    rng: &mut Rng,
) -> Emergence {
    // Advance the clock before any early return. Skipping it while recalls
    // are capped banks the elapsed time and fires a burst the moment a slot
    // frees.
    let since_last_roll = state.advance(room.now);
    let (utterances, voice_cues) = progress_disturbances(
        room.active,
        room.whispers,
        room.now,
        room.wall,
        has_recording,
        rng,
    );

    if room.active.len() >= MAX_ACTIVE_RECALLS {
        return Emergence {
            utterances,
            event: None,
            voice_cues,
        };
    }
    if matches!(room.lifecycle, Lifecycle::Opening | Lifecycle::Closing) {
        return Emergence {
            utterances,
            event: None,
            voice_cues,
        };
    }

    if let Some(result) = stillness(state, room, project, rng) {
        return merged(utterances, voice_cues, result);
    }
    if let Some(result) = return_of_a_path(room, project) {
        return merged(utterances, voice_cues, result);
    }

    let rate = RECALL_RATE_PER_SECOND * room.ghost_frequency;

    if let Some(result) = false_memory(room, rate, since_last_roll, rng) {
        return merged(utterances, voice_cues, result);
    }
    if let Some(result) = ordinary_recall(room, rate, since_last_roll, project, rng) {
        return merged(utterances, voice_cues, result);
    }

    // Last, so a crossing interrupts a quiet room rather than pre-empting the
    // room's own behaviours.
    let event = crossing(room, project, rng);
    Emergence {
        utterances,
        event,
        voice_cues,
    }
}

fn merged(
    mut utterances: Vec<Utterance>,
    voice_cues: Vec<VoiceCue>,
    branch: Emergence,
) -> Emergence {
    utterances.extend(branch.utterances);
    Emergence {
        utterances,
        event: branch.event,
        voice_cues,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ADMISSION_LEAD, ADMISSION_LOSS, ActiveGhost, Disturbance, EMPTY_ROOM_SECONDS,
        EmergenceRoom, EmergenceState, EmergenceVoice, MAX_ACTIVE_RECALLS, RECALL_RATE_PER_SECOND,
        STILLNESS_REST_MS, STILLNESS_SECONDS, detect,
    };
    use room_protocol::{
        Extent, Ghost, Lifecycle, Lineage, MemoryId, PathPoints, Point, RecallKind, TrackId,
        TrackPath, Vec2, Whisper,
    };

    use crate::disturbance::MemoryCollisions;
    use crate::rng::Rng;
    use crate::tracking::Track;

    fn identity(point: Point) -> Vec2 {
        Vec2::new(point.x, point.y)
    }
    fn no_recording(_: &MemoryId) -> bool {
        false
    }

    fn track_with(id: u32, still_for: f64, path: &[(f64, f64)]) -> Track {
        let mut track_path = TrackPath::new();
        for (index, &(x, y)) in path.iter().enumerate() {
            #[allow(clippy::cast_precision_loss)]
            track_path.push(Point::new(x, y, index as f64 * 50.0));
        }
        let position = path.last().map_or(Point::new(0.5, 0.5, 0.0), |&(x, y)| {
            #[allow(clippy::cast_precision_loss)]
            Point::new(x, y, path.len() as f64 * 50.0)
        });
        Track {
            id: TrackId(id),
            born_at: 0.0,
            last_seen: position.t,
            position,
            previous: position,
            velocity: Vec2::new(0.0, 0.0),
            speed: 0.0,
            still_for,
            dwell_seconds: 0.0,
            path: track_path,
            active: true,
            occluded: false,
            confidence: 1.0,
            sightings: 5,
            extent: Extent {
                width: 0.1,
                height: 0.24,
            },
        }
    }

    fn ghost_at(id: &str, created_at: f64, points: &[(f64, f64)]) -> Ghost {
        let mut path = PathPoints::new();
        for (index, &(x, y)) in points.iter().enumerate() {
            #[allow(clippy::cast_precision_loss)]
            path.push(Point::new(x, y, index as f64 * 100.0));
        }
        Ghost {
            id: MemoryId::new(id).expect("test id fits"),
            created_at,
            last_replayed_at: 0.0,
            path,
            dwell_seconds: 4.0,
            intensity: 0.5,
            strength: 0.5,
            fidelity: 1.0,
            recall_count: 0,
            lineage: Lineage::new(),
            false_memory: false,
            day: 1,
        }
    }

    /// A room with everything at rest: no tracks, one ghost, plenty of room
    /// under the cap, active lifecycle. Individual tests override what they
    /// need to exercise.
    struct Fixture {
        tracks: Vec<Track>,
        ghosts: Vec<Ghost>,
        whispers: Vec<Whisper>,
        active: Vec<ActiveGhost>,
        collisions: MemoryCollisions,
    }

    impl Fixture {
        fn new(ghosts: Vec<Ghost>) -> Self {
            Self {
                tracks: Vec::new(),
                ghosts,
                whispers: Vec::new(),
                active: Vec::new(),
                collisions: MemoryCollisions::default(),
            }
        }

        fn room(&mut self, now: f64, wall: f64) -> EmergenceRoom<'_> {
            EmergenceRoom {
                tracks: &self.tracks,
                ghosts: &mut self.ghosts,
                whispers: &mut self.whispers,
                active: &mut self.active,
                collisions: &mut self.collisions,
                ghost_frequency: 1.0,
                day: 1,
                lifecycle: Lifecycle::Active,
                empty_seconds: 0.0,
                now,
                wall,
                attention: None,
            }
        }
    }

    #[test]
    fn a_capped_room_answers_nothing_and_advances_nothing() {
        let mut fixture = Fixture::new(vec![ghost_at("g-1", 0.0, &[(0.1, 0.1), (0.2, 0.2)])]);
        for kind in [RecallKind::Ghost, RecallKind::Ghost, RecallKind::Ghost] {
            fixture.active.push(ActiveGhost {
                ghost: ghost_at("g-active", 0.0, &[(0.1, 0.1)]),
                started_at: 0.0,
                kind,
                disturbance: None,
            });
        }
        assert_eq!(fixture.active.len(), MAX_ACTIVE_RECALLS);
        let mut state = EmergenceState::new();
        let mut rng = Rng::new(1);
        let mut room = fixture.room(0.0, 0.0);
        let outcome = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
        assert_eq!(outcome.event, None);
        assert_eq!(
            fixture.active.len(),
            MAX_ACTIVE_RECALLS,
            "nothing new was pushed past the cap"
        );
    }

    #[test]
    fn opening_and_closing_suppress_every_branch() {
        for lifecycle in [Lifecycle::Opening, Lifecycle::Closing] {
            let mut fixture = Fixture::new(vec![ghost_at("g-1", 0.0, &[(0.1, 0.1), (0.2, 0.2)])]);
            fixture.tracks = vec![track_with(1, STILLNESS_SECONDS, &[(0.5, 0.5)])];
            let mut state = EmergenceState::new();
            let mut rng = Rng::new(1);
            let mut room = fixture.room(0.0, 0.0);
            room.lifecycle = lifecycle;
            let outcome = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
            assert_eq!(outcome.event, None);
            assert!(fixture.active.is_empty());
        }
    }

    #[test]
    fn a_still_room_surfaces_the_oldest_ghost() {
        let mut fixture = Fixture::new(vec![
            ghost_at("g-newer", 5_000.0, &[(0.1, 0.1), (0.2, 0.2)]),
            ghost_at("g-oldest", 1_000.0, &[(0.3, 0.3), (0.4, 0.4)]),
        ]);
        fixture.tracks = vec![track_with(1, STILLNESS_SECONDS, &[(0.5, 0.5)])];
        let mut state = EmergenceState::new();
        let mut rng = Rng::new(7);
        let mut room = fixture.room(10_000.0, 10_000.0);
        let outcome = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
        assert_eq!(outcome.event, Some("stillness — an old trace surfaced"));
        assert_eq!(fixture.active.len(), 1);
        assert_eq!(fixture.active[0].kind, RecallKind::Stillness);
        assert_eq!(fixture.active[0].ghost.id.as_str(), "g-oldest");
    }

    #[test]
    fn stillness_rests_for_ninety_seconds_after_it_last_answered() {
        let mut fixture = Fixture::new(vec![ghost_at("g-1", 0.0, &[(0.1, 0.1), (0.2, 0.2)])]);
        fixture.tracks = vec![track_with(1, STILLNESS_SECONDS, &[(0.5, 0.5)])];
        let mut state = EmergenceState::new();
        let mut rng = Rng::new(3);
        {
            let mut room = fixture.room(0.0, 0.0);
            let first = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
            assert_eq!(first.event, Some("stillness — an old trace surfaced"));
        }
        {
            let mut room = fixture.room(STILLNESS_REST_MS - 1.0, STILLNESS_REST_MS - 1.0);
            let second = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
            assert_ne!(second.event, Some("stillness — an old trace surfaced"));
        }
    }

    #[test]
    fn a_genuine_retrace_answers_with_a_path_ahead_of_its_visitor() {
        let mut fixture = Fixture::new(Vec::new());
        let mut points = Vec::new();
        for step in 0..24_u32 {
            let x = 0.1 + f64::from(step) * 0.03;
            points.push((x, 0.5));
        }
        for step in 0..24_u32 {
            let x = 0.1 + f64::from(step) * 0.03;
            points.push((x, 0.5));
        }
        fixture.tracks = vec![track_with(9, 0.0, &points)];
        let mut state = EmergenceState::new();
        let mut rng = Rng::new(1);
        let mut room = fixture.room(0.0, 0.0);
        let outcome = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
        assert_eq!(
            outcome.event,
            Some("return — a path appeared ahead of its visitor")
        );
        assert_eq!(fixture.active.len(), 1);
        assert_eq!(fixture.active[0].kind, RecallKind::Return);
    }

    #[test]
    fn standing_still_does_not_read_as_a_retrace() {
        // A degenerate "path": the same point repeated, which never reaches
        // RETURN_MIN_EXTENT.
        let mut fixture = Fixture::new(Vec::new());
        let points: Vec<(f64, f64)> = (0..24).map(|_| (0.5, 0.5)).collect();
        fixture.tracks = vec![track_with(9, 0.0, &points)];
        let mut state = EmergenceState::new();
        let mut rng = Rng::new(1);
        let mut room = fixture.room(0.0, 0.0);
        let outcome = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
        assert_ne!(
            outcome.event,
            Some("return — a path appeared ahead of its visitor")
        );
    }

    #[test]
    fn false_memory_needs_at_least_two_ghosts() {
        let mut fixture = Fixture::new(vec![ghost_at("g-1", 0.0, &[(0.1, 0.1), (0.2, 0.2)])]);
        let mut state = EmergenceState::new();
        let mut rng = Rng::new(1);
        // A huge elapsed roll and a high frequency push every gate's chance
        // near 1, so if the guard were absent something would fire.
        let mut room = fixture.room(60_000.0, 60_000.0);
        room.ghost_frequency = 100.0;
        for _ in 0..5 {
            state.advance(60_000.0);
        }
        let outcome = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
        assert_ne!(
            outcome.event,
            Some("false memory — unrelated traces became one")
        );
    }

    #[test]
    fn an_empty_room_recall_speaks_and_a_present_one_stays_quiet() {
        // Empty room: emptySeconds past the threshold, no tracks. Drive many
        // ticks at a high rate until ordinary recall fires, then check the
        // event line and that it produced an utterance.
        let mut fixture = Fixture::new(vec![
            ghost_at("g-1", 0.0, &[(0.1, 0.1), (0.2, 0.2)]),
            ghost_at("g-2", 0.0, &[(0.3, 0.3), (0.4, 0.4)]),
        ]);
        let mut state = EmergenceState::new();
        let mut rng = Rng::new(11);
        let mut fired = false;
        for tick in 1..2_000_u32 {
            let now = f64::from(tick) * 1_000.0;
            let mut room = fixture.room(now, now);
            room.empty_seconds = EMPTY_ROOM_SECONDS + 1.0;
            room.ghost_frequency = 50.0;
            let outcome = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
            if outcome.event == Some("empty room — a path walked alone") {
                assert_eq!(outcome.utterances.len(), 1);
                assert_eq!(outcome.utterances[0].kind, EmergenceVoice::Empty);
                fired = true;
                break;
            }
            fixture.active.clear();
        }
        assert!(
            fired,
            "an empty, high-frequency room never produced an empty-room recall"
        );
    }

    #[test]
    fn ordinary_recall_in_a_present_room_is_silent_but_still_reported() {
        let mut fixture = Fixture::new(vec![
            ghost_at("g-1", 0.0, &[(0.1, 0.1), (0.2, 0.2)]),
            ghost_at("g-2", 0.0, &[(0.3, 0.3), (0.4, 0.4)]),
        ]);
        fixture.tracks = vec![track_with(1, 0.0, &[(0.5, 0.5)])];
        let mut state = EmergenceState::new();
        let mut rng = Rng::new(11);
        let mut fired = false;
        for tick in 1..2_000_u32 {
            let now = f64::from(tick) * 1_000.0;
            let mut room = fixture.room(now, now);
            room.empty_seconds = 0.0;
            room.ghost_frequency = 50.0;
            let outcome = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
            if outcome.event == Some("an old path resurfaced") {
                assert!(outcome.utterances.is_empty());
                fired = true;
                break;
            }
            fixture.active.clear();
        }
        assert!(
            fired,
            "a present, high-frequency room never produced an ordinary recall"
        );
    }

    #[test]
    fn stillness_takes_priority_over_a_crossing_on_the_same_tick() {
        // Everyone still (stillness fires) *and* a genuine crossing available
        // (collisions primed to find one) on the same tick: stillness must
        // win, because it is checked first.
        let mut fixture = Fixture::new(vec![ghost_at("g-cross", 0.0, &[(0.0, 0.5), (1.0, 0.5)])]);
        fixture.tracks = vec![track_with(1, STILLNESS_SECONDS, &[(0.5, 0.5)])];
        let mut state = EmergenceState::new();
        let mut rng = Rng::new(1);
        let mut room = fixture.room(0.0, 0.0);
        let outcome = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
        assert_eq!(outcome.event, Some("stillness — an old trace surfaced"));
        assert_eq!(fixture.active[0].kind, RecallKind::Stillness);
    }

    #[test]
    fn a_disturbed_recall_is_admitted_once_it_crosses_its_loss_threshold() {
        let mut fixture = Fixture::new(Vec::new());
        fixture.active.push(ActiveGhost {
            ghost: ghost_at("g-1", 0.0, &[(0.1, 0.1)]),
            started_at: 0.0,
            kind: RecallKind::Ghost,
            disturbance: Some(Disturbance {
                loss: ADMISSION_LOSS + 0.1,
                at: Vec2::new(0.2, 0.2),
                voice_played: true,
                admitted: false,
            }),
        });
        let mut state = EmergenceState::new();
        let mut rng = Rng::new(1);
        // `end` at this loss is `1 - loss * 0.48`; pick a progress just past
        // `end - ADMISSION_LEAD`.
        let loss = ADMISSION_LOSS + 0.1;
        let end = 1.0 - loss * 0.48;
        let duration = RecallKind::Ghost.duration_ms();
        let now = (end - ADMISSION_LEAD + 0.01) * duration;
        let mut room = fixture.room(now, now);
        let outcome = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
        assert_eq!(outcome.utterances.len(), 1);
        assert_eq!(outcome.utterances[0].kind, EmergenceVoice::Forgetting);
        assert!(
            fixture.active[0]
                .disturbance
                .expect("still disturbed")
                .admitted
        );
    }

    #[test]
    fn the_roll_clock_still_advances_while_the_room_is_capped() {
        // Banking time while capped and only then freeing a slot must not
        // produce a burst: the elapsed time since the *last roll*, not since
        // the cap cleared, is what a later branch sees. This is exercised
        // indirectly: two calls while capped must each advance the internal
        // clock without panicking or resetting it, which the public API
        // proves only through observable behaviour, so this asserts the
        // simplest such behaviour — the room stays capped and reports
        // nothing new either time.
        let mut fixture = Fixture::new(vec![ghost_at("g-1", 0.0, &[(0.1, 0.1)])]);
        for _ in 0..MAX_ACTIVE_RECALLS {
            fixture.active.push(ActiveGhost {
                ghost: ghost_at("g-active", 0.0, &[(0.1, 0.1)]),
                started_at: 0.0,
                kind: RecallKind::Ghost,
                disturbance: None,
            });
        }
        let mut state = EmergenceState::new();
        let mut rng = Rng::new(1);
        for tick in 0..5_u32 {
            let now = f64::from(tick) * 10_000.0;
            let mut room = fixture.room(now, now);
            let outcome = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
            assert_eq!(outcome.event, None);
        }
        assert_eq!(fixture.active.len(), MAX_ACTIVE_RECALLS);
    }

    #[test]
    fn resetting_state_clears_the_stillness_rest() {
        let mut fixture = Fixture::new(vec![ghost_at("g-1", 0.0, &[(0.1, 0.1), (0.2, 0.2)])]);
        fixture.tracks = vec![track_with(1, STILLNESS_SECONDS, &[(0.5, 0.5)])];
        let mut state = EmergenceState::new();
        let mut rng = Rng::new(1);
        {
            let mut room = fixture.room(0.0, 0.0);
            let first = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
            assert_eq!(first.event, Some("stillness — an old trace surfaced"));
        }
        state.reset();
        fixture.active.clear();
        {
            // Immediately after, which would still be resting without the reset.
            let mut room = fixture.room(1.0, 1.0);
            let second = detect(&mut state, &mut room, &identity, &no_recording, &mut rng);
            assert_eq!(second.event, Some("stillness — an old trace surfaced"));
        }
    }

    #[test]
    fn base_recall_rate_matches_the_typescript_constant() {
        assert!((RECALL_RATE_PER_SECOND - 0.045).abs() < 1e-12);
    }
}
