"""Left/right glances from two electrodes at the outer corners of the eyes (horizontal EOG).

The front of the eye is electrically positive, so looking left raises the left-corner electrode
and lowers the right one: their difference (L - R) steps up or down by a few hundred uV and stays
there until the eyes come back. Mains hum is the same on both and cancels in the difference, and
the signal is slow, so it's low-passed at 6 Hz where the hum isn't.

Live: L - R, low-passed, averaged in 50 ms blocks, minus its median over the last 6 s (removes
electrode drift). A glance is that deviation passing half the calibrated left (or right) amplitude
for 200 ms. The look back to the middle isn't a glance: for 1.5 s after a glance the other direction
is ignored (on an AC-coupled input the return shows as an opposite swing). Calibrate by looking at
the middle (2.5 s), the left edge, the middle, the right edge, the middle (1.5 s each).
"""
import collections
import threading
import time

import numpy as np
from scipy.signal import butter, sosfilt

LP_HZ = 6.0
BLOCK_S = 0.05
BASE_S = 6.0            # drift removal: median over this long
HOLD_BLOCKS = 4         # past the threshold this many blocks (200 ms) = a glance; the hum's 0.2 s bursts don't last
RETURN_S = 1.5          # after a glance, the opposite direction is the look back, not a glance
REFRACTORY_S = 0.6
KEEP_S = 8              # trace kept for the sim's live view
WARMUP_S = 1.5


