#!/usr/bin/env python3
"""Generate the soundpack mod's WAV assets: 3 packs (minimal, retro, nature) x 4 events (done, error, permission, green).

Everything is synthesised here with numpy, nothing is sampled: 16-bit mono PCM at 22.05 kHz, normalised to the same
peak, with short fades so no clip clicks. Run:  python3 gen_soundpack.py [output_dir]
"""
import sys
import wave
from pathlib import Path

import numpy as np

SR = 22050
TARGET_RMS = 0.18  # every clip has the same average loudness, so no pack or event jumps out
LIMIT = 0.92  # the soft limiter keeps peaks below this, so nothing clips
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "mods/soundpack/assets"


# --- building blocks -----------------------------------------------------------------------------------------------

def time(seconds: float) -> np.ndarray:
    return np.arange(int(round(seconds * SR))) / SR


def note_freq(name: str) -> float:
    """'C5' -> 523.25 Hz (equal temperament, A4 = 440)."""
    names = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    semitones = names[name[0]] + (1 if "#" in name else 0) + (int(name[-1]) - 4) * 12 - 9
    return 440.0 * 2 ** (semitones / 12)


def decay(t: np.ndarray, tau: float, attack: float = 0.004) -> np.ndarray:
    """Exponential decay with a short linear attack: the shape of a struck or plucked sound."""
    return np.minimum(1.0, t / max(attack, 1e-4)) * np.exp(-t / tau)


def lowpass(x: np.ndarray, cutoff: float) -> np.ndarray:
    """Brick-wall lowpass by FFT: smooths the hard edges of square waves and noise."""
    spectrum = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1 / SR)
    spectrum[freqs > cutoff] = 0
    return np.fft.irfft(spectrum, len(x))


def highpass(x: np.ndarray, cutoff: float) -> np.ndarray:
    return x - lowpass(x, cutoff)


def place(length: float, parts: list[tuple[float, np.ndarray]]) -> np.ndarray:
    """Mixes `parts` (start time in seconds, signal) into one buffer of `length` seconds."""
    out = np.zeros(int(round(length * SR)))
    for start, signal in parts:
        i = int(round(start * SR))
        j = min(len(out), i + len(signal))
        if j > i:
            out[i:j] += signal[: j - i]
    return out


def echo(x: np.ndarray, delays: list[tuple[float, float]]) -> np.ndarray:
    """A little room: delayed, quieter copies."""
    out = x.copy()
    for seconds, gain in delays:
        i = int(seconds * SR)
        out[i:] += gain * x[: len(x) - i]
    return out


def partials(freq: float, dur: float, amps: list[tuple[float, float, float]]) -> np.ndarray:
    """Sum of sine partials: each (ratio, amplitude, decay seconds). The recipe of a bell, a marimba, an organ pipe."""
    t = time(dur)
    return sum(a * np.sin(2 * np.pi * freq * r * t) * np.exp(-t / tau) for r, a, tau in amps) * np.minimum(1.0, t / 0.004)


def pulse(freq: np.ndarray | float, dur: float, duty: float = 0.5) -> np.ndarray:
    """Pulse wave, `freq` constant or one value per sample (a sweep)."""
    t = time(dur)
    f = np.full_like(t, freq) if np.isscalar(freq) else freq
    phase = np.cumsum(f) / SR
    return np.where((phase % 1.0) < duty, 1.0, -1.0)


def triangle(freq: float, dur: float) -> np.ndarray:
    return 2 / np.pi * np.arcsin(np.sin(2 * np.pi * freq * time(dur)))


def sweep(f0: float, f1: float, dur: float, curve: float = 1.0) -> np.ndarray:
    """Instantaneous frequency per sample from f0 to f1; `curve` > 1 spends more time near f0."""
    x = (time(dur) / dur) ** curve
    return f0 + (f1 - f0) * x


def sine_sweep(f0: float, f1: float, dur: float, curve: float = 1.0) -> np.ndarray:
    return np.sin(2 * np.pi * np.cumsum(sweep(f0, f1, dur, curve)) / SR)


def gate(x: np.ndarray, attack: float, release: float, hold: float | None = None) -> np.ndarray:
    """Linear attack and release around a sound that has no envelope of its own (chip notes)."""
    n = len(x)
    env = np.ones(n)
    a, r = int(attack * SR), int(release * SR)
    if a:
        env[:a] = np.linspace(0, 1, a)
    if r:
        env[-r:] = np.minimum(env[-r:], np.linspace(1, 0, r))
    if hold is not None:
        env *= np.exp(-time(n / SR) / hold)
    return x * env


def crush(x: np.ndarray, bits: int) -> np.ndarray:
    """Fewer amplitude steps: the grit of an old sound chip."""
    levels = 2 ** (bits - 1)
    return np.round(x * levels) / levels


