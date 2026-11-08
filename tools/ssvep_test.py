"""SSVEP test bench: flashing targets + live EEG signal check + "does the computer agree?".

Opens a page in your browser with 4 flickering tiles. While you look at one, this script
reads the Ganglion, shows whether each electrode has good contact, plots the signal and
spectrum, and says which tile it thinks you're looking at. "Cued test" runs a proper
accuracy test (it tells you where to look, then checks if the decoder agrees).

Usage:
  python tools/ssvep_test.py --port /dev/cu.usbmodemXXXX   # Ganglion with the BLED112 dongle
  python tools/ssvep_test.py --native                      # Ganglion over Mac Bluetooth
  python tools/ssvep_test.py --fake                        # no headset: simulated EEG
                                                           # (hover a tile to "look" at it)
Close the OpenBCI GUI first (only one program can hold the Ganglion). Ctrl+C to stop.
Raw EEG (CSV) and every trial (JSONL) are saved to logs/ (git-ignored).

Channel map (PLAN.md): 1=O1 2=Oz 3=O2 (SSVEP), 4=T7 (jaw EMG). Change with --ssvep-ch.
Decoder: filter-bank CCA (Chen et al. 2015) over the SSVEP channels, 3 harmonics.
"""
import argparse
import json
import os
import threading
import time
import warnings
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

warnings.filterwarnings("ignore", message="pkg_resources is deprecated")
import numpy as np
from scipy.signal import butter, iirnotch, sosfiltfilt, filtfilt

from eeg_check import analyse  # same per-channel quality numbers as eeg_check.py

NAMES = ["O1", "Oz", "O2", "T7"]
HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "ssvep_test.html")
RING_S = 60
SUBBANDS = [(6, 45), (14, 45), (22, 45)]
SUB_W = np.array([(k + 1) ** -1.25 + 0.25 for k in range(len(SUBBANDS))])
HARMONICS = 3
TRIAL_SKIP_S = 0.5     # ignore the first 0.5 s of a trial (visual response latency + BLE lag)
END_WAIT_S = 0.15      # wait for in-flight BLE packets before scoring a trial
LIVE_WIN_S = 3.0


# ---------------------------------------------------------------- signal sources
class GanglionSource:
    def __init__(self, args):
        from brainflow.board_shim import BoardIds, BoardShim, BrainFlowInputParams
        params = BrainFlowInputParams()
        params.timeout = 15
        if args.fw:
            params.other_info = f"fw:{args.fw}"
        if args.native:
            board_id = BoardIds.GANGLION_NATIVE_BOARD.value
        else:
            board_id = BoardIds.GANGLION_BOARD.value
            params.serial_port = args.port
        self.fs = BoardShim.get_sampling_rate(board_id)
        self.chans = BoardShim.get_eeg_channels(board_id)[:4]
        self.name = "Ganglion (Bluetooth)" if args.native else "Ganglion (dongle)"
        BoardShim.disable_board_logger()
        for attempt in range(1, args.tries + 1):
            self.board = BoardShim(board_id, params)
            print(f"Connecting, attempt {attempt}/{args.tries} (can take ~10-20 s)...")
            try:
                self.board.prepare_session()
                self.board.start_stream(45000)
                return
            except Exception as e:  # BLE on macOS is flaky: retry from scratch
                print(f"  failed: {e}")
                try:
                    if self.board.is_prepared():
                        self.board.release_session()
                except Exception:
                    pass
                if attempt == args.tries:
                    raise SystemExit("\nCould not start streaming. Check: OpenBCI GUI fully quit, Ganglion "
                                     "LED blinking, laptop within 1 m, Bluetooth off/on, power-cycle the Ganglion.")
                time.sleep(3)

    def read(self):
        data = self.board.get_board_data()
        return data[self.chans] if data.shape[1] else np.zeros((4, 0))

    def set_gaze(self, idx, freq):
        pass

    def close(self):
        try:
            self.board.stop_stream()
            self.board.release_session()
        except Exception:
            pass


