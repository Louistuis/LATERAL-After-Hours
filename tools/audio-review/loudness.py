"""A-weighted loudness (LAeq, dBFS) per clip and per 0.5 s window max, plus peak. Usage: loudness.py a.wav b.wav ..."""
import sys, wave, numpy as np
def load(path):
    with wave.open(path) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32767, w.getframerate()
def a_weight(freqs):
    f2 = freqs ** 2
    ra = (12194 ** 2 * f2 ** 2) / ((f2 + 20.6 ** 2) * np.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2))
    return ra * 10 ** (2.0 / 20)
def la(seg, sr):
    spec = np.fft.rfft(seg)
    freqs = np.fft.rfftfreq(len(seg), 1 / sr)
    w = a_weight(np.maximum(freqs, 1e-3)); w[0] = 0
    y = np.fft.irfft(spec * w, len(seg))
    return 20 * np.log10(np.sqrt((y ** 2).mean()) + 1e-12)
rows = []
for path in sys.argv[1:]:
    x, sr = load(path)
    win = int(sr * 0.5)
    windows = [la(x[i:i + win], sr) for i in range(0, len(x) - win + 1, win)]
    rows.append((path.split('/')[-1][:-4], la(x, sr), max(windows), 20 * np.log10(np.abs(x).max() + 1e-12)))
for name, total, mx, pk in rows:
    print(f"{name:28s} LAeq={total:6.1f}  maxLA(0.5s)={mx:6.1f}  peak={pk:6.1f}")