def finish(x: np.ndarray, lead: float = 0.003, tail: float = 0.02) -> np.ndarray:
    """Removes DC, fades both ends, evens out loudness (RMS) across clips and tames peaks with a soft limiter."""
    x = x - np.mean(x)
    n = len(x)
    fade_in, fade_out = int(lead * SR), int(tail * SR)
    x[:fade_in] *= np.linspace(0, 1, fade_in)
    x[n - fade_out:] *= np.linspace(1, 0, fade_out)
    x = x / np.sqrt(np.mean(x ** 2)) * TARGET_RMS
    return np.tanh(x / LIMIT) * LIMIT  # transparent below LIMIT / 2, rounds the few transients above it


def write(pack: str, event: str, x: np.ndarray) -> None:
    path = OUT / pack / f"{event}.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    samples = np.round(x * 32767).astype("<i2")
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SR)
        wav.writeframes(samples.tobytes())


BELL = [(1.0, 1.0, 0.30), (2.0, 0.18, 0.16), (3.0, 0.05, 0.09)]  # soft: a fundamental and two quiet harmonics
MARIMBA = [(1.0, 1.0, 0.26), (4.0, 0.30, 0.05), (9.2, 0.08, 0.02)]
CHIME_BAR = [(1.0, 1.0, 0.55), (2.756, 0.35, 0.25), (5.404, 0.15, 0.12), (8.933, 0.06, 0.06)]  # a struck metal bar's partials


# --- minimal: clean, quiet sine tones -------------------------------------------------------------------------------

def minimal_done() -> np.ndarray:
    """Two soft bell notes, a fifth apart, rising: 'finished'."""
    first = partials(note_freq("G5"), 0.8, [(r, a, tau * 0.8) for r, a, tau in BELL])
    second = partials(note_freq("C6"), 0.8, [(r, a, tau * 1.3) for r, a, tau in BELL])
    return echo(place(0.95, [(0.0, 0.8 * first), (0.17, second)]), [(0.09, 0.22), (0.18, 0.1)])


def minimal_error() -> np.ndarray:
    """Two low, rounded notes stepping down: 'oh no', without any edge."""
    def tone(name: str, tau: float) -> np.ndarray:
        t = time(0.45)
        wave_ = np.sin(2 * np.pi * note_freq(name) * t) + 0.28 * np.sin(2 * np.pi * 3 * note_freq(name) * t) + 0.08 * np.sin(2 * np.pi * 5 * note_freq(name) * t)
        return wave_ * decay(t, tau, 0.012)
    return lowpass(place(0.7, [(0.0, tone("E4", 0.16)), (0.19, tone("C4", 0.24))]), 1800)


def minimal_permission() -> np.ndarray:
    """Two marimba notes, the second higher and left hanging, like a question."""
    low = partials(note_freq("A4"), 0.5, MARIMBA)
    high = partials(note_freq("E5"), 0.7, [(r, a, tau * 1.4) for r, a, tau in MARIMBA])
    return echo(place(0.8, [(0.0, 0.85 * low), (0.15, high)]), [(0.12, 0.15)])


def minimal_green() -> np.ndarray:
    """A quick sparkle of four rising notes: 'all good'."""
    parts = []
    for i, name in enumerate(["G5", "B5", "D6", "G6"]):
        tau = 0.4 if i == 3 else 0.11
        parts.append((i * 0.075, partials(note_freq(name), 0.6, [(r, a, tau * (0.5 + 0.5 * (k / 3))) for k, (r, a, _) in enumerate(BELL)])))
    return echo(place(0.9, parts), [(0.08, 0.2), (0.16, 0.08)])


# --- retro: 8-bit chip tunes ----------------------------------------------------------------------------------------

def chip_note(name: str, dur: float, duty: float = 0.5, hold: float | None = None, vibrato: float = 0.0) -> np.ndarray:
    freq = note_freq(name)
    if vibrato:
        t = time(dur)
        f = freq * (1 + vibrato * np.sin(2 * np.pi * 6 * t))
        return gate(pulse(f, dur, duty), 0.002, 0.012, hold)
    return gate(pulse(freq, dur, duty), 0.002, 0.012, hold)


def retro_done() -> np.ndarray:
    """The classic 'level complete' arpeggio, ending on a held top note with a triangle bass."""
    parts = [(i * 0.085, chip_note(n, 0.085, 0.25)) for i, n in enumerate(["C5", "E5", "G5"])]
    parts.append((0.255, chip_note("C6", 0.5, 0.25, hold=0.35, vibrato=0.006)))
    parts.append((0.255, 0.9 * gate(triangle(note_freq("C4"), 0.5), 0.004, 0.05, 0.5)))
    return lowpass(crush(place(0.8, parts), 7), 5500)


def retro_error() -> np.ndarray:
    """Two falling buzzes with a crunchy hit at the start: the 'you got hurt' sound."""
    t1, t2 = 0.24, 0.32
    first = gate(pulse(sweep(392, 196, t1), t1, 0.25), 0.002, 0.03)
    second = gate(pulse(sweep(262, 98, t2, 0.8), t2, 0.5), 0.002, 0.06)
    rng = np.random.default_rng(7)
    hit = gate(rng.uniform(-1, 1, int(0.05 * SR)), 0.0, 0.04)
    return lowpass(crush(place(0.62, [(0.0, first), (0.0, 0.3 * lowpass(hit, 3000)), (0.26, second)]), 6), 4800)


