//! Owned typed arrays, one batch in and one snapshot out. No shared-memory
//! views survive a call or WASM memory growth. No browser APIs in the core.
use room_engine::attention_engine::AttentionEngine;
use room_engine::behavior_engine::BehaviorEngine;
use room_engine::field_engine::FieldEngine;
use room_engine::track_engine::TrackEngine;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Debug, Default)]
pub struct WasmFieldEngine(FieldEngine);

#[wasm_bindgen]
impl WasmFieldEngine {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
    pub fn step(
        &mut self,
        deposits: &[f64],
        elapsed: f64,
        half_life: f64,
        empty: f64,
    ) -> Result<Vec<f32>, JsValue> {
        self.0
            .step(deposits, elapsed, half_life, empty)
            .map_err(JsValue::from_str)?;
        Ok(self.0.snapshot().to_vec())
    }
    pub fn restore(&mut self, field: &[f32]) -> Result<(), JsValue> {
        self.0.restore(field).map_err(JsValue::from_str)
    }
    pub fn reset(&mut self) {
        self.0.reset();
    }
    #[must_use]
    pub fn tick(&self) -> u64 {
        self.0.tick()
    }
}

/// Anonymous tracking, one sensing frame per call.
///
/// The layout of both arrays is documented on
/// [`room_engine::track_engine`], and `lib/track-bridge.ts` is the decoder
/// that reads it. Errors arrive as strings because that is what a JavaScript
/// `catch` can act on; the shell falls back to its TypeScript tracker rather
/// than failing the frame, so a refused frame must not throw a type the shell
/// cannot describe in a diagnostic.
#[wasm_bindgen]
#[derive(Debug, Default)]
pub struct WasmTrackEngine(TrackEngine);

#[wasm_bindgen]
impl WasmTrackEngine {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// `blobs` is five values per detected region; `now` is milliseconds on the
    /// shell's monotonic clock. The returned array is the caller's own copy and
    /// stays valid across later calls and across WASM memory growth.
    pub fn step(&mut self, blobs: &[f64], now: f64) -> Result<Vec<f64>, JsValue> {
        self.0
            .step(blobs, now)
            .map_err(|error| JsValue::from_str(error.message()))
    }

    /// Forget everyone. Used by the operator's reset and when sensing restarts.
    pub fn clear(&mut self) {
        self.0.clear();
    }

    /// Frames accepted. Forward progress, for the supervisor's heartbeat.
    #[must_use]
    pub fn frames(&self) -> u64 {
        self.0.frames()
    }

    /// Times fragment continuity held a splitting body together. A count only:
    /// the outline geometry is never exposed.
    #[must_use]
    pub fn fragment_recoveries(&self) -> u64 {
        self.0.manager().fragment_recoveries()
    }
}

/// The room's interest, one sensing frame per call.
///
/// The layout of both arrays is documented on
/// [`room_engine::attention_engine`], and `lib/attention-bridge.ts` is the
/// encoder and decoder that reads it. Errors arrive as strings for the same
/// reason the tracker's do: the shell falls back to its TypeScript attention
/// rather than failing the frame, so a refused frame must not throw a type the
/// shell cannot describe in a diagnostic.
#[wasm_bindgen]
#[derive(Debug, Default)]
pub struct WasmAttentionEngine(AttentionEngine);

#[wasm_bindgen]
impl WasmAttentionEngine {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// `frame` is the packed observation frame; the returned array is the
    /// caller's own copy and stays valid across later calls and across WASM
    /// memory growth.
    pub fn step(&mut self, frame: &[f64]) -> Result<Vec<f64>, JsValue> {
        self.0
            .step(frame)
            .map_err(|error| JsValue::from_str(error.message()))
    }

    /// Forget everyone and stop resting. Used by the operator's reset.
    pub fn clear(&mut self) {
        self.0.clear();
    }

    /// Frames accepted. Forward progress, for the supervisor's heartbeat.
    #[must_use]
    pub fn frames(&self) -> u64 {
        self.0.frames()
    }
}

/// What the room noticed people doing, one sensing frame per call.
///
/// The layout of both arrays is documented on
/// [`room_engine::behavior_engine`], and `lib/behavior-bridge.ts` is the
/// encoder and decoder that reads it. Errors arrive as strings for the same
/// reason the tracker's and the interest engine's do: the shell falls back to
/// its TypeScript watcher rather than failing the frame, so a refused frame
/// must not throw a type the shell cannot describe in a diagnostic.
#[wasm_bindgen]
#[derive(Debug, Default)]
pub struct WasmBehaviorEngine(BehaviorEngine);

#[wasm_bindgen]
impl WasmBehaviorEngine {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// `frame` is the packed observation frame; the returned array is the
    /// caller's own copy and stays valid across later calls and across WASM
    /// memory growth.
    pub fn step(&mut self, frame: &[f64]) -> Result<Vec<f64>, JsValue> {
        self.0
            .step(frame)
            .map_err(|error| JsValue::from_str(error.message()))
    }

    /// Forget everyone, and every cooldown. Used by the operator's reset.
    pub fn clear(&mut self) {
        self.0.clear();
    }

    /// Frames accepted. Forward progress, for the supervisor's heartbeat.
    #[must_use]
    pub fn frames(&self) -> u64 {
        self.0.frames()
    }
}
