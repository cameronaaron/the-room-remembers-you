//! Proof of forward progress, not proof of life.
//!
//! A browser that answers HTTP while showing a frozen frame is a failed
//! installation, and the most common one: the tab is alive, the event loop is
//! alive, and the artwork stopped twenty minutes ago. Everything in this
//! struct is a counter that only goes up when real work happened, so the
//! supervisor can tell the difference between
//!
//! * the process is alive — the OS says so;
//! * the page is alive — a heartbeat arrived at all;
//! * the JS event loop is alive — `at_ms` advanced;
//! * the engine is advancing — `engine_tick` advanced;
//! * the renderer is advancing — `render_frame` advanced;
//! * the sensor pipeline is advancing — `sensor_frame` advanced.
//!
//! Each of those fails independently and each has a different remedy, which is
//! why they are six numbers rather than one boolean.

use serde::{Deserialize, Serialize};

use crate::config::RendererBackend;

/// One beat, posted to `roomd` on the loopback interface.
///
/// Nothing here describes a person or a place. `people` is a count, which the
/// operator console already shows, and is the one field that says anything
/// about the room at all — it is here because "zero people for nine hours" and
/// "the camera died nine hours ago" look identical without it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    /// Wall-clock milliseconds when the beat was sent.
    pub timestamp: f64,
    /// Engine steps completed since the page loaded.
    pub engine_tick: u64,
    /// Frames presented since the page loaded.
    pub render_frame: u64,
    /// Sensing passes completed since the page loaded.
    pub sensor_frame: u64,
    /// Confirmed visitors right now.
    pub people: u32,
    pub renderer: RendererBackend,
    /// Bytes of WASM linear memory. Watched for a slow climb over a gallery week.
    pub wasm_memory_bytes: u64,
    /// Bytes of JS heap, where the browser reports it. 0 when it does not.
    pub js_heap_bytes: u64,
}

/// How often the page beats. The supervisor's timeouts are multiples of this.
pub const HEARTBEAT_INTERVAL_MS: u64 = 2_000;

/// What the supervisor concluded from the beats it has seen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Liveness {
    /// Everything is advancing.
    Healthy,
    /// Beats are arriving and the renderer has stopped. The most dangerous
    /// state, because from outside it looks fine.
    RenderStalled,
    /// Beats are arriving and the engine has stopped.
    EngineStalled,
    /// Beats are arriving and sensing has stopped. The room will keep drawing
    /// and will never see anyone again.
    SensorStalled,
    /// No beat within the timeout.
    Silent,
    /// Nothing has beaten yet. Distinct from `Silent`: a page that never
    /// started is a different fault from one that stopped.
    NeverStarted,
}

impl Liveness {
    /// Whether this state should be acted on rather than merely logged.
    #[must_use]
    pub const fn is_failure(self) -> bool {
        !matches!(self, Self::Healthy)
    }

    /// What an operator should be told, in one line.
    #[must_use]
    pub const fn describe(self) -> &'static str {
        match self {
            Self::Healthy => "the room is running",
            Self::RenderStalled => "the page is responding but the projection has frozen",
            Self::EngineStalled => "the projection is running but the room has stopped thinking",
            Self::SensorStalled => "the room is drawing but no longer sees anyone",
            Self::Silent => "the browser stopped answering",
            Self::NeverStarted => "the browser has not reported in yet",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Heartbeat, Liveness};
    use crate::config::RendererBackend;

    #[test]
    fn a_heartbeat_serialises_under_the_names_the_shell_posts() {
        let json = serde_json::to_string(&Heartbeat {
            timestamp: 123_456.0,
            engine_tick: 98_342,
            render_frame: 428_381,
            sensor_frame: 18_342,
            people: 3,
            renderer: RendererBackend::WebGpu,
            wasm_memory_bytes: 17_039_360,
            js_heap_bytes: 0,
        })
        .expect("serialises");
        assert!(json.contains("\"engineTick\":98342"), "{json}");
        assert!(json.contains("\"renderFrame\":428381"), "{json}");
        assert!(json.contains("\"renderer\":\"webgpu\""), "{json}");
    }

    /// Every failure state has to be sayable to a person who is not a
    /// programmer, because the person who reads it is a gallery invigilator.
    #[test]
    fn every_failure_state_says_what_is_broken() {
        for state in [
            Liveness::RenderStalled,
            Liveness::EngineStalled,
            Liveness::SensorStalled,
            Liveness::Silent,
            Liveness::NeverStarted,
        ] {
            assert!(state.is_failure());
            assert!(
                state.describe().len() > 20,
                "{state:?} needs a usable description"
            );
        }
        assert!(!Liveness::Healthy.is_failure());
    }
}
