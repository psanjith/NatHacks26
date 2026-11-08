"""Jaw-clench detector for the Ganglion stream (the select signal for the eye-tracker backup).

A clench fires the jaw and temple muscles: broadband EMG, strongest on T7 (above the ear, over the
temporalis). EEG is tiny above 25 Hz, so the detector measures power in 25-95 Hz, minus 54-66 Hz
(the mains hum here is smeared over 58.5-61.5 Hz) and minus the hum's aliased harmonics (20/40/80 Hz
when sampling at 200 Hz).

What made this hard on our recordings: with this much hum, the channels that get near the Ganglion's
input limit (Oz, O2, T7 at about +-15.7 mV) throw a ~0.2 s broadband burst exactly once a second,
which looks like a short clench. So a clench has to be HELD: the level is the 10th percentile of
50 ms power blocks over the last HOLD_S, which a 0.2 s burst can't lift, but a held clench does.

Ratio = that value / the channel's resting level (median over the last 30 s), so 1.0 = resting.
Each clench channel has its own threshold; "level" is the ratio / threshold, so 1.0 = a clench.
With a jaw electrode (face montage: Jaw + T7) both must pass together ("agree"): talking, a hum burst
or a bad contact on one electrode alone doesn't pick. Calibrate (relax 5 s, then clench and hold 3 s)
to keep the channels that show the clench and set each threshold between its rest and clench levels.
Before calibration: the clench channels (Jaw and/or T7), threshold 2 each.
"""
import collections
import threading
import time

import numpy as np
from scipy.signal import butter, iirnotch, sosfilt, tf2sos

BLOCK_S = 0.05          # power is measured in 50 ms blocks
HOLD_S = 0.7            # a clench must be held about this long
PCT = 10                # level = this percentile of the blocks in the hold window (so ~0.65 s of the 0.7 s must be raised)
REFRACTORY_S = 1.0      # shortest gap between two clenches
BASE_S = 30.0           # resting level = median level over this long
WARMUP_S = 3.0          # after start/reset: filters settle and a resting level builds up
DEFAULT_THRESHOLD = 2.0
HUM_BAND = (53.0, 67.0)


def mains_lines(fs, lo, hi):
    """Where 60 Hz and its harmonics land after sampling at fs, inside [lo, hi]."""
    out = set()
    for k in range(1, 12):
        f = abs(k * 60 - round(k * 60 / fs) * fs)
        if lo <= f <= hi and 1 < f < fs / 2 - 1:
            out.add(round(f, 3))
    return sorted(out)


