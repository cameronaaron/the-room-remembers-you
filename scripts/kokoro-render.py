# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["kokoro>=0.9.2", "soundfile", "numpy"]
# ///
"""
Render the room's fixed vocabulary to audio with Kokoro-82M (Apache 2.0).

Invoked by scripts/render-voice.ts, never by the installation. The gallery
runtime only ever reads the rendered files, so nothing here runs while the
room is open and no model or network is needed to exhibit the work.

Reads a job as JSON on stdin and writes one WAV per line plus a JSON report to
the path the job names. The report does not go to stdout: the model stack
prints its own progress there (spacy announces a model download on first run),
and a shared channel cannot carry a payload. Levels are equalised here rather
than at playback: the room speaks at a volume the operator sets once, and a
line that happens to synthesise quieter than its neighbours would otherwise be
lost under the drone.
"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SAMPLE_RATE = 24_000
# Perceived level, not peak. Kokoro's output sat around 0.057 RMS while macOS
# `say` sat at 0.111, so an unequalised swap would have quietened the room.
TARGET_RMS = 0.11
PEAK_CEILING = 0.89
# Silence below this is padding, not speech. Trimming it is what makes the
# reported duration tight enough to close the microphone precisely.
SILENCE_FLOOR = 10 ** (-45 / 20)


def trim(audio: np.ndarray) -> np.ndarray:
    loud = np.flatnonzero(np.abs(audio) > SILENCE_FLOOR)
    if loud.size == 0:
        return audio
    pad = int(SAMPLE_RATE * 0.02)
    return audio[max(0, loud[0] - pad): min(len(audio), loud[-1] + pad)]


def common_gain(clips: list[np.ndarray]) -> float:
    """
    One gain for every line, so they all land at the same perceived level.

    Normalising each clip to a target and then pulling back whichever ones
    clipped is not equalisation: it leaves the peakiest lines quietest. With
    af_heart that put a 2.5 dB spread across the vocabulary (0.082 to 0.110
    RMS) while appearing to succeed. Instead the target is lowered until the
    worst crest factor in the set fits under the ceiling, so every line keeps
    an identical RMS and none of them clips.
    """
    worst = 0.0
    for clip in clips:
        rms = float(np.sqrt(np.mean(clip ** 2)))
        if rms <= 0:
            continue
        worst = max(worst, float(np.max(np.abs(clip))) / rms)
    if worst <= 0:
        return 1.0
    return min(TARGET_RMS, PEAK_CEILING / worst)


def main() -> int:
    job = json.load(sys.stdin)
    out = Path(job["outDir"])
    out.mkdir(parents=True, exist_ok=True)

    from kokoro import KPipeline
    pipeline = KPipeline(lang_code=job.get("langCode", "b"), repo_id="hexgrad/Kokoro-82M")

    clips = []
    for line in job["lines"]:
        chunks = [audio for _, _, audio in pipeline(line["text"], voice=job["voice"], speed=job.get("speed", 1.0))]
        if not chunks:
            raise SystemExit(f"kokoro produced no audio for {line['id']!r}")
        audio = np.concatenate(chunks) if len(chunks) > 1 else np.asarray(chunks[0])
        clips.append(trim(np.asarray(audio, dtype=np.float32)))
        print(f"  {line['id']}: {round(len(clips[-1]) / SAMPLE_RATE * 1000)} ms", file=sys.stderr)

    gain = common_gain(clips)
    print(f"  common gain {gain:.4f} (target rms {TARGET_RMS})", file=sys.stderr)

    rendered = []
    for line, clip in zip(job["lines"], clips, strict=True):
        rms = float(np.sqrt(np.mean(clip ** 2)))
        audio = clip * (gain / rms) if rms > 0 else clip
        path = out / f"{line['id']}.wav"
        sf.write(path, audio, SAMPLE_RATE, subtype="PCM_16")
        rendered.append({
            "id": line["id"],
            "text": line["text"],
            "file": path.name,
            "durationMs": round(len(audio) / SAMPLE_RATE * 1000),
            "peak": round(float(np.max(np.abs(audio))), 4),
            "rms": round(float(np.sqrt(np.mean(audio ** 2))), 4),
        })

    report = {"voice": job["voice"], "sampleRate": SAMPLE_RATE, "lines": rendered}
    Path(job["reportPath"]).write_text(json.dumps(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
