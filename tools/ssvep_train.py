"""Reach SSVEP trainer: per-person tests and a decoder tailored to one wearer.

  Test 1 (one target)   One square flashes at a random frequency (6-15 Hz); the computer
                        guesses which. Shows which frequencies this person responds to best.
  Test 2 (four targets) Four squares flash at four frequencies; look at the cued one.
                        Same square size and positions as Test 1, so the difference between
                        the two is the cost of the other three flickering in your periphery.
  Train                 Fits a personal decoder (filter-bank TRCA on this person's own trials),
                        compares it with training-free FBCCA by cross-validation, picks the
                        best method + look time + a "not sure" cut-off, saves it.
  Rehearse              The demo loop with the trained model.

Usage:
  python tools/ssvep_train.py --native --user nav     # Ganglion over Mac Bluetooth
  python tools/ssvep_train.py --port /dev/cu.usbmodemX --user nav
  python tools/ssvep_train.py --fake --user test      # simulated EEG, no headset
  python tools/ssvep_train.py --native --user nav --montage face   # eye corners + jaw + T7 for the sim
Close the OpenBCI GUI first. Data: logs/users/<user>/ (git-ignored): one .npz per trial
(EEG epoch + labels), the raw stream as CSV, and model.npz.
"""
import argparse
import collections
import glob
import json
import os
import re
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from scipy.signal import butter, iirnotch, sosfilt, sosfiltfilt, tf2sos

import clench as cl
import eog
import ssvep_model as sm
import ssvep_export as sx
import ssvep_test as base

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "ssvep_train.html")
SIGNAL_PAGE = os.path.join(HERE, "ssvep_signal.html")   # iPad view: hum + impedance only
PLACE_PAGE = os.path.join(HERE, "ssvep_place.html")     # electrode finder: one channel at a time
ROOT = os.path.dirname(HERE)
SIM_PATHS = {"/api/live", "/api/clench", "/api/clench/calibrate", "/api/clench/fake", "/api/impedance",
             "/api/eog/calibrate", "/api/eog/fake"}  # the sim may call these
# --montage face: SSVEP dropped; electrodes moved to the face for the eyes + clench control
FACE_NAMES = ["EyeL", "EyeR", "Jaw", "T7"]   # ch1 left outer eye corner, ch2 right outer eye corner, ch3 jaw muscle, ch4 T7
PRE_S, POST_S = 1.0, 0.3       # epoch padding around the flicker (for clean filtering)
WINS = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0]


class FakeTrainSource(base.FakeSource):
    """Simulated EEG with a phase-locked SSVEP from flicker onset, plus weaker responses to
    the other flickering squares (so the peripheral effect shows up in Test 2)."""

    def __init__(self, args):
        super().__init__(args)
        self.stim = None

    def set_stim(self, target, others):
        self.stim = (target, list(others), int((time.time() - self.t0) * self.fs))  # phase 0 = now

    def fake_clench(self, s=0.7):
        """Simulated jaw clench: a burst of muscle noise, biggest on channels 3-4 (Jaw, T7)."""
        t = time.time() - self.t0
        self.burst = (t, t + float(s))

    def fake_glance(self, direction, s=0.8):
        """Simulated look to the left or right edge and back (face montage: ch1/ch2 at the eye corners)."""
        t = time.time() - self.t0
        self.glance = (t, t + float(s), 1 if direction == "left" else -1)

    def read(self):
        self.freq = None
        out = super().read()
        n = out.shape[1]
        ts = (np.arange(self.n - n, self.n)) / self.fs
        b = getattr(self, "burst", None)
        if n and b:
            on = (ts >= b[0]) & (ts < b[1])
            if on.any():
                emg = self.rng.normal(0, 25, (4, n)) * on
                emg[2:] *= 3                      # jaw muscle and T7
                out += emg
        g = getattr(self, "glance", None)
        if n and g:
            on = (ts >= g[0]) & (ts < g[1])
            out[0] += 150 * g[2] * on             # looking left raises the left eye corner...
            out[1] -= 150 * g[2] * on             # ...and lowers the right one
        if n and self.stim:
            f0, others, g0 = self.stim
            t = (np.arange(self.n - n, self.n) - g0) / self.fs - 0.12
            on = t > 0
            srcs = ([(f0, 1.0)] if f0 else []) + [(f, 0.3) for f in others]
            for f, gain in srcs:
                g = gain * self.amp * (1.3 if 8 <= f <= 12.5 else 0.8)
                for h, a in zip((1, 2, 3), (1.0, 0.5, 0.25)):
                    s = g * a * np.sin(2 * np.pi * h * f * t + 0.7 * h) * on
                    out[0] += 0.8 * s
                    out[1] += s
                    out[2] += 0.8 * s
        return out


class GanglionTrainSource(base.GanglionSource):
    """Ganglion plus its impedance mode ('z' on, 'Z' off). While it's on, the EEG rows are not
    EEG; the board reports electrode impedance in its resistance rows (channels 1-4, then REF)."""

    def __init__(self, args):
        super().__init__(args)
        from brainflow.board_shim import BoardShim
        bid = self.board.get_board_id()
        self.res_rows = BoardShim.get_board_descr(bid).get("resistance_channels", [])
        self.res = [None] * len(self.res_rows)

    def read(self):
        data = self.board.get_board_data()
        if not data.shape[1]:
            return np.zeros((4, 0))
        for k, r in enumerate(self.res_rows):
            v = data[r][data[r] > 0]
            if v.size:
                self.res[k] = float(v[-1])
        return data[self.chans]

    def set_impedance(self, on):
        self.res = [None] * len(self.res_rows)
        self.board.config_board("z" if on else "Z")

    def impedance_kohm(self):
        # BrainFlow passes the board's number through; it's ohms on current firmware. Values under
        # 2000 would be implausible as ohms on a scalp, so treat those as already in kOhm.
        return [None if v is None else round(v / 1000 if v > 2000 else v, 1) for v in self.res]


