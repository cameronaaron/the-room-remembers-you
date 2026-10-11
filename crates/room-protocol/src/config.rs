//! Configuration, split by who owns it, and validated before anything runs.
//!
//! The existing `RoomConfig` is one flat object holding the camera's rotation,
//! the projector's keystone, the microphone's threshold, the recall rate and
//! the hardware profile together. That is convenient for a settings panel and
//! wrong everywhere else: it means the engine's determinism depends on a struct
//! that also changes when an operator nudges a slider that only the renderer
//! reads.
//!
//! These are the same settings, grouped by the subsystem that actually reads
//! them. The shell still presents one panel; underneath, a renderer change
//! cannot perturb the engine, and a replay can pin [`EngineConfig`] while the
//! operator keeps adjusting the projection.
//!
//! Every config validates. A gallery machine that starts with a nonsense
//! setting should say so at startup, in the operator console, rather than
//! behave strangely for an evening.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Bumped when a setting changes *meaning* rather than value.
///
/// A stored config from an older schema is discarded rather than reinterpreted.
/// This is not caution for its own sake: the installation has already lost an
/// evening to a `sceneChangeLimit` of 0.32 that was a perfectly reasonable
/// pixel fraction under the old meaning and a frame-rejecting coverage
/// threshold under the new one. No amount of validating the number could have
/// caught it.
pub const CONFIG_SCHEMA: u32 = 3;

/// What went wrong with a setting, in terms an operator can act on.
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigError {
    /// Dotted path, e.g. `engine.memoryMinutes`.
    pub field: &'static str,
    /// What was expected, phrased for a person.
    pub expected: &'static str,
    /// What was found.
    pub found: String,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}: expected {}, found {}",
            self.field, self.expected, self.found
        )
    }
}

impl std::error::Error for ConfigError {}

/// Collects failures rather than stopping at the first, so an operator fixes
/// everything in one pass instead of discovering the next problem on restart.
#[derive(Debug, Default)]
pub struct Validation(Vec<ConfigError>);

impl Validation {
    fn range(
        &mut self,
        field: &'static str,
        value: f64,
        low: f64,
        high: f64,
        expected: &'static str,
    ) {
        if !value.is_finite() || value < low || value > high {
            self.0.push(ConfigError {
                field,
                expected,
                found: format!("{value}"),
            });
        }
    }

    /// The same, for durations, compared as integers.
    ///
    /// Routing milliseconds through `f64` to reuse [`Self::range`] would be a
    /// lossy cast for the sake of one fewer function, and a supervisor timeout
    /// is exactly the kind of number that should not be approximated.
    fn ms_range(
        &mut self,
        field: &'static str,
        value: u64,
        low: u64,
        high: u64,
        expected: &'static str,
    ) {
        if value < low || value > high {
            self.0.push(ConfigError {
                field,
                expected,
                found: value.to_string(),
            });
        }
    }

    fn finish(self) -> Result<(), Vec<ConfigError>> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(self.0)
        }
    }
}

/// How big a machine this is, probed rather than guessed.
///
/// Names are a tier, not a device. `ULTRA` exists for the WebGPU backend,
/// which can carry particle counts the WebGL renderer never could; a machine
/// only reaches it by actually reporting the limits, never by matching a
/// string in its GPU description.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum HardwareProfile {
    #[default]
    Cheap,
    Standard,
    Full,
    Ultra,
}

/// Which backend is drawing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum RendererBackend {
    /// GPU particle field on WebGPU compute.
    #[serde(rename = "webgpu")]
    WebGpu,
    /// GPU particle field on WebGL2 float render targets. The current default.
    #[default]
    #[serde(rename = "webgl")]
    WebGl,
    /// Line traces on a 2D canvas. The last renderer that still works when
    /// there is no usable GPU at all. Both GPU backends also support paper.
    #[serde(rename = "traces")]
    Traces,
}

impl RendererBackend {
    /// Reported in heartbeats and diagnostics.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WebGpu => "webgpu",
            Self::WebGl => "webgl",
            Self::Traces => "traces",
        }
    }
}

