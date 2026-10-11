//! What the engine hands the renderer.
//!
//! The division of labour this type exists to hold:
//!
//! > The engine says *this memory exists here, with this intensity*.
//! > The renderer says *this is how that looks*.
//!
//! So there is nothing in here about particles, bind groups, blend modes or
//! canvases, and nothing in the renderer decides who the room is interested in
//! or whether a memory is false. A snapshot is a description of the room's
//! state; two different backends drawing the same snapshot should produce the
//! same artwork at different fidelity, not different artworks.
//!
//! A snapshot is produced once per engine step and read once per rendered
//! frame. Those rates differ — sensing runs at 10-24 Hz, the display at 60 —
//! so the renderer interpolates between snapshots rather than the engine being
//! driven by the display. See `docs/ARCHITECTURE.md`.

use serde::{Deserialize, Serialize};

use crate::bounded::{ACTIVE_RECALLS_MAX, Bounded, TRACKS_MAX};
use crate::field::MemoryField;
use crate::geometry::Vec2;

/// Bodies the field can respond to at once.
///
/// Living visitors and recalls share this budget, and the renderer cannot tell
/// them apart without looking at [`PresenceKind`] — which is the point of the
/// piece. Alone in the room, neither can a visitor.
pub const MAX_PRESENCES: usize = TRACKS_MAX;

/// The six ways the room can bring something back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecallKind {
    /// An ordinary remembered walk.
    Ghost,
    /// Surfaced because the room is being stood still in.
    Stillness,
    /// Surfaced because the room is empty.
    Empty,
    /// Someone came back to where they had been.
    Return,
    /// Two walks turned out to be the same walk.
    Convergence,
    /// A composite of two memories. A route nobody walked.
    False,
}

impl RecallKind {
    /// How long the crossing takes, and how warm it runs.
    ///
    /// `False` is the exception that carries the whole idea: it moves like a
    /// person and never warms. Nothing labels it; a visitor is simply left
    /// with the sense that something over there is not alive.
    #[must_use]
    pub const fn presentation(self) -> (f64, f64) {
        match self {
            Self::Ghost => (11_000.0, 0.85),
            Self::Stillness => (16_000.0, 0.72),
            Self::Empty => (15_000.0, 0.66),
            Self::Return => (9_000.0, 0.95),
            Self::Convergence => (18_000.0, 1.0),
            Self::False => (13_000.0, 0.34),
        }
    }

    #[must_use]
    pub const fn duration_ms(self) -> f64 {
        self.presentation().0
    }

    #[must_use]
    pub const fn heat(self) -> f64 {
        self.presentation().1
    }
}

/// Whether a presence is alive. Advisory: the renderer is not required to draw
/// them differently, and by default it does not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "recall")]
pub enum PresenceKind {
    Visitor,
    Recall(RecallKind),
}

/// Anything the field treats as a presence.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    /// 0 moving, 1 completely still. Still bodies gather rather than scatter.
    pub stillness: f64,
    /// 0..1 presence envelope. Living bodies are 1; a recall swells and subsides.
    pub strength: f64,
    /// Colour temperature, 1 being a living body.
    pub heat: f64,
    pub kind: PresenceKind,
}

/// A moment the room noticed, as something the field can be struck by.
///
/// The engine decides that a convergence happened; the renderer decides
/// whether that looks like a ripple, a brightening or nothing at all.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Impulse {
    pub at: Vec2,
    /// 0..1.
    pub strength: f64,
    pub kind: ImpulseKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImpulseKind {
    /// Two paths turned out to be the same path.
    Convergence,
    /// Someone returned to somewhere they had been.
    Revisit,
    /// The room filled past what it can hold.
    Crowd,
    /// A memory was disturbed while being shown, and lost part of itself.
    Forgetting,
    /// A whisper surfaced.
    Whisper,
}

/// Who the room is currently interested in, if anyone.
///
/// Rare and brief on purpose: for under a minute, a few times a day, one
/// visitor's trace lingers a little longer than anyone else's. Nothing in the
/// artwork says so.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interest {
    pub at: Vec2,
    /// 0..1, rising and falling rather than switching on.
    pub weight: f64,
}

/// The room's mood, as the renderer reads it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Personality {
    #[default]
    Dormant,
    Curious,
    Attentive,
    Crowded,
    Overwhelmed,
    Lonely,
    Remembering,
    Forgetting,
}

