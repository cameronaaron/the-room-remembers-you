//! Local supervision decisions. Sensors may fail without killing the artwork.
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Progress {
    pub entered: bool,
    pub engine_tick: u64,
    pub render_frame: u64,
    pub sensor_frame: u64,
}

#[derive(Clone, Debug)]
pub struct Watchdog {
    started: u64,
    received: Option<u64>,
    engine_at: u64,
    render_at: u64,
    sensor_at: u64,
    last: Option<Progress>,
}
impl Watchdog {
    #[must_use]
    pub const fn new(now: u64) -> Self {
        Self {
            started: now,
            received: None,
            engine_at: now,
            render_at: now,
            sensor_at: now,
            last: None,
        }
    }
    pub fn observe(&mut self, beat: Progress, now: u64) {
        // A page reload legitimately resets counters. Rebase once, not on
        // every unchanged heartbeat; receive time belongs to this process.
        if let Some(last) = self.last {
            let reload =
                beat.engine_tick < last.engine_tick || beat.render_frame < last.render_frame;
            if reload || !last.entered || beat.engine_tick > last.engine_tick {
                self.engine_at = now;
            }
            if reload || !last.entered || beat.render_frame > last.render_frame {
                self.render_at = now;
            }
            if reload || !last.entered || beat.sensor_frame > last.sensor_frame {
                self.sensor_at = now;
            }
        } else {
            self.engine_at = now;
            self.render_at = now;
            self.sensor_at = now;
        }
        self.received = Some(now);
        self.last = Some(beat);
    }
    #[must_use]
    pub fn failure(&self, now: u64) -> Option<&'static str> {
        let Some(received) = self.received else {
            return (now.saturating_sub(self.started) >= 90_000).then_some("page never started");
        };
        if now.saturating_sub(received) >= 20_000 {
            return Some("page heartbeat missing");
        }
        if self.last.is_some_and(|p| p.entered) {
            if now.saturating_sub(self.render_at) >= 20_000 {
                return Some("renderer stopped advancing");
            }
            if now.saturating_sub(self.engine_at) >= 20_000 {
                return Some("engine stopped advancing");
            }
        }
        None
    }
    #[must_use]
    pub fn sensor_stalled(&self, now: u64) -> bool {
        self.last.is_some_and(|p| p.entered) && now.saturating_sub(self.sensor_at) >= 20_000
    }
}

#[derive(Clone, Debug, Default)]
pub struct Recovery {
    failures: u32,
    retry_at: u64,
    healthy_since: Option<u64>,
}
impl Recovery {
    pub fn failed(&mut self, now: u64) {
        self.failures = self.failures.saturating_add(1);
        self.healthy_since = None;
        self.retry_at = now.saturating_add(
            (2_000_u64.saturating_mul(1_u64 << self.failures.saturating_sub(1).min(8)))
                .min(300_000),
        );
    }
    pub fn healthy(&mut self, now: u64) {
        let since = *self.healthy_since.get_or_insert(now);
        // One successful heartbeat must not reset a crash loop's budget.
        if now.saturating_sub(since) >= 300_000 {
            self.failures = 0;
        }
    }
    #[must_use]
    pub const fn faulted(&self) -> bool {
        self.failures >= 8
    }
    #[must_use]
    pub fn ready(&self, now: u64) -> bool {
        !self.faulted() && now >= self.retry_at
    }
}

pub mod http;

#[cfg(test)]
mod tests {
    use super::*;
    fn beat(n: u64) -> Progress {
        Progress {
            entered: true,
            engine_tick: n,
            render_frame: n,
            sensor_frame: n,
        }
    }
    /// The wire format, from the other side.
    ///
    /// `lib/supervisor-beat.test.ts` reads this struct and checks the browser
    /// builds exactly these fields; this checks that what the browser actually
    /// sends parses. Two halves of one boundary with no type system spanning
    /// it, and `deny_unknown_fields` means a field added on one side alone does
    /// not degrade the report — it stops the supervisor seeing the room.
    #[test]
    fn the_beat_the_browser_sends_is_the_beat_this_reads() {
        let sent = r#"{"entered":true,"engineTick":12,"renderFrame":340,"sensorFrame":56}"#;
        let beat: Progress = serde_json::from_str(sent).expect("the browser's beat must parse");
        assert!(beat.entered);
        assert_eq!(beat.engine_tick, 12);
        assert_eq!(beat.render_frame, 340);
        assert_eq!(beat.sensor_frame, 56);

        // A counter that arrived fractional, or a field nobody agreed on, is a
        // refusal rather than a plausible wrong number.
        for rejected in [
            r#"{"entered":true,"engineTick":1.5,"renderFrame":0,"sensorFrame":0}"#,
            r#"{"entered":true,"engineTick":-1,"renderFrame":0,"sensorFrame":0}"#,
            r#"{"entered":true,"engineTick":0,"renderFrame":0,"sensorFrame":0,"fps":60}"#,
            r#"{"entered":true,"engineTick":0,"renderFrame":0}"#,
        ] {
            assert!(
                serde_json::from_str::<Progress>(rejected).is_err(),
                "should have refused {rejected}"
            );
        }
    }

    #[test]
    fn responsive_page_cannot_hide_a_frozen_renderer_or_engine() {
        for render in [false, true] {
            let mut watch = Watchdog::new(0);
            watch.observe(beat(1), 0);
            for n in 1..=4 {
                let mut p = beat(n + 1);
                if render {
                    p.render_frame = 1;
                } else {
                    p.engine_tick = 1;
                }
                watch.observe(p, n * 5000);
            }
            assert_eq!(
                watch.failure(20_000),
                Some(if render {
                    "renderer stopped advancing"
                } else {
                    "engine stopped advancing"
                })
            );
        }
    }
    #[test]
    fn sensor_loss_is_visible_but_does_not_restart_the_room() {
        let mut watch = Watchdog::new(0);
        watch.observe(beat(1), 0);
        let mut p = beat(100);
        p.sensor_frame = 1;
        watch.observe(p, 20_000);
        assert!(watch.sensor_stalled(20_000));
        assert_eq!(watch.failure(20_000), None);
    }
    #[test]
    fn launch_threshold_reload_and_silence_have_separate_grace() {
        let mut watch = Watchdog::new(0);
        assert_eq!(watch.failure(89_999), None);
        assert!(watch.failure(90_000).is_some());
        let mut p = beat(0);
        p.entered = false;
        watch.observe(p, 90_000);
        watch.observe(p, 110_000);
        assert_eq!(watch.failure(110_000), None);
        watch.observe(beat(100), 115_000);
        watch.observe(beat(0), 130_000);
        assert_eq!(watch.failure(130_000), None);
        assert_eq!(watch.failure(150_000), Some("page heartbeat missing"));
    }
    #[test]
    fn repeated_failures_back_off_and_reach_a_terminal_fault() {
        let mut recovery = Recovery::default();
        recovery.failed(0);
        assert!(!recovery.ready(1999));
        assert!(recovery.ready(2000));
        recovery.healthy(2000);
        recovery.healthy(3000);
        recovery.failed(3000);
        assert!(!recovery.ready(6999));
        assert!(recovery.ready(7000));
        for _ in 0..6 {
            recovery.failed(10_000);
        }
        assert!(recovery.faulted());
        assert!(!recovery.ready(u64::MAX));
    }
}