/// Everything the deterministic engine reads.
///
/// Nothing here describes a device or a surface. If a setting can be changed
/// without changing what the room *thinks*, it does not belong in this struct.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineConfig {
    /// Half-life of the memory field, in minutes.
    pub memory_minutes: f64,
    /// Half-life applied to an empty room, in minutes. Shorter: a room with
    /// nobody in it forgets faster, which is what makes returning feel like
    /// returning.
    pub forgetting_minutes: f64,
    /// 0 turns organic recall off entirely; 1 is the tuned rate.
    pub ghost_frequency: f64,
    /// The same, for whispers.
    pub whisper_frequency: f64,
    /// Days a memory survives before expiry.
    pub persistence_days: f64,
    /// How many bodies the room will believe in at once.
    pub max_bodies: u32,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            memory_minutes: 120.0,
            forgetting_minutes: 40.0,
            ghost_frequency: 0.55,
            whisper_frequency: 0.4,
            persistence_days: 7.0,
            max_bodies: crate::bounded::TRACKS_MAX_COUNT,
        }
    }
}

impl EngineConfig {
    pub fn validate(&self) -> Result<(), Vec<ConfigError>> {
        let mut v = Validation::default();
        v.range(
            "engine.memoryMinutes",
            self.memory_minutes,
            1.0,
            1440.0,
            "1..1440 minutes",
        );
        v.range(
            "engine.forgettingMinutes",
            self.forgetting_minutes,
            1.0,
            1440.0,
            "1..1440 minutes",
        );
        v.range(
            "engine.ghostFrequency",
            self.ghost_frequency,
            0.0,
            1.0,
            "0..1",
        );
        v.range(
            "engine.whisperFrequency",
            self.whisper_frequency,
            0.0,
            1.0,
            "0..1",
        );
        v.range(
            "engine.persistenceDays",
            self.persistence_days,
            1.0,
            365.0,
            "1..365 days",
        );
        v.range(
            "engine.maxBodies",
            f64::from(self.max_bodies),
            1.0,
            f64::from(crate::bounded::TRACKS_MAX_COUNT),
            "1..12 bodies",
        );
        v.finish()
    }
}

/// What the renderer reads. None of it reaches the engine.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererConfig {
    pub backend: RendererBackend,
    pub profile: HardwareProfile,
    /// Overall brightness of the field, 0..1.
    pub visual_intensity: f64,
    /// Projector geometry.
    pub keystone_x: f64,
    pub keystone_y: f64,
    pub rotation: f64,
    pub crop: f64,
    /// Black the projector without stopping the room thinking.
    pub blackout: bool,
}

impl Default for RendererConfig {
    fn default() -> Self {
        Self {
            backend: RendererBackend::WebGl,
            profile: HardwareProfile::Cheap,
            visual_intensity: 0.85,
            keystone_x: 0.0,
            keystone_y: 0.0,
            rotation: 0.0,
            crop: 0.0,
            blackout: false,
        }
    }
}

impl RendererConfig {
    pub fn validate(&self) -> Result<(), Vec<ConfigError>> {
        let mut v = Validation::default();
        v.range(
            "renderer.visualIntensity",
            self.visual_intensity,
            0.0,
            1.0,
            "0..1",
        );
        v.range("renderer.keystoneX", self.keystone_x, -1.0, 1.0, "-1..1");
        v.range("renderer.keystoneY", self.keystone_y, -1.0, 1.0, "-1..1");
        v.range(
            "renderer.rotation",
            self.rotation,
            -180.0,
            180.0,
            "-180..180 degrees",
        );
        v.range("renderer.crop", self.crop, 0.0, 0.45, "0..0.45");
        v.finish()
    }
}

/// What the sensing pipeline reads.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorConfig {
    /// Luminance difference, 0..255, that counts as motion.
    pub motion_sensitivity: f64,
    /// Share of the grid that may light up before a frame is discarded as a
    /// scene change. Coverage, not pixels — see [`CONFIG_SCHEMA`].
    pub scene_change_coverage: f64,
    pub mirror_camera: bool,
    pub camera_rotation: u16,
}

impl Default for SensorConfig {
    fn default() -> Self {
        Self {
            motion_sensitivity: 24.0,
            scene_change_coverage: 0.85,
            mirror_camera: true,
            camera_rotation: 0,
        }
    }
}

