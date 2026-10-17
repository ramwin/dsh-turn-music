#!/usr/bin/env python3
"""Generate the bundled default ringtone: an old-fashioned "ding-a-ling" bell.

Why synthesize instead of shipping an arbitrary sample: the plugin must be
installable by anyone with no extra download, and the asset must be
redistributable (CC0 / public domain by construction, since it is pure math).
The result is a two-bell "ding-ding" strike pair followed by silence, repeated
three times — the cadence people recognize as a telephone ring.

Usage:
    python3 scripts/make-ringtone.py assets/ringtone.mp3

Requires ffmpeg on PATH for the final MP3 encode (the WAV stage is stdlib only).
"""

from __future__ import annotations

import math
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

SAMPLE_RATE = 44100

# Two bell partials close together: the beat between them is what gives a
# mechanical bell its "ring" instead of a plain sine beep.
PARTIALS = (
    (1046.0, 1.00),  # fundamental, C6 neighbourhood
    (1174.0, 0.85),  # second partial a whole tone up
    (2093.0, 0.22),  # octave shimmer
    (2637.0, 0.12),  # metallic top end
)


def bell(duration: float, amplitude: float = 0.85) -> list[float]:
    """One bell strike: exponential decay, double-partial shimmer, soft attack."""
    count = int(SAMPLE_RATE * duration)
    out = [0.0] * count
    attack = int(SAMPLE_RATE * 0.004)  # 4 ms attack keeps the strike clicky but clean
    for i in range(count):
        t = i / SAMPLE_RATE
        # Bell decay: loud immediately, tail falls off over the whole strike.
        env = math.exp(-4.2 * t)
        if i < attack:
            env *= i / attack
        sample = 0.0
        for freq, weight in PARTIALS:
            sample += weight * math.sin(2 * math.pi * freq * t)
        # 22 Hz trill: the "a-ling" wobble of a real ringer.
        sample *= 1.0 - 0.28 * (0.5 + 0.5 * math.sin(2 * math.pi * 22.0 * t))
        out[i] = amplitude * env * sample / sum(w for _, w in PARTIALS)
    return out


def silence(duration: float) -> list[float]:
    return [0.0] * int(SAMPLE_RATE * duration)


def ringtone() -> list[float]:
    """ring … pause … ring … pause … ring: three strikes, ~6.2 s total."""
    samples: list[float] = []
    for _ in range(3):
        samples += bell(0.62)          # ding
        samples += silence(0.10)
        samples += bell(0.42, 0.62)    # a-ling (slightly softer second strike)
        samples += silence(1.34)       # gap between rings
    # Tail: trim the trailing silence to a short pause so looping is seamless.
    return samples[: -int(SAMPLE_RATE * 0.9)]


def write_wav(path: Path, samples: list[float]) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        frames = bytearray()
        for value in samples:
            clipped = max(-1.0, min(1.0, value))
            frames += struct.pack("<h", int(clipped * 32767))
        wav.writeframes(bytes(frames))


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "assets/ringtone.mp3")
    out.parent.mkdir(parents=True, exist_ok=True)
    samples = ringtone()
    with tempfile.TemporaryDirectory() as tmp:
        wav_path = Path(tmp) / "ringtone.wav"
        write_wav(wav_path, samples)
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", str(wav_path),
                "-codec:a", "libmp3lame", "-b:a", "64k", "-ac", "1",
                str(out),
            ],
            check=True,
        )
    duration = len(samples) / SAMPLE_RATE
    print(f"{out}: {out.stat().st_size} bytes, {duration:.2f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
