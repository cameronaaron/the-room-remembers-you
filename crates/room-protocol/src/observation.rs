//! What the engine is allowed to be told.
//!
//! This is the narrowest point in the whole system, and it is narrow on
//! purpose. The browser sees a camera; the engine sees a handful of rectangles
//! with an energy each. Everything between those two — the luminance
//! difference, the background model, the occupancy grid, the connected
//! components — happens on the sensing side and is discarded within the frame
//! that produced it.
//!
//! An [`ObservationFrame`] is what a gallery session's anonymous recording
//! consists of, and it is safe to write to disk precisely because this type is
//! all there is. There is no variant of it that carries pixels.

use serde::{Deserialize, Serialize};

use crate::bounded::{Bounded, TRACKS_MAX};
use crate::privacy::impl_persistable;

/// One detected region of motion, in room coordinates.
///
/// Already mapped through the calibration homography: the engine never works
/// in camera space, so a recording made on one installation replays sensibly
/// on another.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Observation {
    /// Centroid x, 0..1 across the room.
    pub x: f64,
    /// Centroid y, 0..1 down the room.
    pub y: f64,
    /// Region width in room units.
    pub width: f64,
    /// Region height in room units.
    pub height: f64,
    /// How much of the region actually changed. 0..1.
    pub energy: f64,
}

/// Where a frame of observations came from.
///
/// Diagnostics need this — a room that looks busy because a simulation is
/// running is a different problem from a room that looks busy because a
/// projector is shining into its own camera — and replay needs it to refuse to
/// overwrite live sensing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObservationSource {
    /// A real camera.
    #[default]
    Camera,
    /// The operator's pointer, in demo mode.
    Pointer,
    /// The synthetic gallery, for burn-in and for development without a room.
    Simulation,
    /// An anonymous recording being replayed.
    Replay,
    /// Nothing is producing observations. Distinct from "an empty room".
    None,
}

/// A frame of observations, with the clock that produced it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationFrame {
    /// Milliseconds on the shell's monotonic clock.
    pub at_ms: f64,
    pub source: ObservationSource,
    pub observations: Bounded<Observation, TRACKS_MAX>,
    /// Whether the sensing pipeline considers its background model settled.
    ///
    /// Carried because a detection during warm-up is good enough to react to
    /// and not solid enough to make a claim about, and only the sensing side
    /// knows which it is.
    pub settled: bool,
}

/// Something the microphone heard, reduced to the parts the engine may know.
///
/// There is no audio here either. A whisper's PCM never leaves the browser's
/// session store; what crosses is that one happened, how long it was, how
/// bright, and its shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AudioEvent {
    /// A whisper was captured. The engine decides whether to keep it.
    Whispered {
        at_ms: f64,
        /// Seconds.
        duration: f64,
        /// Spectral centroid, 0..1.
        brightness: f64,
        envelope: crate::bounded::Envelope,
        position: crate::geometry::Vec2,
    },
    /// The microphone stopped working, or was shut down.
    ///
    /// The engine keeps running; a deaf room is a degraded room, not a broken
    /// one. Diagnostics need to be able to tell the two apart.
    MicrophoneLost { at_ms: f64 },
}

impl_persistable!(Observation);

#[cfg(test)]
mod tests {
    use super::{Observation, ObservationFrame, ObservationSource};
    use crate::bounded::{Bounded, TRACKS_MAX};

    #[test]
    fn a_frame_cannot_carry_more_bodies_than_the_room_will_believe_in() {
        let crowd = (0..64).map(|i| Observation {
            x: f64::from(i) / 64.0,
            y: 0.5,
            width: 0.05,
            height: 0.2,
            energy: 0.6,
        });
        let frame = ObservationFrame {
            at_ms: 1000.0,
            source: ObservationSource::Simulation,
            observations: Bounded::from_iter_bounded(crowd),
            settled: true,
        };
        assert_eq!(frame.observations.len(), TRACKS_MAX);
    }

    /// Replay files are JSON on disk. The names are part of that contract.
    #[test]
    fn a_frame_serialises_under_the_names_the_shell_writes() {
        let json = serde_json::to_string(&ObservationFrame {
            at_ms: 12.5,
            source: ObservationSource::Replay,
            observations: Bounded::new(),
            settled: false,
        })
        .expect("serialises");
        assert!(json.contains("\"atMs\":12.5"), "{json}");
        assert!(json.contains("\"source\":\"replay\""), "{json}");
    }
}