def retro_permission() -> np.ndarray:
    """A rising 'beep-boop' pair, twice: someone is wanted."""
    parts = []
    for i, offset in enumerate([0.0, 0.26]):
        parts.append((offset, chip_note("E5", 0.1, 0.5, hold=0.2)))
        parts.append((offset + 0.115, chip_note("B5", 0.12, 0.5, hold=0.2)))
    return lowpass(crush(place(0.55, parts), 7), 5500)


def retro_green() -> np.ndarray:
    """A fast power-up run followed by a shimmering chord."""
    parts = [(i * 0.052, chip_note(n, 0.06, 0.125)) for i, n in enumerate(["C5", "E5", "G5", "C6", "E6", "G6"])]
    chord = sum(chip_note(n, 0.45, 0.5, hold=0.3, vibrato=0.01) / 3 for n in ["C6", "E6", "G6"])
    parts.append((0.33, chord))
    return lowpass(crush(place(0.8, parts), 7), 5800)


# --- nature: birds, water and wood ----------------------------------------------------------------------------------

def nature_done() -> np.ndarray:
    """A wind chime stirred by a breeze: five bars, struck unevenly, ringing out."""
    rng = np.random.default_rng(11)
    parts = []
    for offset, name, level in [(0.0, "D6", 0.9), (0.13, "A6", 0.7), (0.29, "E6", 0.8), (0.43, "G6", 0.6), (0.66, "D7", 0.5)]:
        parts.append((offset + rng.uniform(0, 0.01), level * partials(note_freq(name), 1.2, CHIME_BAR)))
    return lowpass(echo(place(1.55, parts), [(0.11, 0.18), (0.23, 0.08)]), 9000)


def nature_error() -> np.ndarray:
    """Two hollow wood knocks, the second softer: 'someone is at the door'."""
    rng = np.random.default_rng(3)

    def knock(level: float) -> np.ndarray:
        t = time(0.25)
        body = np.sin(2 * np.pi * 196 * t) * np.exp(-t / 0.05) + 0.5 * np.sin(2 * np.pi * 392 * t * 1.01) * np.exp(-t / 0.028) + 0.25 * np.sin(2 * np.pi * 760 * t) * np.exp(-t / 0.012)
        click = highpass(rng.uniform(-1, 1, len(t)), 1500) * np.exp(-t / 0.006) * 0.35
        return level * (body + click) * np.minimum(1.0, t / 0.001)
    return lowpass(echo(place(0.62, [(0.0, knock(1.0)), (0.23, knock(0.6))]), [(0.05, 0.12)]), 4500)


def nature_permission() -> np.ndarray:
    """A bird's 'tweet-tweet' and a little trill."""
    def chirp(f0: float, f1: float, dur: float, level: float) -> np.ndarray:
        t = time(dur)
        freq = sweep(f0, f1, dur, 0.7) * (1 + 0.012 * np.sin(2 * np.pi * 38 * t))
        phase = 2 * np.pi * np.cumsum(freq) / SR
        wave_ = np.sin(phase) + 0.22 * np.sin(2 * phase)
        return level * wave_ * np.sin(np.pi * t / dur) ** 1.5
    parts = [(0.0, chirp(2300, 3500, 0.11, 0.9)), (0.17, chirp(2500, 3800, 0.12, 1.0))]
    for i in range(4):  # the trill
        parts.append((0.36 + i * 0.045, chirp(3400, 2900, 0.035, 0.55)))
    return echo(place(0.65, parts), [(0.06, 0.1)])


def nature_green() -> np.ndarray:
    """Water droplets rising in pitch, then settling: 'all clear'."""
    parts = []
    for i, f in enumerate([520, 640, 790, 960, 1190]):
        dur = 0.22
        t = time(dur)
        drop = np.sin(2 * np.pi * np.cumsum(f * (1 + 0.7 * (1 - np.exp(-t / 0.03)))) / SR) * decay(t, 0.07, 0.002)
        parts.append((i * 0.088, drop * (0.7 + 0.06 * i)))
    parts.append((0.5, partials(note_freq("E6"), 0.5, [(1.0, 0.4, 0.2), (2.0, 0.08, 0.1)])))
    return echo(place(0.95, parts), [(0.1, 0.25), (0.21, 0.12), (0.33, 0.05)])


SOUNDS = {
    "minimal": {"done": minimal_done, "error": minimal_error, "permission": minimal_permission, "green": minimal_green},
    "retro": {"done": retro_done, "error": retro_error, "permission": retro_permission, "green": retro_green},
    "nature": {"done": nature_done, "error": nature_error, "permission": nature_permission, "green": nature_green},
}


def main() -> None:
    total = 0
    for pack, events in SOUNDS.items():
        for event, make in events.items():
            x = finish(make())
            write(pack, event, x)
            size = (OUT / pack / f"{event}.wav").stat().st_size
            total += size
            print(f"{pack}/{event}.wav  {len(x) / SR:4.2f} s  {size / 1024:5.1f} KB")
    print(f"total {total / 1024:.0f} KB")


if __name__ == "__main__":
    main()