impl SensorConfig {
    pub fn validate(&self) -> Result<(), Vec<ConfigError>> {
        let mut v = Validation::default();
        v.range(
            "sensor.motionSensitivity",
            self.motion_sensitivity,
            1.0,
            255.0,
            "1..255",
        );
        v.range(
            "sensor.sceneChangeCoverage",
            self.scene_change_coverage,
            0.05,
            1.0,
            "0.05..1",
        );
        if !matches!(self.camera_rotation, 0 | 90 | 180 | 270) {
            v.0.push(ConfigError {
                field: "sensor.cameraRotation",
                expected: "0, 90, 180 or 270",
                found: self.camera_rotation.to_string(),
            });
        }
        v.finish()
    }
}

/// What the audio side reads.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioConfig {
    pub master_volume: f64,
    pub microphone_threshold: f64,
    /// When set, a captured whisper is reduced to a loudness envelope that
    /// lives only for the session and is dropped before the room is written
    /// to disk. Off by default: the envelope (never the raw audio, which is
    /// not `Persistable` regardless of this flag) is kept in persisted state
    /// so a voice can be part of the room's memory across visits.
    pub privacy_mode: bool,
    /// Whether the room says its lines aloud as well as showing them.
    pub speech: bool,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            master_volume: 0.32,
            microphone_threshold: 0.004,
            privacy_mode: false,
            speech: true,
        }
    }
}

impl AudioConfig {
    pub fn validate(&self) -> Result<(), Vec<ConfigError>> {
        let mut v = Validation::default();
        v.range("audio.masterVolume", self.master_volume, 0.0, 1.0, "0..1");
        v.range(
            "audio.microphoneThreshold",
            self.microphone_threshold,
            0.0,
            0.2,
            "0..0.2",
        );
        v.finish()
    }
}

/// Privacy settings, kept separate so that changing one is a visible act.
///
/// Every field here is still bounded by [`crate::privacy::Persistable`]: none
/// of them can be turned into a switch for pixels, PCM, or identity, because
/// the types that would hold those do not implement it. What *can* move is
/// how much of the anonymous, already-bounded data each field governs gets
/// kept — and defaults below favor the room's memory over a clean slate,
/// on the premise that more of what the type system already allows makes a
/// more interesting artwork. A change here still wants a reviewer and a
/// regression test proving what it changes.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyConfig {
    /// Anonymous observation recording, for reproducing a gallery failure and
    /// for replay-driven behavior. On by default, per session; never survives
    /// a reload regardless of this flag — turning it off trades that away for
    /// a session that leaves nothing to replay.
    pub record_observations: bool,
    /// Aggregate sensing telemetry: rates and counts, no coordinates.
    pub record_sensing_samples: bool,
}

impl Default for PrivacyConfig {
    fn default() -> Self {
        Self {
            record_observations: true,
            record_sensing_samples: true,
        }
    }
}

/// What `roomd` reads. Nothing here is artistic.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorConfig {
    /// Loopback port for the static server and the heartbeat endpoint.
    pub port: u16,
    /// Milliseconds without a heartbeat before the browser is considered hung.
    pub heartbeat_timeout_ms: u64,
    /// Milliseconds without the render frame counter advancing before the page
    /// is considered frozen, even if heartbeats keep arriving. A responsive
    /// browser showing a still image is still a failed installation.
    pub render_stall_ms: u64,
    /// First restart delay. Doubles on each consecutive failure, capped by
    /// [`Self::max_backoff_ms`], so a machine that cannot start does not spend
    /// the night relaunching a browser.
    pub base_backoff_ms: u64,
    pub max_backoff_ms: u64,
    /// Consecutive failures before the supervisor stops trying and shows a
    /// fault page instead.
    pub crash_loop_limit: u32,
    /// Health log entries retained. Bounded like everything else.
    pub log_entries: usize,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            port: 7341,
            heartbeat_timeout_ms: 15_000,
            render_stall_ms: 20_000,
            base_backoff_ms: 2_000,
            max_backoff_ms: 300_000,
            crash_loop_limit: 8,
            log_entries: 2_000,
        }
    }
}

