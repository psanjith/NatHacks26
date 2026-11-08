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
Close the OpenBCI GUI first. Data: logs/users/<user>/ (git-ignored): one .npz per trial
(EEG epoch + labels), the raw stream as CSV, and model.npz.
"""
import argparse
import collections
import glob
import json
import os
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from scipy.signal import butter, sosfiltfilt

import ssvep_model as sm
import ssvep_export as sx
import ssvep_test as base

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "ssvep_train.html")
ROOT = os.path.dirname(HERE)
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

    def read(self):
        self.freq = None
        out = super().read()
        n = out.shape[1]
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


def public(t):
    return {k: v for k, v in t.items() if k not in ("x", "_fb")}


class Trainer(base.Bench):
    def __init__(self, src, ssvep_idx, user, stamp):
        self.user = user
        self.dir = os.path.join(ROOT, "logs", "users", user)
        self.session = stamp
        self.sdir = os.path.join(self.dir, stamp)
        os.makedirs(self.sdir, exist_ok=True)
        super().__init__(src, ssvep_idx, os.path.join(self.sdir, "eeg.csv"), os.path.join(self.sdir, "events.jsonl"))
        self.arr = collections.deque()       # (arrival time, samples so far) for time -> sample mapping
        self.model_path = os.path.join(self.dir, "model.npz")
        self.model = sm.Model.load(self.model_path) if os.path.exists(self.model_path) else None
        self.trials = self.load_trials()
        self.cur = None
        self.tlock = threading.Lock()

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

    def fb_of(self, t):
        if "_fb" not in t:
            t["_fb"] = sm.filter_bank(t["x"][self.ssvep_idx], t["fs"])
        return t["_fb"]

    def pull(self):
        super().pull()
        with self.lock:
            if self.last_rx and (not self.arr or self.arr[-1][1] != self.total):
                self.arr.append((self.last_rx, self.total))
                while self.arr[0][0] < self.last_rx - 20:
                    self.arr.popleft()

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
        self.log(ev="trial_end", **public(t))
        return public(t)

    def score(self, t):
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
               "model": self.model.meta if self.model else None}
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
        self.log(ev="train", scope=scope, freqs=freqs4, counts=counts, best=best, rows=rows)
        exp = self.export()
        return {"rows": rows, "best": best, "counts": counts, "model": model.meta, "path": self.model_path, "export": exp}

    def export(self):
        """Recordings by frequency + the sim replay file (see ssvep_export.py)."""
        try:
            return sx.export(self.dir, self.trials, self.ssvep_idx, self.model, self.fb_of)
        except Exception as e:
            print("export failed:", e)
            return {"error": str(e)}

    def snapshot(self):
        s = super().snapshot()
        s["user"] = self.user
        s["model"] = self.model.meta if self.model else None
        return s


def make_handler(tr):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                with open(PAGE, "rb") as fh:
                    body = fh.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
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
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    if not (args.fake or args.native or args.port):
        ap.error("give --native (Bluetooth), --port (dongle) or --fake")
    user = "".join(c for c in args.user.lower() if c.isalnum() or c in "-_") or "nav"
    ssvep_idx = [int(c) - 1 for c in args.ssvep_ch.split(",")]
    src = FakeTrainSource(args) if args.fake else base.GanglionSource(args)
    tr = Trainer(src, ssvep_idx, user, time.strftime("%Y%m%d_%H%M%S"))
    tr.log(ev="session", source=src.name, fs=src.fs, ssvep_ch=args.ssvep_ch, user=user)
    threading.Thread(target=tr.acquire_loop, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.http), make_handler(tr))
    server.daemon_threads = True
    url = f"http://127.0.0.1:{args.http}/"
    print(f"Streaming from {src.name} at {src.fs} Hz. Profile: {user}\nOpen {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
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