class FakeSource:
    """Simulated EEG: background noise, alpha, mains hum, and an SSVEP at the gazed tile."""
    name = "Simulated EEG (--fake)"

    def __init__(self, args):
        self.fs = 200
        self.amp = args.fake_amp
        self.rng = np.random.default_rng()
        self.t0 = self.last = time.time()
        self.n = 0
        self.ar = np.zeros(4)
        self.freq = None

    def set_gaze(self, idx, freq):
        self.freq = freq

    def read(self):
        now = time.time()
        n = int((now - self.t0) * self.fs) - self.n
        if n <= 0:
            return np.zeros((4, 0))
        t = (self.n + np.arange(n)) / self.fs
        self.n += n
        out = np.empty((4, n))
        white = self.rng.normal(0, 1, (4, n))
        for i in range(n):  # AR(1) "brown-ish" background, ~10 uV
            self.ar = 0.96 * self.ar + white[:, i] * 2.6
            out[:, i] = self.ar
        out += self.rng.normal(0, 2.5, (4, n))
        out += 12 * np.sin(2 * np.pi * 60 * t)                       # mains hum
        out[:3] += 3 * np.sin(2 * np.pi * 10.3 * t + 1.0)            # resting alpha
        out[3] += self.rng.normal(0, 4, n)                           # T7: some muscle
        if self.freq:
            for h, a in zip((1, 2, 3), (1.0, 0.5, 0.25)):
                s = self.amp * a * np.sin(2 * np.pi * h * self.freq * t + 0.7 * h)
                out[0] += 0.8 * s
                out[1] += s
                out[2] += 0.8 * s
        return out

    def close(self):
        pass


# ---------------------------------------------------------------- DSP
def notch(x, fs):
    b, a = iirnotch(60, 30, fs)
    return filtfilt(b, a, x, axis=-1)


def cca_rho(X, Y):
    qx, _ = np.linalg.qr(X - X.mean(0))
    qy, _ = np.linalg.qr(Y - Y.mean(0))
    return float(np.linalg.svd(qx.T @ qy, compute_uv=False)[0])


def fbcca(x, fs, freqs, pad):
    """x: (ch, pad + n) raw. Returns per-frequency scores (sum of weighted rho^2)."""
    x = notch(x, fs)
    n = x.shape[1] - pad
    t = np.arange(n) / fs
    refs = []
    for f in freqs:
        cols = []
        for h in range(1, HARMONICS + 1):
            if h * f < fs / 2 - 5:
                cols += [np.sin(2 * np.pi * h * f * t), np.cos(2 * np.pi * h * f * t)]
        refs.append(np.array(cols).T)
    scores = np.zeros(len(freqs))
    for w, (lo, hi) in zip(SUB_W, SUBBANDS):
        xb = sosfiltfilt(butter(4, [lo, hi], "bandpass", fs=fs, output="sos"), x, axis=-1)[:, pad:]
        for i, Y in enumerate(refs):
            scores[i] += w * cca_rho(xb.T, Y) ** 2
    return scores


def spectrum(x, fs, fmax=45):
    """Mean amplitude spectrum (uV) over channels, zero-padded to 0.1 Hz bins."""
    x = notch(x - x.mean(-1, keepdims=True), fs)
    x = sosfiltfilt(butter(4, [3, 45], "bandpass", fs=fs, output="sos"), x, axis=-1)
    nfft = max(int(fs * 10), x.shape[1])
    win = np.hanning(x.shape[1])
    amp = np.abs(np.fft.rfft(x * win, nfft, axis=-1)) * 2 / win.sum()
    freqs = np.fft.rfftfreq(nfft, 1 / fs)
    m = freqs <= fmax
    return freqs[m], amp[:, m].mean(0)


def snr_at(freqs, amp, f):
    """Peak amplitude within 0.15 Hz of f, divided by the mean 0.5-1.5 Hz either side."""
    peak = amp[np.abs(freqs - f) <= 0.15].max()
    side = (np.abs(freqs - f) >= 0.5) & (np.abs(freqs - f) <= 1.5)
    return float(peak / max(amp[side].mean(), 1e-9))


