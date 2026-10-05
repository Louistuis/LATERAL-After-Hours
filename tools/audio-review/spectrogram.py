"""Spectrogram sheet of review clips (log frequency), for eyeballing pitch tracking, harmonics and noise."""
import sys, wave, numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
out, paths = sys.argv[1], sys.argv[2:]
fig, axes = plt.subplots(len(paths), 1, figsize=(11, 2.1 * len(paths)), squeeze=False)
for ax, path in zip(axes[:, 0], paths):
    with wave.open(path) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32767; sr = w.getframerate()
    ax.specgram(x, NFFT=2048, Fs=sr, noverlap=1536, cmap='magma', vmin=-150, vmax=-40)
    ax.set_yscale('symlog', linthresh=200); ax.set_ylim(30, 12000)
    ax.set_title(path.split('/')[-1], fontsize=9, loc='left'); ax.tick_params(labelsize=7)
fig.tight_layout(); fig.savefig(out, dpi=72)