impl SupervisorConfig {
    pub fn validate(&self) -> Result<(), Vec<ConfigError>> {
        let mut v = Validation::default();
        if self.port < 1024 {
            v.0.push(ConfigError {
                field: "supervisor.port",
                expected: "an unprivileged port, 1024..65535",
                found: self.port.to_string(),
            });
        }
        v.ms_range(
            "supervisor.heartbeatTimeoutMs",
            self.heartbeat_timeout_ms,
            2_000,
            600_000,
            "2s..10min",
        );
        v.ms_range(
            "supervisor.renderStallMs",
            self.render_stall_ms,
            2_000,
            600_000,
            "2s..10min",
        );
        if self.max_backoff_ms < self.base_backoff_ms {
            v.0.push(ConfigError {
                field: "supervisor.maxBackoffMs",
                expected: "at least baseBackoffMs",
                found: self.max_backoff_ms.to_string(),
            });
        }
        v.range(
            "supervisor.crashLoopLimit",
            f64::from(self.crash_loop_limit),
            1.0,
            1000.0,
            "1..1000",
        );
        v.finish()
    }
}

/// Every config together, as the shell persists it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationConfig {
    pub engine: EngineConfig,
    pub renderer: RendererConfig,
    pub sensor: SensorConfig,
    pub audio: AudioConfig,
    pub privacy: PrivacyConfig,
}

impl InstallationConfig {
    /// Validate everything, reporting all failures at once.
    pub fn validate(&self) -> Result<(), Vec<ConfigError>> {
        let mut errors = Vec::new();
        for result in [
            self.engine.validate(),
            self.renderer.validate(),
            self.sensor.validate(),
            self.audio.validate(),
        ] {
            if let Err(mut found) = result {
                errors.append(&mut found);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AudioConfig, EngineConfig, InstallationConfig, RendererBackend, SensorConfig,
        SupervisorConfig,
    };

    /// Diagnostics print `as_str`; heartbeats serialise. An operator reading
    /// "webgl" in the console and "web-gl" in a log is reading two names for
    /// one thing, and will eventually conclude they are two things.
    #[test]
    fn the_name_a_backend_prints_is_the_name_it_serialises_under() {
        for backend in [
            RendererBackend::WebGpu,
            RendererBackend::WebGl,
            RendererBackend::Traces,
        ] {
            let json = serde_json::to_string(&backend).expect("serialises");
            assert_eq!(json.trim_matches('"'), backend.as_str());
        }
    }

    #[test]
    fn the_defaults_are_valid() {
        assert_eq!(InstallationConfig::default().validate(), Ok(()));
        assert_eq!(SupervisorConfig::default().validate(), Ok(()));
    }

    /// An operator fixes everything in one pass, not one restart per mistake.
    #[test]
    fn validation_reports_every_failure_at_once() {
        let config = InstallationConfig {
            engine: EngineConfig {
                ghost_frequency: 4.0,
                memory_minutes: 0.0,
                ..Default::default()
            },
            sensor: SensorConfig {
                camera_rotation: 45,
                ..Default::default()
            },
            audio: AudioConfig {
                master_volume: -1.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let errors = config.validate().expect_err("four settings are wrong");
        let fields: Vec<_> = errors.iter().map(|e| e.field).collect();
        assert_eq!(
            fields,
            vec![
                "engine.memoryMinutes",
                "engine.ghostFrequency",
                "sensor.cameraRotation",
                "audio.masterVolume",
            ]
        );
    }

    /// NaN passes every naive `<=` comparison written the obvious way.
    #[test]
    fn a_setting_that_is_not_a_number_is_rejected() {
        let config = EngineConfig {
            ghost_frequency: f64::NAN,
            ..Default::default()
        };
        let errors = config.validate().expect_err("NaN is not in 0..1");
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].field, "engine.ghostFrequency");
    }

    /// A backoff ceiling below its floor would make the supervisor restart as
    /// fast as it can, which is the failure the backoff exists to prevent.
    #[test]
    fn a_backoff_ceiling_below_its_floor_is_rejected() {
        let config = SupervisorConfig {
            base_backoff_ms: 10_000,
            max_backoff_ms: 500,
            ..Default::default()
        };
        let errors = config
            .validate()
            .expect_err("the ceiling is below the floor");
        assert!(errors.iter().any(|e| e.field == "supervisor.maxBackoffMs"));
    }
}