# ---------------------------------------------------------------- app state
class Bench:
    def __init__(self, src, ssvep_idx, csv_path, events_path):
        self.src = src
        self.fs = src.fs
        self.ssvep_idx = ssvep_idx
        self.ring = np.zeros((4, RING_S * self.fs))
        self.total = 0
        self.lock = threading.Lock()
        self.freqs = [7.5, 8.571, 10.0, 12.0]
        self.trial = None
        self.trial_id = 0
        self.last_rx = 0.0
        self.csv = open(csv_path, "w")
        self.csv.write("sample," + ",".join(NAMES) + ",unix_time\n")
        self.events = open(events_path, "a")
        self.running = True

    def log(self, **ev):
        ev["t"] = time.time()
        ev["sample"] = self.total
        self.events.write(json.dumps(ev) + "\n")
        self.events.flush()

    def pull(self):
        with self.lock:
            d = self.src.read()
            n = d.shape[1]
            if not n:
                return
            now = time.time()
            self.last_rx = now
            L = self.ring.shape[1]
            if n >= L:
                self.ring[:] = d[:, -L:]
            else:
                self.ring = np.roll(self.ring, -n, axis=1)
                self.ring[:, -n:] = d
            for i in range(n):
                self.csv.write(f"{self.total + i}," + ",".join(f"{v:.3f}" for v in d[:, i]) + f",{now:.3f}\n")
            self.total += n

    def acquire_loop(self):
        while self.running:
            try:
                self.pull()
            except Exception as e:
                print("read error:", e)
            time.sleep(0.04)

    def window(self, start, end):
        """Samples [start, end) by absolute index (clipped to what the ring still holds)."""
        L = self.ring.shape[1]
        start = max(start, self.total - L, 0)
        return self.ring[:, L - (self.total - start): L - (self.total - end) or None].copy()

    # -- live view
    def snapshot(self):
        with self.lock:
            fs, total = self.fs, self.total
            have = min(total, self.ring.shape[1])
            recent = self.ring[:, -min(have, 4 * fs):].copy() if have else None
            live = self.ring[:, -min(have, int((LIVE_WIN_S + 1) * fs)):].copy() if have else None
            stale = time.time() - self.last_rx if self.last_rx else None
        snap = {"type": "snap", "source": self.src.name, "fs": fs, "samples": total,
                "stale_s": stale, "freqs": self.freqs, "names": NAMES, "ssvep_idx": self.ssvep_idx}
        if recent is None or recent.shape[1] < 2 * fs:
            snap["warming"] = True
            return snap
        q = []
        for i, name in enumerate(NAMES):
            noise, hum, rail, alpha, emg = analyse(recent[i], fs)
            if rail > 1:
                level, msg = "bad", "No contact (input railed): check the electrode touches skin and its wire is plugged in"
            elif noise < 1.0:
                level, msg = "bad", "Flat line: wire unplugged or broken"
            elif hum > 100:
                level, msg = "bad", "Strong 60 Hz hum: poor contact. Press it in, part the hair, add paste; unplug the charger"
            elif noise > 60:
                level, msg = "bad", "Very noisy: poor contact or movement. Sit still, relax jaw, press electrode in"
            elif noise > 30 or hum > 40:
                level, msg = "warn", "Usable but noisy: wiggle the electrode through the hair"
            else:
                level, msg = "good", "Good contact"
            q.append({"name": name, "eeg_uv": round(noise, 1), "hum_uv": round(hum, 1),
                      "alpha_x": round(alpha, 2), "emg_uv": round(emg, 1), "level": level, "msg": msg,
                      "role": "SSVEP" if i in self.ssvep_idx else "EMG"})
        snap["quality"] = q
        # traces: 1-45 Hz filtered, last 4 s, decimated by 2
        tr = sosfiltfilt(butter(4, [1, 45], "bandpass", fs=fs, output="sos"), notch(recent, fs), axis=-1)
        snap["traces"] = np.round(tr[:, ::2], 1).tolist()
        f, a = spectrum(recent[self.ssvep_idx], fs)
        snap["spec_f"] = np.round(f[::2], 2).tolist()
        snap["spec_a"] = np.round(a[::2], 3).tolist()
        snap["snr"] = [round(snr_at(f, a, fr), 2) for fr in self.freqs]
        pad = live.shape[1] - int(LIVE_WIN_S * fs)
        if pad > 0:
            s = fbcca(live[self.ssvep_idx], fs, self.freqs, pad)
            order = np.argsort(s)[::-1]
            snap["live"] = {"scores": np.round(s, 4).tolist(), "pred": int(order[0]),
                            "margin": round(float((s[order[0]] - s[order[1]]) / s[order[0]]), 3)}
        return snap

    # -- trials
    def trial_start(self, target, mode):
        self.pull()
        with self.lock:
            self.trial_id += 1
            self.trial = {"id": self.trial_id, "target": target, "mode": mode, "start": self.total,
                          "t_start": time.time()}
        self.log(ev="trial_start", id=self.trial_id, target=target, freq=self.freqs[target] if target is not None else None,
                 mode=mode)
        return {"id": self.trial_id}

    def trial_end(self):
        time.sleep(END_WAIT_S)
        self.pull()
        with self.lock:
            tr, self.trial = self.trial, None
            if tr is None:
                return {"error": "no trial running"}
            fs = self.fs
            s0 = tr["start"] + int(TRIAL_SKIP_S * fs)
            end = self.total
            pad = fs
            x = self.window(s0 - pad, end)
        n = x.shape[1] - pad
        dur = time.time() - tr["t_start"]
        if n < fs:
            res = {"id": tr["id"], "error": f"only {n} samples arrived during the trial: is the headset streaming?"}
            self.log(ev="trial_end", **res)
            return res
        xs = x[self.ssvep_idx]
        scores = fbcca(xs, fs, self.freqs, pad)
        order = np.argsort(scores)[::-1]
        f, a = spectrum(xs[:, pad:], fs)
        ptp = float(np.ptp(sosfiltfilt(butter(4, [1, 45], "bandpass", fs=fs, output="sos"),
                                       notch(xs[:, pad:], fs), axis=-1), axis=1).max())
        expected = n / max(dur - TRIAL_SKIP_S, 1e-3)
        res = {"id": tr["id"], "target": tr["target"], "pred": int(order[0]),
               "correct": tr["target"] is not None and int(order[0]) == tr["target"],
               "scores": np.round(scores, 4).tolist(),
               "margin": round(float((scores[order[0]] - scores[order[1]]) / scores[order[0]]), 3),
               "snr": [round(snr_at(f, a, fr), 2) for fr in self.freqs],
               "used_s": round(n / fs, 2), "ptp_uv": round(ptp, 1), "artifact": ptp > 200,
               "packet_rate": round(min(expected / fs, 1.5), 2)}
        self.log(ev="trial_end", freqs=self.freqs, **res)
        return res