class FakeImpedance:
    """Impedance mode for --fake: plausible numbers that drift a little."""

    def set_impedance(self, on):
        self.imp_on = on

    def impedance_kohm(self):
        if not getattr(self, "imp_on", False):
            return [None] * 5
        base_k = [13, 24, 12, 600, 16.5]
        return [round(k * (1 + 0.05 * np.random.randn()), 1) for k in base_k]


class FakeTrainSourceImp(FakeImpedance, FakeTrainSource):
    pass


# ---------------------------------------------------------------- live waves for the sim's camera tab
class LiveWave:
    """The last few seconds of every channel, filtered for display like the OpenBCI GUI's time series
    (4-45 Hz), plus the hum band (53-67 Hz: our hum is smeared over 58.5-61.5 Hz) and its aliased
    harmonics notched out, so a jaw clench shows up as a burst instead of being buried in hum."""
    KEEP_S = 8

    def __init__(self, fs, n_ch):
        self.fs, self.n_ch = fs, n_ch
        sos = [butter(4, [4, min(45, 0.45 * fs)], "bandpass", fs=fs, output="sos")]
        if fs > 140:
            sos.append(butter(2, [53, 67], "bandstop", fs=fs, output="sos"))
        sos += [tf2sos(*iirnotch(f, 8, fs)) for f in cl.mains_lines(fs, 10, 45)]
        self.sos = np.vstack(sos)
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        with self.lock:
            self.zi = np.zeros((self.sos.shape[0], self.n_ch, 2))
            self.buf = np.zeros((self.n_ch, 0))
            self.total = 0          # samples ever fed (index of the next one)
            self.skip = self.fs     # first second: the filters are still ringing from the start

    def feed(self, x):
        with self.lock:
            y, self.zi = sosfilt(self.sos, x, axis=-1, zi=self.zi)
            if self.skip:
                k = min(self.skip, y.shape[1])
                y[:, :k] = 0
                self.skip -= k
            self.buf = np.hstack([self.buf, y])[:, -self.KEEP_S * self.fs:]
            self.total += x.shape[1]

    def since(self, frm):
        """Samples from absolute index frm on (at most the last KEEP_S seconds)."""
        with self.lock:
            n = self.buf.shape[1]
            start = max(frm, self.total - n, 0)
            d = self.buf[:, n - (self.total - start):] if self.total > start else np.zeros((self.n_ch, 0))
            return {"start": start, "end": self.total, "data": np.round(d, 1).tolist()}


# ---------------------------------------------------------------- hum diagnosis
HUM_GOOD, HUM_BAD = 30.0, 100.0   # uV amplitude at 60 Hz, unfiltered

FIX_SHARED = [
    ("Forehead ground (D_G)", "Flat against bare skin, no hair under it: wipe the forehead (oil/sweat), add a drop of "
                              "saline or paste, tighten the strap or headset so it presses in. Check its wire is fully in "
                              "the Ganglion's D_G pin. The impedance check does NOT measure the ground, so a ground that "
                              "barely touches looks fine there but puts the same hum on every channel."),
    ("Reference (REF)", "Firm contact on clean skin, and its wire fully in the REF pin."),
    ("Cables from the laptop", "Unplug everything from the laptop, not just the charger: HDMI/monitor, USB hubs, "
                               "speakers. A monitor cable connects the laptop to mains even on battery."),
    ("Distance from power", "Move Nav and the Ganglion 1-2 m from power strips, monitors, lamps and wall sockets. "
                            "Check under the table for extension cords."),
    ("Wires", "Bundle the electrode wires together and keep them short and still; don't let them hang in loops."),
    ("Don't touch", "Nobody (Nav included) touching the laptop, the table's metal, or a plugged-in device during a test."),
]
FIX_ONE = [
    ("That electrode", "Press it in, part the hair under it, add a little paste or saline."),
    ("Its wire", "Check the pin is fully pushed into the Ganglion and the wire isn't broken: swap it with a good channel's wire to test."),
]


