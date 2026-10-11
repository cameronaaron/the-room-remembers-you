import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioMemoryEngine, ANALYSIS_BAND, TONE_BAND } from './audio-memory.ts';
import { stereoPanFor } from './spatial-audio.ts';
import type { WhisperMemory } from './room-types.ts';
import {
  type AudioContextDouble,
  type GainDouble,
  type PannerDouble,
  installAudioGlobals,
  spectrumAt,
  tone,
} from './test-doubles/web-audio.ts';

/**
 * The microphone side, wired up.
 *
 * `audio-memory.test.ts` covers the arithmetic — thresholds, envelopes, replay
 * gain. None of it covered the object that actually builds the audio graph, so
 * the room tone, the capture path, suppression, playback and teardown were
 * exercised only by standing in a gallery. Every fault here is silent from the
 * front of the room: a suspended context accepts every sound and plays none of
 * them, and a room that has stopped listening looks exactly like a quiet one.
 */

const STREAM = {} as MediaStream;

/** Run the engine's poll loop by hand, at a level, for a number of ticks. */
async function listen(
  context: AudioContextDouble,
  level: number,
  ticks: number,
  spectrum = spectrumAt(20),
) {
  const analyser = context.analyser!;
  analyser.samples = tone(level);
  analyser.spectrum = spectrum;
  for (let tick = 0; tick < ticks; tick += 1) {
    // The poll loop reschedules itself on a real timer; letting it run is what
    // exercises the whisper state machine rather than one isolated call.
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
}

/**
 * Let the room hear an empty gallery first.
 *
 * The threshold is adaptive: the room measures its own noise floor and lifts
 * the working threshold eight times above it. The very first block the engine
 * hears *becomes* that floor, so a test that opens with speech teaches the room
 * that speech is what silence sounds like — and then correctly hears nothing.
 * A real installation starts in a quiet room, and so must these.
 */
async function settle(context: AudioContextDouble) {
  await listen(context, 0.00002, 3);
}

void test('starting the engine builds a listening chain and a room tone', async () => {
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  try {
    const engine = new AudioMemoryEngine(() => {});
    await engine.start(STREAM, 0.03);
    const context = audio.context!;

    // The microphone is band-limited before it reaches the analyser: that is
    // what keeps the room's own drone out of the whisper detector, and HVAC
    // rumble and footfall out of the threshold.
    const source = context.nodesOfKind('mediaStreamSource')[0];
    assert.ok(source.reaches('analyser'), 'the microphone must reach the analyser');
    const filters = context.nodesOfKind('filter');
    const cutoffs = filters.map((filter) => (filter as unknown as { frequency: { value: number } }).frequency.value);
    assert.ok(cutoffs.includes(ANALYSIS_BAND.minHz), 'a high-pass at the bottom of the voice band');
    assert.ok(cutoffs.includes(ANALYSIS_BAND.maxHz), 'and a low-pass at the top');

    // The drone sits entirely below the band the analyser starts at, which is
    // why it needs no suppression window at all.
    assert.ok(context.oscillators.length >= 2, 'the room tone is more than one voice');
    for (const oscillator of context.oscillators) {
      assert.ok(oscillator.started, 'an oscillator that never starts is silence');
      assert.ok(
        oscillator.frequency.value <= TONE_BAND.maxHz,
        `the room tone reached ${oscillator.frequency.value} Hz, inside the analyser's band`,
      );
      assert.ok(oscillator.frequency.value < ANALYSIS_BAND.minHz);
    }

    assert.ok(context.modules.includes('/audio/capture-worklet.js'), 'capture needs its worklet');
    assert.equal(engine.getDiagnostics().running, true);
    assert.equal(engine.getDiagnostics().contextState, 'running');
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('the room tone follows the room without ever stepping', async () => {
  const audio = installAudioGlobals();
  try {
    const engine = new AudioMemoryEngine(() => {});
    await engine.start(STREAM, 0.03);
    const context = audio.context!;
    const toneGain = context.nodesOfKind('gain')[0] as GainDouble;

    engine.setRoomState('dormant', 0.001, 0.3);
    const quiet = toneGain.gain.value;
    engine.setRoomState('overwhelmed', 0.5, 0.3);
    const loud = toneGain.gain.value;
    assert.ok(loud > quiet, 'a full room is louder than an empty one');

    // Every scheduled gain change is ramped: a stepped one is audible as a
    // click in a quiet gallery.
    assert.ok(
      toneGain.gain.automation.every((entry) => !entry.startsWith('setValueAtTime')),
      `the tone stepped instead of ramping: ${toneGain.gain.automation.join(' ')}`,
    );
    assert.ok(toneGain.gain.automation.some((entry) => entry.startsWith('setTarget')));

    // And the master volume still governs it.
    engine.setRoomState('overwhelmed', 0.5, 0);
    assert.equal(toneGain.gain.value, 0, 'silence means silence');
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('a whisper is captured, and what is handed on carries no audio', async () => {
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  try {
    const captured: WhisperMemory[] = [];
    const engine = new AudioMemoryEngine((memory) => captured.push(memory));
    await engine.start(STREAM, 0.02);
    const context = audio.context!;

    await settle(context);
    // Speech in the band, then silence, which is what ends a whisper.
    await listen(context, 0.08, 6);
    await listen(context, 0.0001, 8);

    assert.equal(captured.length, 1, 'one whisper from one stretch of speech');
    const whisper = captured[0];
    assert.ok(whisper.envelope.length >= 3 && whisper.envelope.length <= 32);
    for (const value of whisper.envelope) assert.ok(value >= 0 && value <= 1);
    assert.ok(whisper.duration > 0 && whisper.duration <= 6.5);
    assert.equal(whisper.recallCount, 0);
    assert.equal(whisper.fidelity, 1);
    // The handed-on memory is a shape, never a recording. PCM stays in the
    // private session store; anything on this object may be persisted.
    assert.ok(!('pcm' in whisper), 'no audio may travel on a WhisperMemory');
    assert.ok(!('samples' in whisper));
    assert.equal(engine.getDiagnostics().captured, 1);
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('the room lifts its own threshold above whatever the gallery sounds like', async () => {
  // The configured value is a floor, not the answer. A gallery with air
  // handling and a crowd in it would otherwise report a whisper on every poll.
  const audio = installAudioGlobals();
  try {
    const engine = new AudioMemoryEngine(() => {});
    await engine.start(STREAM, 0.004);
    // The room is already noisy when the installation opens, which is the case
    // this behaviour exists for.
    await listen(audio.context!, 0.05, 2);
    const diagnostics = engine.getDiagnostics();
    assert.ok(diagnostics.noiseFloor > 0.01, `the room measured a floor of ${diagnostics.noiseFloor}`);
    assert.ok(
      diagnostics.threshold > 0.004,
      `the working threshold stayed at the configured ${diagnostics.threshold}`,
    );
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('somebody talking cannot drag the noise floor up behind them', async () => {
  // The tracker is deliberately asymmetric: it follows a quieter room quickly
  // and a louder one very slowly. Symmetric, a visitor speaking would lift the
  // threshold above their own voice and the room would stop hearing them
  // halfway through the sentence.
  const audio = installAudioGlobals();
  try {
    const captured: WhisperMemory[] = [];
    const engine = new AudioMemoryEngine((memory) => captured.push(memory));
    await engine.start(STREAM, 0.004);
    const context = audio.context!;
    await settle(context);

    const speech = 0.08;
    await listen(context, speech, 10);
    const floor = engine.getDiagnostics().noiseFloor;
    assert.ok(
      floor < speech * 0.05,
      `after ten polls of speech the floor was ${floor}, closing on the ${speech} that produced it`,
    );
    assert.ok(
      engine.getDiagnostics().threshold < speech,
      'the room must still be able to hear the voice that is speaking',
    );

    await listen(context, 0.0001, 6);
    assert.ok(captured.length >= 1, 'and the whisper was captured rather than lost');
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('sound too loud to be a whisper is rejected as loud, not as silence', async () => {
  const audio = installAudioGlobals();
  try {
    const captured: WhisperMemory[] = [];
    const engine = new AudioMemoryEngine((memory) => captured.push(memory));
    await engine.start(STREAM, 0.02);
    await settle(audio.context!);
    await listen(audio.context!, 0.9, 4);
    assert.equal(captured.length, 0);
    assert.equal(engine.getDiagnostics().tooLoud, true, 'the instrument must distinguish the two');
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('a suppressed microphone records nothing and says so', async () => {
  const audio = installAudioGlobals();
  try {
    const captured: WhisperMemory[] = [];
    const engine = new AudioMemoryEngine((memory) => captured.push(memory));
    await engine.start(STREAM, 0.02);
    // The room is speaking. Anything heard now is the room hearing itself, and
    // recording it would replay the room's own sentence later as a visitor who
    // was never there.
    await settle(audio.context!);
    engine.suppressFor(5_000);
    assert.equal(engine.getDiagnostics().suppressed, true);
    await listen(audio.context!, 0.08, 6);
    assert.equal(captured.length, 0, 'the room must not record itself');
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('a remembered voice is played back from where it was associated', async () => {
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  try {
    const captured: WhisperMemory[] = [];
    const engine = new AudioMemoryEngine((memory) => captured.push(memory));
    await engine.start(STREAM, 0.02);
    const context = audio.context!;

    await settle(context);
    // Give the session store a recording to hold.
    context.worklet!.emit(new Float32Array(4096).fill(0.05));
    await listen(context, 0.08, 5);
    await listen(context, 0.0001, 8);
    assert.equal(captured.length, 1);

    const memory = { ...captured[0], position: { x: 0.9, y: 0.5 } };
    assert.equal(engine.hasRecording(memory.id), true);
    engine.replay(memory, 0.4);

    const source = context.sources.at(-1)!;
    assert.ok(source.started, 'a replay that never starts is silence');
    assert.ok(source.reaches('panner'), 'a memory must be placed in the room');
    assert.ok(source.reaches('destination'), 'and must reach the speakers');
    const panner = context.nodesOfKind('panner').at(-1) as PannerDouble;
    assert.equal(panner.pan.value, stereoPanFor(0.9));
    assert.equal(engine.getDiagnostics().replayed, 1);

    // Playback closes the microphone, for the same reason speech does.
    assert.equal(engine.getDiagnostics().suppressed, true);
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('a memory with no recording behind it plays nothing at all', async () => {
  const audio = installAudioGlobals();
  try {
    const engine = new AudioMemoryEngine(() => {});
    await engine.start(STREAM, 0.02);
    const context = audio.context!;
    const empty: WhisperMemory = {
      id: 'never-recorded',
      createdAt: 0,
      lastReplayedAt: 0,
      duration: 1,
      envelope: [0.2, 0.6, 0.2],
      brightness: 0.4,
      position: { x: 0.5, y: 0.5 },
      strength: 0.4,
      fidelity: 1,
      recallCount: 0,
      lineage: [],
      day: 1,
    };
    engine.replay(empty, 0.4);
    assert.equal(context.sources.length, 0, 'silence, not a buffer of zeroes');
    assert.equal(engine.getDiagnostics().replayed, 0);
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('auditioning plays everything held, and nothing when nothing is held', async () => {
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  try {
    const captured: WhisperMemory[] = [];
    const engine = new AudioMemoryEngine((memory) => captured.push(memory));
    await engine.start(STREAM, 0.02);
    const context = audio.context!;

    assert.equal(engine.audition([], 0.4), 0, 'nothing held, nothing played');

    await settle(context);
    context.worklet!.emit(new Float32Array(4096).fill(0.05));
    await listen(context, 0.08, 5);
    await listen(context, 0.0001, 8);
    assert.equal(engine.audition(captured, 0.4), captured.length);
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('clearing recordings erases the audio and leaves the memories', async () => {
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  try {
    const captured: WhisperMemory[] = [];
    const engine = new AudioMemoryEngine((memory) => captured.push(memory));
    await engine.start(STREAM, 0.02);
    const context = audio.context!;
    await settle(context);
    context.worklet!.emit(new Float32Array(4096).fill(0.05));
    await listen(context, 0.08, 5);
    await listen(context, 0.0001, 8);
    assert.equal(engine.hasRecording(captured[0].id), true);

    engine.clearRecordings();
    assert.equal(engine.hasRecording(captured[0].id), false, 'reset must erase real voices');
    engine.replay(captured[0], 0.4);
    assert.equal(engine.getDiagnostics().replayed, 0);
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('stopping the engine silences the tone and closes the context', async () => {
  const audio = installAudioGlobals();
  try {
    const engine = new AudioMemoryEngine(() => {});
    await engine.start(STREAM, 0.02);
    const context = audio.context!;
    engine.stop();

    for (const oscillator of context.oscillators) {
      assert.ok(oscillator.stopped, 'a tone left running outlives the installation');
    }
    assert.equal(context.closed, true);
    assert.equal(engine.getDiagnostics().running, false);
    assert.equal(engine.getDiagnostics().contextState, 'none');
    // The microphone path is re-entered on every device retry, so a second stop
    // must be harmless rather than throwing into the retry.
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('the microphone is left unstarted rather than half-built when it fails', () => {
  const audio = installAudioGlobals();
  try {
    const engine = new AudioMemoryEngine(() => {});
    // Never started. Every accessor must still answer.
    const diagnostics = engine.getDiagnostics();
    assert.equal(diagnostics.running, false);
    assert.equal(diagnostics.contextState, 'none');
    assert.equal(engine.hasRecording('anything'), false);
    assert.equal(engine.audition([], 0.4), 0);
    engine.setRoomState('curious', 0.1, 0.4);
    engine.setThreshold(0.05);
    engine.clearRecordings();
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('audio arriving while the room is speaking is discarded, not buffered', async () => {
  // The capture ring is cleared rather than held while the room speaks. Holding
  // it would splice the room's own sentence onto the front of the next
  // visitor's whisper and replay it as somebody who was never there.
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  try {
    const captured: WhisperMemory[] = [];
    const engine = new AudioMemoryEngine((memory) => captured.push(memory));
    await engine.start(STREAM, 0.02);
    const context = audio.context!;
    await settle(context);

    // Suppression only ever extends — the room can be told to stay closed for
    // longer, never to reopen early — so the window is waited out.
    engine.suppressFor(200);
    for (let block = 0; block < 6; block += 1) {
      context.worklet!.emit(new Float32Array(2048).fill(0.4));
    }
    assert.equal(engine.getDiagnostics().suppressed, true);
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(engine.getDiagnostics().suppressed, false);

    // A whisper captured now would have to be built from the room's own voice,
    // because nothing else has been delivered.
    await listen(context, 0.08, 5);
    await listen(context, 0.0001, 8);
    assert.equal(captured.length, 1, 'the threshold still detected speech');
    assert.equal(
      engine.hasRecording(captured[0].id),
      false,
      'but everything heard while the room was speaking was thrown away',
    );

    // A nine-second cooldown follows every capture, so the room deliberately
    // cannot be asked for a second whisper here; that a real recording is kept
    // when the room is *not* speaking is covered by the capture test above.
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('the room voice is given the same context the microphone uses', async () => {
  // One context means one sample rate and one mix. The rendered voice reads it
  // at play time because it does not exist until start() has run.
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  try {
    const engine = new AudioMemoryEngine(() => {});
    assert.equal(engine.audioContext, null, 'there is nothing to play through yet');
    await engine.start(STREAM, 0.02);
    assert.equal(engine.audioContext, audio.context, 'and afterwards it is the microphone\'s own');
    engine.stop();
    assert.equal(engine.audioContext, null, 'a stopped engine offers no context to play into');
  } finally {
    audio.restore();
  }
});

void test('stopping twice does not throw into the microphone retry', async () => {
  // stop() is re-entered on every device drop. An oscillator already stopped
  // with its context throws on a second stop, and that throw would land inside
  // the 2.5 s retry that is trying to bring the microphone back.
  const audio = installAudioGlobals();
  try {
    const engine = new AudioMemoryEngine(() => {});
    await engine.start(STREAM, 0.02);
    const context = audio.context!;
    // The context went away underneath the engine, as it does when a device is
    // unplugged: its oscillators are already stopped.
    for (const oscillator of context.oscillators) oscillator.stop();
    engine.stop();
    engine.stop();
  } finally {
    audio.restore();
  }
});

void test('a whisper that runs on is cut at the clip ceiling rather than growing without bound', async () => {
  // A held conversation, a radio left on, a ventilation fan that crosses the
  // threshold: without a ceiling the envelope and the PCM clip grow for as
  // long as the sound lasts, and a gallery day is twelve hours of it.
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  const held: WhisperMemory[] = [];
  try {
    const engine = new AudioMemoryEngine((memory) => held.push(memory));
    await engine.start(STREAM, 0.002);
    const context = audio.context!;
    await settle(context);
    // 85 ms a tick, so 80 ticks is nearly seven seconds of unbroken speech.
    await listen(context, 0.02, 80);
    assert.ok(held.length >= 1, 'seven seconds of speech produced no whisper at all');
    for (const whisper of held) {
      assert.ok(whisper.duration <= 6.5, `a clip ran to ${whisper.duration}s`);
      assert.ok(whisper.envelope.length <= 32, 'the envelope is bounded to 32 points');
    }
  } finally { audio.restore(); }
});

void test('a context the browser has suspended is resumed rather than played into', async () => {
  // A suspended context accepts everything and plays nothing, without erroring.
  // From outside the machine it is indistinguishable from a bug anywhere else
  // in the chain, and it is why a replay counter can climb while the room is
  // silent. Reported, and resumed defensively before anything is played.
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  const held: WhisperMemory[] = [];
  try {
    const engine = new AudioMemoryEngine((memory) => held.push(memory));
    await engine.start(STREAM, 0.002);
    const context = audio.context!;
    await settle(context);
    // Real PCM, through the worklet: a whisper with no recording behind it is
    // an old envelope-only memory, and those are correctly silent.
    context.worklet!.emit(new Float32Array(4096).fill(0.05));
    await listen(context, 0.02, 6);
    await listen(context, 0.00002, 8);
    assert.ok(held.length, 'nothing was captured to replay');
    assert.ok(engine.hasRecording(held[0].id), 'the capture kept no audio');

    context.state = 'suspended';
    assert.equal(engine.getDiagnostics().contextState, 'suspended', 'a muted room must not look like a broken one');
    // A replay is gated for as long as the last one lasts, so move past it.
    context.currentTime += 30;
    const before = context.resumes;
    engine.replay(held[0], 0.5);
    assert.equal(context.resumes, before + 1, 'the context was played into while suspended');
    assert.equal(context.state, 'running');
    assert.ok(context.sources.length > 0, 'and the whisper actually reached a buffer');
  } finally { audio.restore(); }
});

void test('an unknown room condition still has a tone, rather than silence', async () => {
  // Every RoomPersonality has an entry, and a test elsewhere requires that.
  // This is the other half: a condition that somehow has none must fall back to
  // the dormant tone, because the speakers run continuously and a gap in the
  // drone is audible as a fault in a quiet gallery.
  const audio = installAudioGlobals({ sampleRate: 24_000 });
  try {
    const engine = new AudioMemoryEngine(() => {});
    await engine.start(STREAM, 0.03);
    const context = audio.context!;
    const gain = context.nodesOfKind('gain').find((node) => node.reaches('destination'))! as GainDouble;
    engine.setRoomState('dormant', 0.2, 0.4);
    const dormant = gain.gain.value;
    engine.setRoomState('unheard-of' as never, 0.2, 0.4);
    assert.equal(gain.gain.value, dormant, 'an unknown condition must sound like a dormant room, not like nothing');
    assert.ok(context.nodesOfKind('oscillator').length > 0, 'the drone must still be running');
  } finally { audio.restore(); }
});