# ---------------------------------------------------------------- HTTP
def make_handler(bench):
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
                    while bench.running:
                        snap = bench.snapshot()
                        self.wfile.write(f"data: {json.dumps(snap)}\n\n".encode())
                        self.wfile.flush()
                        time.sleep(0.2)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                self.send_error(404)

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            if self.path == "/api/freqs":
                bench.freqs = [float(f) for f in body["freqs"]]
                bench.log(ev="freqs", freqs=bench.freqs, refresh_hz=body.get("refresh_hz"))
                self._json({"ok": True})
            elif self.path == "/api/gaze":  # only used by --fake (simulated looking)
                idx = body.get("idx")
                bench.src.set_gaze(idx, bench.freqs[idx] if idx is not None else None)
                self._json({"ok": True})
            elif self.path == "/api/trial/start":
                self._json(bench.trial_start(body.get("target"), body.get("mode", "cued")))
            elif self.path == "/api/trial/end":
                self._json(bench.trial_end())
            elif self.path == "/api/note":
                bench.log(ev=str(body.pop("ev", "note")), **body)
                self._json({"ok": True})
            else:
                self.send_error(404)
    return H


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", help="dongle serial port, e.g. /dev/cu.usbmodem11")
    ap.add_argument("--native", action="store_true", help="Ganglion over Mac Bluetooth, no dongle")
    ap.add_argument("--fake", action="store_true", help="simulated EEG, no headset needed")
    ap.add_argument("--fake-amp", type=float, default=1.5, help="simulated SSVEP size in uV (default 1.5)")
    ap.add_argument("--fw", choices=["2", "3"], help="Ganglion firmware version if auto-detect fails")
    ap.add_argument("--tries", type=int, default=3)
    ap.add_argument("--ssvep-ch", default="1,2,3", help="channels used for SSVEP (default 1,2,3 = O1,Oz,O2)")
    ap.add_argument("--http", type=int, default=8765, help="local web port (default 8765)")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    if not (args.fake or args.native or args.port):
        ap.error("give --port (dongle), --native (Bluetooth) or --fake (no headset)")

    ssvep_idx = [int(c) - 1 for c in args.ssvep_ch.split(",")]
    src = FakeSource(args) if args.fake else GanglionSource(args)
    os.makedirs("logs", exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    csv_path, ev_path = f"logs/ssvep_test_{stamp}_eeg.csv", f"logs/ssvep_test_{stamp}_events.jsonl"
    bench = Bench(src, ssvep_idx, csv_path, ev_path)
    bench.log(ev="session", source=src.name, fs=src.fs, ssvep_ch=args.ssvep_ch)
    threading.Thread(target=bench.acquire_loop, daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", args.http), make_handler(bench))
    server.daemon_threads = True
    url = f"http://127.0.0.1:{args.http}/"
    print(f"Streaming from {src.name} at {src.fs} Hz.\nOpen {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        bench.running = False
        server.server_close()
        src.close()
        bench.csv.close()
        bench.events.close()
        print(f"\nSaved {csv_path} and {ev_path}")


if __name__ == "__main__":
    main()