def hum_report(x, fs, names):
    """x: (ch, n) raw SSVEP channels, last few seconds. Per-channel 60 Hz hum and where it comes from."""
    chans = []
    for i, name in enumerate(names):
        _, hum, _, _, _ = base.analyse(x[i], fs)
        lvl = "good" if hum < HUM_GOOD else "warn" if hum < HUM_BAD else "bad"
        chans.append({"name": name, "uv": round(float(hum), 1), "level": lvl})
    vals = np.array([c["uv"] for c in chans])
    h = sosfiltfilt(butter(4, [57, 63], "bandpass", fs=fs, output="sos"), x - x.mean(1, keepdims=True), axis=1)
    s = np.linalg.svd(h, compute_uv=False)
    shared = float(s[0] ** 2 / max((s ** 2).sum(), 1e-12))
    corr = np.corrcoef(h) if len(names) > 1 else np.ones((1, 1))
    min_corr = float(np.min(np.abs(corr[np.triu_indices(len(names), 1)]))) if len(names) > 1 else 1.0
    worst = int(np.argmax(vals))
    others = np.delete(vals, worst)
    if vals.max() < HUM_GOOD:
        src, verdict, fixes = "low", "Hum is low on every channel.", []
    elif len(others) and vals[worst] > 2.5 * max(np.median(others), 1) and np.median(others) < HUM_BAD:
        src = "one"
        verdict = f"Mostly on {names[worst]}: that one electrode or its wire."
        fixes = FIX_ONE + FIX_SHARED[:1]
    elif shared > 0.8 and min_corr > 0.7:
        src = "shared"
        verdict = ("The same hum is on every channel, in step. It's coming in through the path they share "
                   "(the forehead ground and the reference, or Nav picking up mains from nearby power), not through the scalp electrodes.")
        fixes = FIX_SHARED
    else:
        src = "mixed"
        verdict = f"Hum on several channels, worst on {names[worst]}. Check the forehead ground and reference first, then {names[worst]}."
        fixes = FIX_SHARED[:2] + FIX_ONE[:1] + FIX_SHARED[2:]
    return {"chans": chans, "shared": round(shared, 2), "min_corr": round(min_corr, 2), "source": src,
            "worst": names[worst], "verdict": verdict,
            "fixes": [{"title": a, "body": b} for a, b in fixes],
            "level": "good" if vals.max() < HUM_GOOD else "warn" if vals.max() < HUM_BAD else "bad"}


def public(t):
    return {k: v for k, v in t.items() if k not in ("x", "_fb")}