impl Personality {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Dormant => "dormant",
            Self::Curious => "curious",
            Self::Attentive => "attentive",
            Self::Crowded => "crowded",
            Self::Overwhelmed => "overwhelmed",
            Self::Lonely => "lonely",
            Self::Remembering => "remembering",
            Self::Forgetting => "forgetting",
        }
    }
}

/// Where the installation is in its day.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Lifecycle {
    #[default]
    Opening,
    Active,
    Closing,
    AfterHours,
}

/// Brightness and turbulence, derived from personality by the engine so that
/// two renderers cannot disagree about what "overwhelmed" looks like.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Visual {
    /// Overall brightness, 0..1.
    pub intensity: f64,
    /// Ambient motion.
    pub drift: f64,
    /// High-frequency turbulence.
    pub unrest: f64,
    /// Extra life given to living bodies.
    pub presence: f64,
}

impl Default for Visual {
    fn default() -> Self {
        Self {
            intensity: 0.85,
            drift: 1.0,
            unrest: 0.0,
            presence: 1.0,
        }
    }
}

/// Something to be placed in the room's speakers.
///
/// Position, not content: the shell owns the audio graph, and the clip it
/// plays lives only in its session store.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpatialSound {
    pub at: Vec2,
    /// 0..1.
    pub gain: f64,
    pub kind: SoundKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SoundKind {
    /// Replay a held whisper. The shell resolves which clip.
    Whisper,
    /// The room's own voice.
    Utterance,
}

/// One frame of the room's state, as the renderer needs it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSnapshot {
    /// Monotonically increasing engine step. The supervisor watches this to
    /// tell "the page is responsive" from "the room is still thinking".
    pub tick: u64,
    /// Milliseconds on the shell's clock at the end of this step.
    pub at_ms: f64,
    /// Living visitors and recalls, indistinguishable by design.
    pub presences: Bounded<Presence, MAX_PRESENCES>,
    /// Where the room has been lived in.
    pub field: MemoryField,
    /// Moments the room noticed during this step.
    pub impulses: Bounded<Impulse, ACTIVE_RECALLS_MAX>,
    pub interest: Option<Interest>,
    pub visual: Visual,
    pub sounds: Bounded<SpatialSound, ACTIVE_RECALLS_MAX>,
    pub personality: Personality,
    pub lifecycle: Lifecycle,
    /// Mean field density.
    pub density: f64,
    /// Confirmed, currently observed visitors.
    pub people: usize,
    /// Seconds since the room last had anyone in it.
    pub empty_seconds: f64,
    /// Which day of the installation's life this is.
    pub day: u32,
}

#[cfg(test)]
mod tests {
    use super::{
        Impulse, ImpulseKind, MAX_PRESENCES, Presence, PresenceKind, RecallKind, RenderSnapshot,
    };
    use crate::bounded::Bounded;
    use crate::geometry::Vec2;

    /// A composite memory moves like a person and never warms. This is the
    /// number that carries the idea, so it is pinned rather than left to a
    /// constant nobody reads.
    #[test]
    fn a_false_memory_runs_colder_than_anything_alive() {
        assert!(RecallKind::False.heat() < RecallKind::Ghost.heat());
        assert!(RecallKind::False.heat() < 0.5, "it must never read as warm");
        for kind in [
            RecallKind::Ghost,
            RecallKind::Stillness,
            RecallKind::Empty,
            RecallKind::Return,
            RecallKind::Convergence,
        ] {
            assert!(
                kind.heat() >= 0.6,
                "{kind:?} is a real memory and should read as one"
            );
        }
    }

    #[test]
    fn the_presence_budget_is_shared_and_bounded() {
        let mut presences: Bounded<Presence, MAX_PRESENCES> = Bounded::new();
        for i in 0..50 {
            presences.push(Presence {
                x: f64::from(i) / 50.0,
                y: 0.5,
                vx: 0.0,
                vy: 0.0,
                stillness: 0.0,
                strength: 1.0,
                heat: 1.0,
                kind: PresenceKind::Visitor,
            });
        }
        assert_eq!(presences.len(), MAX_PRESENCES);
    }

    #[test]
    fn a_snapshot_round_trips_as_json_for_replay_and_diagnostics() {
        let mut snapshot = RenderSnapshot {
            tick: 42,
            at_ms: 1234.5,
            ..Default::default()
        };
        snapshot.impulses.push(Impulse {
            at: Vec2::new(0.5, 0.5),
            strength: 0.8,
            kind: ImpulseKind::Convergence,
        });
        let json = serde_json::to_string(&snapshot).expect("serialises");
        let restored: RenderSnapshot = serde_json::from_str(&json).expect("round trips");
        assert_eq!(restored, snapshot);
    }
}