class GlanceDetector:
    def __init__(self, fs, left, right):
        """left/right: channel indices of the electrodes at the left and right outer eye corners."""
        self.fs, self.left, self.right = fs, left, right
        self.sos = butter(4, LP_HZ, "lowpass", fs=fs, output="sos")
        self.B = max(2, int(round(BLOCK_S * fs)))
        self.lock = threading.Lock()
        self.amp = None           # {"left": signed uV, "right": signed uV} once calibrated
        self.calibrated = None
        self.n = {"left": 0, "right": 0}
        self.last = None          # (time, direction) of the last glance
        self._reset_signal()

    def _reset_signal(self):
        self.zi = np.zeros((self.sos.shape[0], 2))
        self.pending = np.zeros(0)
        self.vals = collections.deque()             # (t, block value) for the drift baseline
        self.hist = collections.deque()             # (t, deviation) for calibration
        self.trace = collections.deque(maxlen=int(KEEP_S / BLOCK_S))
        self.total = 0                              # blocks ever produced (index of the next one)
        self.dev = 0.0
        self.run = (None, 0)
        self.armed = True
        self.t_start = time.time()
        self.cal = None

    def reset(self):
        with self.lock:
            self._reset_signal()

    def feed(self, x, now=None):
        """x: (channels, n) new raw samples in uV."""
        if x.shape[1] == 0:
            return
        now = time.time() if now is None else now
        with self.lock:
            y, self.zi = sosfilt(self.sos, x[self.left] - x[self.right], zi=self.zi)
            self.pending = np.concatenate([self.pending, y])
            nb = len(self.pending) // self.B
            for k in range(nb):
                self._block(float(self.pending[k * self.B:(k + 1) * self.B].mean()), now)
            self.pending = self.pending[nb * self.B:]

    def _block(self, v, now):
        if now - self.t_start < 0.5:     # filter settling
            return
        self.vals.append((now, v))
        while self.vals and self.vals[0][0] < now - BASE_S:
            self.vals.popleft()
        dev = v - float(np.median([u for _, u in self.vals]))
        self.dev = dev
        self.trace.append(round(dev, 1))
        self.total += 1
        self.hist.append((now, dev))
        while self.hist and self.hist[0][0] < now - 60:
            self.hist.popleft()
        if not self.amp or now - self.t_start < WARMUP_S:
            return
        a_l, a_r = self.amp["left"], self.amp["right"]
        d = "left" if dev * np.sign(a_l) >= 0.5 * abs(a_l) else "right" if dev * np.sign(a_r) >= 0.5 * abs(a_r) else None
        self.run = (d, self.run[1] + 1) if d and d == self.run[0] else (d, 1 if d else 0)
        if not self.armed and abs(dev) < 0.25 * min(abs(a_l), abs(a_r)):
            self.armed = True
        if d and self.armed and self.run[1] >= HOLD_BLOCKS:
            if self.last and d != self.last[1] and now - self.last[0] < RETURN_S:
                return                                   # the look back to the middle
            if self.last and now - self.last[0] < REFRACTORY_S:
                return
            self.n[d] += 1
            self.last = (now, d)
            self.armed = False

    # ---------- calibration: start, mark each phase (middle/left/right) as the dot moves, done
    def calibrate(self, step, phase=None):
        now = time.time()
        with self.lock:
            if step == "start":
                self.cal = []
                return {"ok": True}
            if step == "mark":
                if self.cal is None or phase not in ("middle", "left", "right"):
                    return {"error": "start first" if self.cal is None else f"unknown phase {phase}"}
                self.cal.append((now, phase))
                return {"ok": True}
            if step == "reset":
                self.amp, self.calibrated = None, None
                return {"ok": True}
            if step != "done":
                return {"error": f"unknown step {step}"}
            marks = (self.cal or []) + [(now, "end")]
            self.cal = None
            got = {"middle": [], "left": [], "right": []}
            for (t0, phase), (t1, _) in zip(marks, marks[1:]):
                # the eyes take ~0.2 s to get there; an AC-coupled input starts to sag after ~1 s
                seg = [d for t, d in self.hist if t0 + 0.2 <= t <= min(t1, t0 + 1.0)]
                if seg:
                    got[phase].append(np.median(seg) if phase != "middle" else seg)
            if not got["left"] or not got["right"] or not got["middle"]:
                return {"error": "not enough signal during the check (is the headset streaming?)"}
            # middle: all of it after the first 0.3 s (the first middle phase is longer, for the noise)
            mid = np.concatenate([[d for t, d in self.hist if t0 + 0.3 <= t <= t1]
                                  for (t0, phase), (t1, _) in zip(marks, marks[1:]) if phase == "middle"])
            centre = float(np.median(mid))
            noise = float(np.percentile(np.abs(mid - centre), 95)) + 1e-6     # the hum's bursts count here
            amp = {k: float(np.median(got[k]) - centre) for k in ("left", "right")}
            snr = min(abs(amp["left"]), abs(amp["right"])) / noise
            if np.sign(amp["left"]) == np.sign(amp["right"]):
                verdict, ok = "Left and right looked the same: check the two eye electrodes are at opposite eye corners.", False
            elif snr < 1.5:
                verdict, ok = "Couldn't see the glances over the noise. Look all the way to the edges, or check the eye electrodes' contact.", False
            elif snr < 2.2:
                verdict, ok = "Weak but usable: make big, quick glances to the edges.", True
            else:
                verdict, ok = "Clear glance signal.", True
            if ok:
                self.amp = amp
                self.armed = True
            self.calibrated = {"t": now, "ok": ok, "verdict": verdict, "snr": round(snr, 1),
                               "left_uv": round(amp["left"]), "right_uv": round(amp["right"]), "noise_uv": round(noise)}
            return dict(self.calibrated)

    def state(self, frm=0):
        with self.lock:
            n = len(self.trace)
            start = max(frm, self.total - n, 0)
            data = list(self.trace)[n - (self.total - start):] if self.total > start else []
            ready = time.time() - self.t_start > WARMUP_S and len(self.vals) > 10
            return {"available": True, "ready": ready, "n_left": self.n["left"], "n_right": self.n["right"],
                    "dev_uv": round(self.dev, 1), "amp": self.amp, "calibrated": self.calibrated, "calibrating": self.cal is not None,
                    "trace": {"start": start, "end": self.total, "fs": round(1 / BLOCK_S), "data": data}}