class Trainer(base.Bench):
    def __init__(self, src, ssvep_idx, user, stamp, decoder="ours", montage="ssvep"):
        self.user = user
        self.montage = montage
        self.tb = None
        if decoder not in ("ours", "rl"):
            import ssvep_toolbox
            self.tb = ssvep_toolbox.ToolboxDecoder(decoder, src.fs)
        self.dir = os.path.join(ROOT, "logs", "users", user)
        self.session = stamp
        self.sdir = os.path.join(self.dir, stamp)
        os.makedirs(self.sdir, exist_ok=True)
        super().__init__(src, ssvep_idx, os.path.join(self.sdir, "eeg.csv"), os.path.join(self.sdir, "events.jsonl"))
        self.arr = collections.deque()       # (arrival time, samples so far) for time -> sample mapping
        self.model_path = os.path.join(self.dir, "model.npz")
        self.model = sm.Model.load(self.model_path) if os.path.exists(self.model_path) else None
        self.trials = self.load_trials()
        self.rl = None
        if decoder == "rl":
            import ssvep_rl
            self.rl = ssvep_rl.Controller(os.path.join(self.dir, f"rl_agent_{len(ssvep_idx)}ch.npz"), len(ssvep_idx))
            if self.rl.is_new:
                self.rl_warm_start()
        self.cur = None
        self.tlock = threading.Lock()
        face = montage == "face"
        # face montage: the jaw electrode and T7 must agree; otherwise T7 alone (calibration may add others)
        self.clench = cl.ClenchDetector(self.fs, base.NAMES, clench=["Jaw", "T7"] if face else None, agree=face)
        self.glance = eog.GlanceDetector(self.fs, 0, 1) if face else None   # eye corners on ch1/ch2
        self.wave = LiveWave(self.fs, len(base.NAMES))           # what the sim's camera tab draws
        self._clench_paused = False

    # ---------- data
    def load_trials(self):
        out = []
        for p in sorted(glob.glob(os.path.join(self.dir, "*", "trial_*.npz"))):
            try:
                d = np.load(p)
                t = json.loads(str(d["meta"]))
                t["x"] = d["x"].astype(float)
                out.append(t)
            except Exception as e:
                print(f"skipping {p}: {e}")
        if out:
            print(f"Loaded {len(out)} earlier trials for '{self.user}'.")
        return out

    def rl_features(self, t):
        import ssvep_rl
        return ssvep_rl.features(t["x"][self.ssvep_idx], t["fs"], t["onset"], t["n_on"], t["cands"])

    def rl_warm_start(self):
        """New agent: let it learn from the most recent earlier session (bandit feedback only)."""
        prev = [t for t in self.trials if t["test"] in ("single", "four") and t.get("target_freq")]
        if not prev:
            self.rl.save()
            return
        last = max(t["session"] for t in prev)
        n = 0
        for t in sorted((t for t in prev if t["session"] == last), key=lambda t: t["t"]):
            Phi = self.rl_features(t)
            k = sm.match(t["target_freq"], t["cands"])
            if Phi is not None and k is not None:
                self.rl.step(Phi, k, save=False)
                n += 1
        self.rl.save()
        print(f"RL agent warm-started on {n} trials from session {last}.")

    def score_rl(self, t):
        fs, cands = t["fs"], t["cands"]
        tgt = sm.match(t["target_freq"], cands) if t["target_freq"] is not None else None
        raw = t["x"][self.ssvep_idx, t["onset"] + int(sm.LAT * fs): t["onset"] + t["n_on"]]
        filt = sosfiltfilt(butter(4, [1, 45], "bandpass", fs=fs, output="sos"), base.notch(raw, fs), axis=-1)
        out = {"ptp_uv": round(float(np.ptp(filt, axis=1).max()), 1)}
        if t["target_freq"] is not None:
            f, a = base.spectrum(raw, fs)
            out["snr"] = round(base.snr_at(f, a, t["target_freq"]), 2)
        Phi = self.rl_features(t)
        if Phi is None:
            out.update(fb_pred=None, fb_correct=None, decoder="(flicker too short to score)")
            return out
        r = self.rl.step(Phi, tgt)
        k = r["pick"]
        name = "RL agent" if r["decider"] == "agent" else "FFT peak"
        out.update(fb_pred=cands[k], fb_correct=None if tgt is None else k == tgt, decoder=name,
                   rule_pred=cands[r["rule"]], agent_pred=cands[r["agent"]], agent_conf=r["agent_conf"],
                   rule_correct=None if tgt is None else r["rule"] == tgt,
                   agent_correct=None if tgt is None else r["agent"] == tgt,
                   model={"pred": cands[k], "margin": r["gap"], "accepted": True,
                          "correct": None if tgt is None else k == tgt, "by": name})
        return out

    def fb_of(self, t):
        if "_fb" not in t:
            t["_fb"] = sm.filter_bank(t["x"][self.ssvep_idx], t["fs"])
        return t["_fb"]

    def pull(self):
        before = self.total
        super().pull()
        with self.lock:
            n = self.total - before
            new = self.ring[:, -n:].copy() if 0 < n <= self.ring.shape[1] else None
            if self.last_rx and (not self.arr or self.arr[-1][1] != self.total):
                self.arr.append((self.last_rx, self.total))
                while self.arr[0][0] < self.last_rx - 20:
                    self.arr.popleft()
        # jaw clench (eye-tracker backup): not while impedance mode is on, the rows aren't EEG then
        paused = getattr(self, "imp_on", False) or time.time() - getattr(self, "imp_changed", 0) < 5
        if paused:
            self._clench_paused = True
        elif new is not None:
            if self._clench_paused:
                self.clench.reset()
                self.wave.reset()
                if self.glance:
                    self.glance.reset()
                self._clench_paused = False
            self.clench.feed(new)
            self.wave.feed(new)
            if self.glance:
                self.glance.feed(new)

    def idx_at(self, t):
        """Sample index at wall-clock time t. Uses the lower envelope of arrival time - n/fs over the
        last 20 s, which removes Bluetooth batching jitter (constant latency is absorbed by LAT/templates)."""
        with self.lock:
            c = min(tt - n / self.fs for tt, n in self.arr)
        return int(round((t - c) * self.fs))

    def packet_rate(self, t0, t1):
        with self.lock:
            pts = [(tt, n) for tt, n in self.arr if t0 <= tt <= t1 + 0.3]
        if len(pts) < 2 or pts[-1][0] - pts[0][0] < 0.8:
            return None
        return round((pts[-1][1] - pts[0][1]) / ((pts[-1][0] - pts[0][0]) * self.fs), 2)

    # ---------- trials
    def trial_start(self, b):
        if getattr(self, "imp_on", False):
            return {"error": "Impedance check is running: stop it first (EEG is paused while it measures)."}
        self.pull()
        with self.tlock:
            self.trial_id += 1
            self.cur = {"id": self.trial_id, "session": self.session, "test": b["test"],
                        "target_freq": b.get("target_freq"), "shown": b["shown"], "cands": b["cands"],
                        "spacing": b.get("spacing"), "pos": b.get("pos"), "look_s": b.get("look_s"),
                        "refresh_hz": b.get("refresh_hz"), "t": time.time()}
            cur = dict(self.cur)
        if hasattr(self.src, "set_stim"):
            f = cur["target_freq"] if cur["target_freq"] is not None else b.get("fake_freq")
            self.src.set_stim(f, [g for g in cur["shown"] if f is None or abs(g - f) > 0.01])
        self.log(ev="trial_start", **cur)
        return {"id": cur["id"]}

    def trial_end(self, b):
        with self.tlock:
            tr, self.cur = self.cur, None
        if hasattr(self.src, "set_stim"):
            self.src.set_stim(None, [])
        if tr is None:
            return {"error": "no trial running"}
        if b.get("aborted"):
            self.log(ev="trial_aborted", id=tr["id"])
            return {"aborted": True}
        fs = self.fs
        on_t, off_t = float(b["onset"]), float(b["offset"])
        if not self.arr:
            return {"error": "no EEG data has arrived: is the headset streaming?"}
        i_on, i_off = self.idx_at(on_t), self.idx_at(off_t)
        need = i_off + int(POST_S * fs)
        deadline = time.time() + 1.5
        while self.total < need and time.time() < deadline:
            time.sleep(0.03)
            self.pull()
        with self.lock:
            L = self.ring.shape[1]
            a = max(i_on - int(PRE_S * fs), self.total - L, 0)
            x = self.window(a, min(need, self.total))
        onset, n_on = i_on - a, i_off - i_on
        if x.shape[1] < onset + n_on or n_on < fs:
            res = {"id": tr["id"], "error": "the EEG for this trial didn't arrive (Bluetooth dropout?). Trial skipped."}
            self.log(ev="trial_end", **res)
            return res
        t = dict(tr, x=x, fs=fs, onset=int(onset), n_on=int(n_on), drops=int(b.get("drops", 0)),
                 packet_rate=self.packet_rate(on_t, off_t), ssvep_idx=self.ssvep_idx)
        t.update(self.score(t))
        np.savez_compressed(os.path.join(self.sdir, f"trial_{tr['id']:03d}.npz"),
                            x=x.astype(np.float32), meta=np.array(json.dumps(public(t))))
        self.trials.append(t)
        self.last_activity = time.time()
        self.last_trial = {k: t.get(k) for k in ("id", "test", "target_freq", "fb_pred", "fb_correct", "spacing")}
        if t.get("model"):
            self.last_trial["model"] = t["model"]
        self.log(ev="trial_end", **public(t))
        return public(t)

    def score(self, t):
        if self.rl is not None:
            return self.score_rl(t)
        fs, fb = t["fs"], self.fb_of(t)
        cands = t["cands"]
        win = t["n_on"] / fs - sm.LAT
        seg = sm.cut(fb, t["onset"], fs, sm.LAT, win, t["n_on"])
        s = sm.fbcca_scores(seg, fs, cands)
        i = int(np.argmax(s))
        tgt = sm.match(t["target_freq"], cands)
        out = {"fb_pred": cands[i], "fb_margin": round(sm.margin(s), 3),
               "fb_correct": None if tgt is None else i == tgt}
        raw = t["x"][self.ssvep_idx, t["onset"] + int(sm.LAT * fs): t["onset"] + t["n_on"]]
        filt = sosfiltfilt(butter(4, [1, 45], "bandpass", fs=fs, output="sos"), base.notch(raw, fs), axis=-1)
        ptp = float(np.ptp(filt, axis=1).max())
        out.update(ptp_uv=round(ptp, 1), artifact=ptp > 200)
        if t["target_freq"] is not None:
            f, a = base.spectrum(raw, fs)
            out["snr"] = round(base.snr_at(f, a, t["target_freq"]), 2)
        if self.tb is not None:   # guess with the toolbox model; keep ours for comparison
            r = self.tb.predict(t, cands, [x for x in self.trials if x is not t], self.fb_of)
            if "pred" in r:
                out.update(ours_pred=out["fb_pred"], ours_correct=out["fb_correct"], decoder=self.tb.name,
                           tb_n_train=r["n_train"], fb_pred=r["pred"],
                           fb_correct=None if tgt is None else r["index"] == tgt)
            else:
                out.update(decoder="ours (toolbox: " + r["error"] + ")")
        if self.model and self.model.matches(cands):
            d = self.model.decide(fb, t["onset"], t["n_on"])
            if d:
                k, mg, acc, _ = d
                out["model"] = {"pred": cands[k], "margin": round(mg, 3), "accepted": bool(acc),
                                "correct": None if tgt is None else k == tgt}
        return out

    # ---------- summaries
    def pool(self, scope):
        return [t for t in self.trials if scope == "all" or t["session"] == self.session]

    def summary(self, scope, freqs4):
        T = self.pool(scope)
        t1 = [t for t in T if t["test"] == "single"]
        t2 = [t for t in T if t["test"] == "four"]
        out = {"scope": scope, "n": len(T), "sessions": len({t["session"] for t in T}),
               "model": None if self.rl else (self.model.meta if self.model else None)}
        # Test 1: which frequencies does this person respond to?
        per = {}
        for t in t1:
            p = per.setdefault(round(t["target_freq"], 2), {"freq": round(t["target_freq"], 3), "n": 0, "hits": 0, "snrs": []})
            p["n"] += 1
            p["hits"] += bool(t["fb_correct"])
            p["snrs"].append(t.get("snr") or 0)
        perl = []
        for p in sorted(per.values(), key=lambda p: p["freq"]):
            perl.append({"freq": p["freq"], "n": p["n"], "hits": p["hits"], "snr": round(float(np.median(p["snrs"])), 2)})
        n1 = len(t1)
        out["t1"] = {"n": n1, "acc": round(sum(bool(t["fb_correct"]) for t in t1) / n1, 3) if n1 else None,
                     "chance": round(float(np.mean([1 / len(t["cands"]) for t in t1])), 3) if n1 else None,
                     "per": perl, "recommend": sm.recommend(perl)}
        # Test 2 by spacing, on the current 4 frequencies
        same = lambda t: len(t["shown"]) == 4 and all(sm.match(f, freqs4) == i for i, f in enumerate(t["shown"]))
        groups = {}
        for t in t2:
            if same(t):
                groups.setdefault(t["spacing"] or "normal", []).append(t)
        g2 = {}
        for sp, ts in groups.items():
            n = len(ts)
            P = sum(bool(t["fb_correct"]) for t in ts) / n
            M = [[0] * 4 for _ in range(4)]
            for t in ts:
                M[sm.match(t["target_freq"], freqs4)][sm.match(t["fb_pred"], freqs4)] += 1
            look = float(np.median([t["n_on"] / t["fs"] for t in ts]))
            mod = [t["model"] for t in ts if t.get("model") and t["model"]["correct"] is not None]
            g2[sp] = {"n": n, "acc": round(P, 3), "itr": round(sm.itr(P, 4, look + sm.GAZE_S), 1), "confusion": M,
                      "look_s": round(look, 1), "model_acc": round(sum(m["correct"] for m in mod) / len(mod), 3) if mod else None,
                      "model_n": len(mod)}
        out["t2"] = g2
        out["compare"] = self.compare(t1, [t for t in t2 if same(t)], freqs4)
        out["recent"] = [public(t) for t in T[-40:]]
        return out

    def compare(self, t1, t2, freqs4):
        """Same 4 frequencies, same window, same decoder: alone (Test 1) vs with 3 flickering neighbours (Test 2)."""
        a = [t for t in t1 if sm.match(t["target_freq"], freqs4) is not None]
        if not a or not t2:
            return {"alone_n": len(a), "four_n": len(t2)}
        win = min(4.0, min(t["n_on"] / t["fs"] for t in a + t2) - sm.LAT)
        win = float(np.floor(win * 2) / 2)
        res = {}
        for name, ts in (("alone", a), ("four", t2)):
            by_sp = {}
            for t in ts:
                seg = sm.cut(self.fb_of(t), t["onset"], t["fs"], sm.LAT, win, t["n_on"])
                ok = int(np.argmax(sm.fbcca_scores(seg, t["fs"], freqs4))) == sm.match(t["target_freq"], freqs4)
                key = "all" if name == "alone" else (t["spacing"] or "normal")
                by_sp.setdefault(key, []).append(ok)
            res[name] = {k: {"acc": round(float(np.mean(v)), 3), "n": len(v)} for k, v in by_sp.items()}
        res.update(win=win, alone_n=len(a), four_n=len(t2))
        return res

    # ---------- training
    def train(self, scope, freqs4):
        if self.rl is not None:
            return {"error": "RL mode: there's no separate training. The agent learns from every cued trial in Tests 1 and 2 and rehearsal."}
        items = []
        for t in self.pool(scope):
            if t["test"] not in ("single", "four"):
                continue
            k = sm.match(t["target_freq"], freqs4)
            if k is None:
                continue
            items.append({"fb": self.fb_of(t), "onset": t["onset"], "n_on": t["n_on"], "label": k, "test": t["test"]})
        counts = np.bincount([it["label"] for it in items], minlength=4).tolist() if items else [0] * 4
        rows, err = sm.cross_validate(items, freqs4, self.fs, WINS)
        if err or not rows:
            return {"error": err or "not enough trials long enough for the shortest window", "counts": counts}
        best = sm.pick(rows)
        model = sm.Model.fit(items, freqs4, self.fs, best, [i + 1 for i in self.ssvep_idx], self.user)
        model.save(self.model_path)
        model.save(os.path.join(self.sdir, "model.npz"))
        self.model = model
        self.trained_at = time.time()
        self.log(ev="train", scope=scope, freqs=freqs4, counts=counts, best=best, rows=rows)
        exp = self.export()
        return {"rows": rows, "best": best, "counts": counts, "model": model.meta, "path": self.model_path, "export": exp}

    def export(self):
        """Recordings by frequency + the sim replay file (see ssvep_export.py)."""
        try:
            return sx.export(self.dir, self.trials, self.ssvep_idx, None if self.rl else self.model, self.fb_of)
        except Exception as e:
            print("export failed:", e)
            return {"error": str(e)}

    # ---------- impedance mode (EEG pauses while it runs)
    def set_impedance(self, on):
        if not hasattr(self.src, "set_impedance"):
            return {"error": "this source can't measure impedance"}
        if on and (self.cur or time.time() - getattr(self, "last_activity", 0) < 8):
            return {"error": "A test is running. Impedance mode would pause the EEG mid-test: wait for it to finish or press Stop."}
        try:
            self.src.set_impedance(on)
        except Exception as e:
            return {"error": f"the Ganglion refused impedance mode: {e}"}
        self.imp_on = on
        self.imp_changed = time.time()
        self.log(ev="impedance_on" if on else "impedance_off")
        return {"ok": True, "on": on}

    def imp_state(self, idx=None):
        """Impedance per electrode in kOhm (None until measured), for channels idx (default all) + REF."""
        idx = list(range(len(base.NAMES))) if idx is None else idx
        on = getattr(self, "imp_on", False)
        kohm = self.src.impedance_kohm() if hasattr(self.src, "impedance_kohm") else None
        return {"available": hasattr(self.src, "set_impedance"), "on": on,
                "settling": (not on) and time.time() - getattr(self, "imp_changed", 0) < 5,
                "chans": ([{"name": base.NAMES[i], "kohm": kohm[i]} for i in idx]
                          + [{"name": "REF", "kohm": kohm[4] if len(kohm) > 4 else None}]) if kohm else []}

    def live(self, frm, efrom=0):
        """Everything the sim pages poll: new display samples, clench + glance state, impedance, connection."""
        return {"source": self.src.name, "fs": self.fs, "names": base.NAMES, "montage": self.montage,
                "stale_s": round(time.time() - self.last_rx, 1) if self.last_rx else None,
                "wave": self.wave.since(frm), "clench": self.clench.state(), "imp": self.imp_state(),
                "eog": self.glance.state(efrom) if self.glance else {"available": False},
                "testing": bool(self.cur) or time.time() - getattr(self, "last_activity", 0) < 8}

    # ---------- electrode finder: score one channel during eyes-open / eyes-closed / flicker segments
    def place_segment(self, b):
        if getattr(self, "imp_on", False):
            return {"error": "Impedance check is running: stop it first."}
        if not self.arr:
            return {"error": "no EEG arriving"}
        fs, ch = self.fs, int(b["ch"])
        i_on, i_off = self.idx_at(float(b["onset"])), self.idx_at(float(b["offset"]))
        deadline = time.time() + 1.5
        while self.total < i_off and time.time() < deadline:
            time.sleep(0.03)
            self.pull()
        with self.lock:
            x = self.window(i_on + int(0.5 * fs), min(i_off, self.total))[ch]   # skip the first 0.5 s (eyes settling)
        if x.size < 3 * fs:
            return {"error": "segment too short or EEG dropped out"}
        from scipy.signal import welch
        _, hum, _, _, _ = base.analyse(x, fs)
        y = base.notch(x[None] - x.mean(), fs)[0]
        f, P = welch(y, fs, nperseg=min(len(y), 4 * fs))          # 0.25 Hz bins
        band = lambda lo, hi: float(P[(f >= lo) & (f <= hi)].mean())
        out = {"kind": b.get("kind"), "ch": ch, "n_s": round(x.size / fs, 1), "hum_uv": round(float(hum), 1),
               "alpha": band(8, 12), "broad": band(3, 30)}
        fr = b.get("freq")
        if fr:
            def peak(g):
                k = np.abs(f - g) <= 0.25
                nb = (np.abs(f - g) >= 0.75) & (np.abs(f - g) <= 2.0)
                return float(P[k].max()), float(P[nb].mean())
            p1, n1 = peak(fr)
            p2, n2 = peak(2 * fr)
            out.update(freq=fr, p_f=p1, p_2f=p2, snr_f=round(p1 / n1, 2), snr_2f=round(p2 / n2, 2))
        self.log(ev="place", label=b.get("label"), **out)
        return out

    def session_counts(self):
        """Trials this session by test (and spacing for Test 2), for the iPad checklist."""
        c = {"single": 0, "four_close": 0, "four_normal": 0, "four_far": 0, "rehearse": 0}
        for t in self.trials:
            if t["session"] != self.session:
                continue
            k = f"four_{t.get('spacing') or 'normal'}" if t["test"] == "four" else t["test"]
            c[k] = c.get(k, 0) + 1
        return c

    def snapshot(self):
        imp_on = getattr(self, "imp_on", False)
        settling = (not imp_on) and time.time() - getattr(self, "imp_changed", 0) < 5
        s = super().snapshot()
        s["user"] = self.user
        s["model"] = self.model.meta if self.model else None
        s["decoder"] = self.tb.name if self.tb else "FBCCA"
        if self.rl is not None:
            st = self.rl.stats()
            s["rl"] = st
            s["decoder"] = "RL agent" if st["leader"] == "agent" else "FFT peak"
            s["model"] = None
        sess = [t for t in self.trials if t["session"] == self.session and t["test"] in ("single", "four")]
        s["activity"] = {"testing": bool(self.cur) or time.time() - getattr(self, "last_activity", 0) < 8,
                         "last": getattr(self, "last_trial", None), "n": len(sess),
                         "right": sum(bool(t.get("fb_correct")) for t in sess),
                         "session": self.session, "trained": bool(getattr(self, "trained_at", None)),
                         "counts": self.session_counts(),
                         "refresh_hz": getattr(self, "refresh_hz", None)}
        names = [base.NAMES[i] for i in self.ssvep_idx]
        s["clench"] = self.clench.state()
        s["imp"] = self.imp_state(self.ssvep_idx)
        if imp_on or settling:
            s["paused"] = True     # EEG rows aren't EEG right now
            s.pop("quality", None)
            return s
        if "quality" in s:
            with self.lock:
                have = min(self.total, self.ring.shape[1])
                recent = self.ring[self.ssvep_idx, -min(have, 4 * self.fs):].copy()
            try:
                s["hum"] = hum_report(recent, self.fs, names)
            except Exception as e:
                s["hum"] = {"error": str(e)}
        return s