class ClenchDetector:
    def __init__(self, fs, names, clench=None, agree=False):
        """clench: names of the channels meant for it (default T7, else all); agree: all must pass."""
        self.fs, self.names = fs, list(names)
        hi = min(95.0, 0.45 * fs)
        self.band = (25.0, hi)
        sos = [butter(4, self.band, "bandpass", fs=fs, output="sos")]
        if HUM_BAND[1] < hi:
            sos.append(butter(2, HUM_BAND, "bandstop", fs=fs, output="sos"))
        sos += [tf2sos(*iirnotch(f, 8, fs)) for f in mains_lines(fs, 15, hi + 5) if not HUM_BAND[0] <= f <= HUM_BAND[1]]
        self.sos = np.vstack(sos)
        self.B = max(2, int(round(BLOCK_S * fs)))
        self.W = max(3, int(round(HOLD_S / BLOCK_S)))
        self.lock = threading.Lock()
        if clench:
            self.candidates = [self.names.index(n) for n in clench if n in self.names]
        else:
            self.candidates = [self.names.index("T7")] if "T7" in self.names else list(range(len(names)))
        self.agree_wanted = agree
        self._defaults()
        self.n = 0
        self.last = None
        self._reset_signal()

    def _defaults(self):
        self.used = list(self.candidates)
        self.thr = np.full(len(self.names), DEFAULT_THRESHOLD)
        self.agree = self.agree_wanted and len(self.used) > 1
        self.calibrated = None

    def _reset_signal(self):
        n_ch = len(self.names)
        self.zi = np.zeros((self.sos.shape[0], n_ch, 2))
        self.pending = np.zeros((n_ch, 0))
        self.blocks = collections.deque(maxlen=self.W)        # block RMS per channel
        self.levels = collections.deque()                       # (t, raw level per channel) for the resting level
        self.ratios_hist = collections.deque()                  # (t, level / resting per channel) for calibration
        self.base = None
        self.ratios = np.zeros(n_ch)
        self.level = 0.0
        self.active = False
        self.t_start = time.time()
        self.cal = None

    def reset(self):
        """Call after the stream was interrupted (impedance mode, reconnect)."""
        with self.lock:
            self._reset_signal()

    def feed(self, x, now=None):
        """x: (channels, n) new raw samples in uV."""
        if x.shape[1] == 0:
            return
        now = time.time() if now is None else now
        with self.lock:
            y, self.zi = sosfilt(self.sos, x, axis=-1, zi=self.zi)
            self.pending = np.hstack([self.pending, y])
            nb = self.pending.shape[1] // self.B
            for k in range(nb):
                self._block(self.pending[:, k * self.B:(k + 1) * self.B], now)
            self.pending = self.pending[:, nb * self.B:]

    def _combine(self, ratios):
        norm = ratios[self.used] / self.thr[self.used]
        return float(norm.min() if self.agree else norm.max())

    def _block(self, y, now):
        if now - self.t_start < 1.0:            # filters still ringing from the start
            return
        self.blocks.append(np.sqrt(np.mean(y ** 2, axis=1)))
        if len(self.blocks) < self.W:
            return
        raw = np.percentile(np.array(self.blocks), PCT, axis=0)
        self.levels.append((now, raw))
        while self.levels and self.levels[0][0] < now - BASE_S:
            self.levels.popleft()
        if now - self.t_start < WARMUP_S:
            return
        self.base = np.maximum(np.median(np.array([r for _, r in self.levels]), axis=0), 1e-3)
        self.ratios = raw / self.base
        self.ratios_hist.append((now, self.ratios.copy()))
        while self.ratios_hist and self.ratios_hist[0][0] < now - 60:
            self.ratios_hist.popleft()
        self.level = self._combine(self.ratios)
        if self.active:
            if self.level < 0.75:               # relaxed again
                self.active = False
        elif self.level >= 1.0 and (self.last is None or now - self.last >= REFRACTORY_S):
            self.n += 1
            self.last = now
            self.active = True

    # ---------- calibration: rest -> clench -> done
    def calibrate(self, step, factor=None):
        now = time.time()
        with self.lock:
            if step == "rest":
                self.cal = {"rest0": now}
                return {"ok": True}
            if step == "clench":
                if not self.cal:
                    return {"error": "start with the rest step"}
                self.cal["rest1"] = self.cal["clench0"] = now
                return {"ok": True}
            if step == "scale":                  # +/- in the sim: all thresholds up or down
                self.thr = np.clip(self.thr * float(factor), 1.2, 30)
                return {"ok": True, "thresholds": self._thr_dict()}
            if step == "reset":
                self._defaults()
                return {"ok": True}
            if step != "done":
                return {"error": f"unknown step {step}"}
            c = self.cal or {}
            self.cal = None
            if "clench0" not in c:
                return {"error": "calibration wasn't started"}
            # resting = the relax step only (earlier history may hold practice clenches); skip its first
            # HOLD_S + 0.1 s so a clench just before it has left the hold window
            rest = np.array([r for t, r in self.ratios_hist if c["rest0"] + HOLD_S + 0.1 <= t <= c["clench0"] - 0.1])
            clench = np.array([r for t, r in self.ratios_hist if c["clench0"] + HOLD_S + 0.2 <= t <= now])
            if len(rest) < 30 or len(clench) < 5:
                return {"error": "not enough signal during the check (is the headset streaming?)"}
            lo = np.percentile(rest, 99, axis=0)
            hi = np.percentile(clench, 50, axis=0)
            sep = hi / np.maximum(lo, 1e-6)
            used = [i for i in self.candidates if sep[i] >= 1.25] or [max(self.candidates, key=lambda i: sep[i])]
            thr = self.thr.copy()
            for i in used:
                # just above the resting peaks: a 1 s clench peaks well below the 3 s calibration hold
                t = max(1.6, 1.1 * lo[i])
                if t > 0.75 * hi[i]:
                    t = np.sqrt(lo[i] * hi[i])
                thr[i] = float(np.clip(t, 1.2, 15))
            best = float(max(sep[i] for i in self.candidates))
            if best < 1.15:
                verdict, ok = "Couldn't see the clench over the hum. Clench harder, or check the jaw/T7 electrodes touch skin.", False
            elif best < 1.5:
                verdict, ok = "Weak but usable. Clench firmly and hold it.", True
            else:
                verdict, ok = "Clear clench signal.", True
            agree = self.agree_wanted and len(used) > 1
            missing = [self.names[i] for i in self.candidates if i not in used]
            if ok and self.agree_wanted and missing:
                verdict += f" {', '.join(missing)} didn't show it, so {', '.join(self.names[i] for i in used)} alone picks."
            elif ok and agree:
                verdict += f" {' and '.join(self.names[i] for i in used)} must both see it."
            if ok:
                self.thr, self.used, self.agree = thr, used, agree
            self.calibrated = {"t": now, "used": [self.names[i] for i in used], "agree": agree,
                               "thresholds": {self.names[i]: round(float(thr[i]), 2) for i in used},
                               "separation": {self.names[i]: round(float(sep[i]), 2) for i in self.candidates},
                               "verdict": verdict, "ok": ok}
            return dict(self.calibrated)

    def _thr_dict(self):
        return {self.names[i]: round(float(self.thr[i]), 2) for i in self.used}

    def state(self):
        with self.lock:
            return {"ready": self.base is not None, "n": self.n, "last": self.last, "now": time.time(),
                    "level": round(self.level, 2), "active": self.active, "agree": self.agree,
                    "ratios": [round(float(r), 2) for r in self.ratios], "names": self.names,
                    "thresholds": [round(float(self.thr[i]), 2) if i in self.used else None for i in range(len(self.names))],
                    "used": [self.names[i] for i in self.used], "calibrated": self.calibrated,
                    "calibrating": bool(self.cal), "hold_s": HOLD_S, "band_hz": [round(b) for b in self.band]}
