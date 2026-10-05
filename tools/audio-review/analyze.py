"""Quick level/spectrum analysis of review clips: per-window RMS/peak and dominant frequency."""
import sys, wave, numpy as np
def load(path):
    with wave.open(path) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32767, w.getframerate()
for path in sys.argv[1:]:
    x, sr = load(path)
    win = int(sr * 0.5)
    print(path.split('/')[-1])
    for i in range(0, len(x) - win + 1, win):
        seg = x[i:i + win]
        spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
        freqs = np.fft.rfftfreq(len(seg), 1 / sr)
        mask = freqs > 30
        f0 = freqs[mask][np.argmax(spec[mask])]
        cen = (spec[mask] * freqs[mask]).sum() / max(spec[mask].sum(), 1e-12)
        rms = 20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-12)
        pk = 20 * np.log10(np.abs(seg).max() + 1e-12)
        print(f"  t={i/sr:4.1f}s rms={rms:6.1f} peak={pk:6.1f} peakHz={f0:7.1f} centroid={cen:7.1f}")