def make_handler(tr):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _cors(self):
            # The sim (sim/run.py, another localhost port) reads clench events. Only localhost pages may.
            origin = self.headers.get("Origin") or ""
            if self.path.split("?")[0] in SIM_PATHS and re.match(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$", origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path in ("/", "/index.html", "/signal", "/place"):
                with open({"/signal": SIGNAL_PAGE, "/place": PLACE_PAGE}.get(self.path, PAGE), "rb") as fh:
                    body = fh.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path.split("?")[0] == "/api/clench":
                self._json(tr.clench.state())
            elif self.path.split("?")[0] == "/api/live":
                q = dict(kv.split("=", 1) for kv in (self.path.split("?", 1)[1].split("&") if "?" in self.path else []) if "=" in kv)
                self._json(tr.live(int(q.get("from", 0) or 0), int(q.get("efrom", 0) or 0)))
            elif self.path == "/stream":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    while tr.running:
                        self.wfile.write(f"data: {json.dumps(tr.snapshot())}\n\n".encode())
                        self.wfile.flush()
                        time.sleep(0.25)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                self.send_error(404)

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            b = json.loads(self.rfile.read(n) or b"{}")
            try:
                if self.path == "/api/shown":
                    tr.freqs = [float(f) for f in b["freqs"]]
                    if b.get("refresh_hz"):
                        tr.refresh_hz = b["refresh_hz"]
                        tr.log(ev="screen", refresh_hz=b["refresh_hz"], freqs=tr.freqs)
                    self._json({"ok": True})
                elif self.path == "/api/trial/start":
                    self._json(tr.trial_start(b))
                elif self.path == "/api/trial/end":
                    self._json(tr.trial_end(b))
                elif self.path == "/api/summary":
                    self._json(tr.summary(b.get("scope", "all"), [float(f) for f in b["freqs4"]]))
                elif self.path == "/api/train":
                    self._json(tr.train(b.get("scope", "all"), [float(f) for f in b["freqs4"]]))
                elif self.path == "/api/impedance":
                    self._json(tr.set_impedance(bool(b.get("on"))))
                elif self.path == "/api/place/segment":
                    self._json(tr.place_segment(b))
                elif self.path == "/api/rl/reset":
                    if tr.rl is None:
                        self._json({"error": "not in RL mode"})
                    else:
                        tr.rl.reset()
                        tr.log(ev="rl_reset")
                        self._json({"ok": True})
                elif self.path == "/api/clench/calibrate":
                    r = tr.clench.calibrate(str(b.get("step")), b.get("factor"))
                    if b.get("step") == "done":
                        tr.log(ev="clench_calibration", **r)
                    self._json(r)
                elif self.path == "/api/eog/calibrate":
                    if tr.glance is None:
                        self._json({"error": "no eye electrodes: start with --montage face"})
                    else:
                        r = tr.glance.calibrate(str(b.get("step")), b.get("phase"))
                        if b.get("step") == "done":
                            tr.log(ev="glance_calibration", **r)
                        self._json(r)
                elif self.path == "/api/eog/fake":
                    if not hasattr(tr.src, "fake_glance"):
                        self._json({"error": "only with --fake"})
                    else:
                        tr.src.fake_glance(b.get("dir", "left"), b.get("s", 0.8))
                        self._json({"ok": True})
                elif self.path == "/api/clench/fake":
                    if not hasattr(tr.src, "fake_clench"):
                        self._json({"error": "only with --fake"})
                    else:
                        tr.src.fake_clench(b.get("s", 0.7))
                        self._json({"ok": True})
                elif self.path == "/api/note":
                    tr.log(ev=str(b.pop("ev", "note")), **b)
                    self._json({"ok": True})
                else:
                    self.send_error(404)
            except Exception as e:  # keep the page alive and show the error there
                import traceback
                traceback.print_exc()
                self._json({"error": f"{type(e).__name__}: {e}"})
    return H


def lan_ip():
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))   # no packet is sent; just picks the Wi-Fi interface
        return s.getsockname()[0]
    except Exception:
        return "<this Mac's IP>"
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--user", default="nav", help="whose profile (default nav)")
    ap.add_argument("--port", help="dongle serial port")
    ap.add_argument("--native", action="store_true", help="Ganglion over Mac Bluetooth")
    ap.add_argument("--fake", action="store_true", help="simulated EEG")
    ap.add_argument("--fake-amp", type=float, default=1.0, help="simulated SSVEP size in uV (default 1.0)")
    ap.add_argument("--fw", choices=["2", "3"])
    ap.add_argument("--tries", type=int, default=6)
    ap.add_argument("--ssvep-ch", default="1,2,3", help="SSVEP channels (default 1,2,3 = O1,Oz,O2)")
    ap.add_argument("--http", type=int, default=8766)
    ap.add_argument("--decoder", default="rl", choices=["rl", "ours", "ecca", "etrca", "msetrca", "tdca", "fbcca"],
                    help="rl (default): FFT-peak rule decides, RL agent learns alongside and takes over once it beats it; "
                         "ours = old FBCCA/TRCA; the rest are SSVEP-Analysis-Toolbox models (need the py3.9 venv)")
    ap.add_argument("--montage", choices=["ssvep", "face"], default="ssvep",
                    help="ssvep (default): O1 Oz O2 T7. face: ch1 left eye corner, ch2 right eye corner, ch3 jaw muscle, "
                         "ch4 T7 (glances + jaw clench for the sim's eyes + clench control)")
    ap.add_argument("--lan", action="store_true", help="also serve on the Wi-Fi so an iPad can open /signal")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    if not (args.fake or args.native or args.port):
        ap.error("give --native (Bluetooth), --port (dongle) or --fake")
    user = "".join(c for c in args.user.lower() if c.isalnum() or c in "-_") or "nav"
    ssvep_idx = [int(c) - 1 for c in args.ssvep_ch.split(",")]
    if args.montage == "face":
        base.NAMES[:] = FACE_NAMES     # in place: every page, CSV header and detector reads this list
    src = FakeTrainSourceImp(args) if args.fake else GanglionTrainSource(args)
    tr = Trainer(src, ssvep_idx, user, time.strftime("%Y%m%d_%H%M%S"), args.decoder, args.montage)
    tr.log(ev="session", source=src.name, fs=src.fs, ssvep_ch=args.ssvep_ch, user=user, montage=args.montage, channels=list(base.NAMES))
    threading.Thread(target=tr.acquire_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0" if args.lan else "127.0.0.1", args.http), make_handler(tr))
    server.daemon_threads = True
    url = f"http://127.0.0.1:{args.http}/"
    print(f"Streaming from {src.name} at {src.fs} Hz. Profile: {user}\nOpen {url}  (Ctrl+C to stop)")
    if tr.rl is not None:
        st = tr.rl.stats()
        print(f"Decoder: FFT-peak rule + RL agent ({st['updates']} updates so far; in control: {st['leader']})")
    else:
        print(f"Test guesses by: {tr.tb.name if tr.tb else 'our FBCCA'}")
    if args.lan:
        print(f"iPad (same Wi-Fi): http://{lan_ip()}:{args.http}/signal")
    else:
        print(f"Signal page: {url}signal  (add --lan to open it on an iPad)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if getattr(tr, "imp_on", False):
            tr.set_impedance(False)
        tr.running = False
        server.server_close()
        src.close()
        tr.csv.close()
        tr.events.close()
        exp = tr.export()
        print(f"\nSaved to {tr.sdir}")
        if exp.get("trials"):
            print(f"Exported {exp['trials']} trials by frequency to {exp['dir']}"
                  + (f"; sim replay: {exp['replay']['n']} trials" if exp.get("replay") else " (no model yet, so no sim replay)"))


if __name__ == "__main__":
    main()
