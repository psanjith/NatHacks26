"""Per-user SSVEP decoders for Reach.

  fbcca       filter-bank CCA against sine/cosine references (Chen et al. 2015). Needs no training.
  trca        filter-bank ensemble TRCA (Nakanishi et al. 2018), trained on the user's own trials.
              Needs epochs that start at flicker onset (the flicker always starts in phase 0).
  trca+fbcca  both, z-scored and summed.

Epochs are filtered as a whole (with ~1 s of padding before onset) and then cut to
[onset + LAT, onset + LAT + win]. Confidence ("margin") is the gap between the top two
z-scored class scores, so it means the same thing for every method.
"""
import json
import time

import numpy as np
from scipy.linalg import eigh
from scipy.signal import butter, filtfilt, iirnotch, sosfiltfilt

BANDS = [(5, 45), (11, 45), (17, 45), (23, 45), (29, 45)]
BAND_W = np.array([(m + 1) ** -1.25 + 0.25 for m in range(len(BANDS))])
MAX_HARM_HZ = 45.0
LAT = 0.15          # s skipped after onset (visual pathway latency)
GAZE_S = 1.0        # s added per selection for ITR (moving the eyes to the next target)
METHODS = ("fbcca", "trca", "trca+fbcca")
_SOS = {}


def filter_bank(x, fs):
    """x: (ch, n) raw uV -> (bands, ch, n): mean removed, 60 Hz notch, band-passed."""
    x = np.asarray(x, float)
    x = x - x.mean(-1, keepdims=True)
    b, a = iirnotch(60, 30, fs)
    x = filtfilt(b, a, x, axis=-1)
    out = []
    for lo, hi in BANDS:
        key = (lo, hi, fs)
        if key not in _SOS:
            _SOS[key] = butter(4, [lo, hi], "bandpass", fs=fs, output="sos")
        out.append(sosfiltfilt(_SOS[key], x, axis=-1))
    return np.stack(out)


def cut(fb, onset, fs, lat, win, n_on):
    """Slice [onset+lat, onset+lat+win) from a filtered epoch; None if the flicker was shorter."""
    a = onset + int(round(lat * fs))
    b = a + int(round(win * fs))
    if b > min(fb.shape[-1], onset + n_on + int(0.1 * fs)):
        return None
    return fb[..., a:b]


def _refs(freqs, n, fs):
    t = np.arange(n) / fs
    out = []
    for f in freqs:
        cols, h = [], 1
        while h * f <= MAX_HARM_HZ and h <= 5:
            cols += [np.sin(2 * np.pi * h * f * t), np.cos(2 * np.pi * h * f * t)]
            h += 1
        out.append(np.array(cols).T)
    return out


def _cca_r(X, Y):
    qx, _ = np.linalg.qr(X - X.mean(0))
    qy, _ = np.linalg.qr(Y - Y.mean(0))
    return float(np.linalg.svd(qx.T @ qy, compute_uv=False)[0])


def fbcca_scores(seg, fs, freqs):
    """seg: (bands, ch, n) -> score per frequency."""
    Ys = _refs(freqs, seg.shape[-1], fs)
    s = np.zeros(len(freqs))
    for m in range(seg.shape[0]):
        for k, Y in enumerate(Ys):
            s[k] += BAND_W[m] * _cca_r(seg[m].T, Y) ** 2
    return s


def _trca_w(X):
    """X: (trials, ch, n) of one class in one band -> spatial filter maximising trial-to-trial reproducibility."""
    X = X - X.mean(-1, keepdims=True)
    U = X.sum(0)
    Q = np.einsum("tcn,tdn->cd", X, X)
    S = U @ U.T - Q
    Q = Q + 1e-9 * np.trace(Q) * np.eye(len(Q))
    _, vecs = eigh(S, Q)
    return vecs[:, -1]


def trca_fit(S, y, K):
    """S: (trials, bands, ch, n), y: class index -> (W: bands x ch x K, T: bands x K x ch x n)."""
    nb, ch, n = S.shape[1:]
    W = np.zeros((nb, ch, K))
    T = np.zeros((nb, K, ch, n))
    for m in range(nb):
        for k in range(K):
            Xk = S[y == k, m]
            W[m, :, k] = _trca_w(Xk)
            T[m, k] = Xk.mean(0)
    return W, T


def trca_scores(W, T, seg):
    K = W.shape[2]
    s = np.zeros(K)
    for m in range(W.shape[0]):
        a = (W[m].T @ seg[m]).ravel()
        for k in range(K):
            b = (W[m].T @ T[m, k]).ravel()
            r = np.corrcoef(a, b)[0, 1]
            s[k] += BAND_W[m] * np.sign(r) * r * r
    return s


def zs(s):
    s = np.asarray(s, float)
    return (s - s.mean()) / (s.std() + 1e-12)


def margin(s):
    z = np.sort(zs(s))[::-1]
    return float(z[0] - z[1])


def itr(P, N, T):
    """Wolpaw information transfer rate in bits/min."""
    if N < 2 or P <= 1 / N:
        return 0.0
    bits = np.log2(N)
    if P < 1:
        bits += P * np.log2(P) + (1 - P) * np.log2((1 - P) / (N - 1))
    return float(bits * 60 / T)


def match(f, freqs, tol=0.06):
    if f is None:
        return None
    d = [abs(f - g) for g in freqs]
    i = int(np.argmin(d))
    return i if d[i] <= tol else None


def pick_threshold(margins, correct, target=0.95):
    """Smallest confidence cut-off at which accepted picks are >= target accurate."""
    order = np.argsort(-np.asarray(margins))
    m = np.asarray(margins)[order]
    c = np.asarray(correct, float)[order]
    acc = np.cumsum(c) / np.arange(1, len(c) + 1)
    ok = np.where(acc >= target)[0]
    if not len(ok):
        return {"thr": None, "cover": 0.0, "acc_accepted": None}
    j = int(ok.max())
    return {"thr": round(float(m[j]), 3), "cover": round((j + 1) / len(c), 3), "acc_accepted": round(float(acc[j]), 3)}


def cross_validate(items, freqs, fs, wins, lat=LAT, k=5, seed=0):
    """items: dicts with fb (bands, ch, n), onset, n_on, label (0..K-1), test.
    Stratified k-fold. fbcca needs no training but is scored on the same trials as trca."""
    K = len(freqs)
    y = np.array([it["label"] for it in items])
    counts = np.bincount(y, minlength=K) if len(y) else np.zeros(K, int)
    if counts.min() < 2:
        return [], f"need at least 2 trials of every frequency (have {counts.tolist()} for {freqs})"
    kf = int(min(k, counts.min()))
    rng = np.random.default_rng(seed)
    fold = np.zeros(len(y), int)
    for c in range(K):
        idx = np.where(y == c)[0]
        rng.shuffle(idx)
        fold[idx] = np.arange(len(idx)) % kf
    rows = []
    for win in wins:
        segs = [cut(it["fb"], it["onset"], fs, lat, win, it["n_on"]) for it in items]
        ok = np.array([s is not None for s in segs])
        if ok.sum() < 2 * K or np.bincount(y[ok], minlength=K).min() < 2:
            continue
        idx = np.where(ok)[0]
        S = np.stack([segs[i] for i in idx])
        yy, ff = y[idx], fold[idx]
        tests = [items[i]["test"] for i in idx]
        F = np.array([fbcca_scores(s, fs, freqs) for s in S])
        R = np.full((len(S), K), np.nan)
        for f in range(kf):
            tr, te = ff != f, ff == f
            if not te.any() or np.bincount(yy[tr], minlength=K).min() < 2:
                continue
            W, T = trca_fit(S[tr], yy[tr], K)
            for i in np.where(te)[0]:
                R[i] = trca_scores(W, T, S[i])
        have = ~np.isnan(R).any(1)
        sel = have if have.sum() >= 2 * K else np.ones(len(S), bool)
        for method in METHODS:
            if method != "fbcca" and sel is not have:
                continue
            if method == "fbcca":
                M = F
            elif method == "trca":
                M = R
            else:
                M = np.array([zs(a) + zs(b) for a, b in zip(R, F)])
            M = M[sel]
            pred = M.argmax(1)
            corr = pred == yy[sel]
            margins = np.array([margin(s) for s in M])
            P = float(corr.mean())
            by_test = {}
            for t in sorted(set(tests)):
                mk = np.array([tt == t for tt in tests])[sel]
                if mk.any():
                    by_test[t] = {"acc": round(float(corr[mk].mean()), 3), "n": int(mk.sum())}
            rows.append({"method": method, "win": win, "n": int(sel.sum()), "acc": round(P, 3),
                         "itr": round(itr(P, K, win + GAZE_S), 1), "by_test": by_test,
                         **pick_threshold(margins, corr)})
    return rows, None


def heldout_predictions(items, freqs, fs, method, win, lat=LAT, k=5, seed=0):
    """Per-item (pred, margin) from a model that never saw that item (k-fold), or None if too short.
    For fbcca there is no training, so this is just the decoder's output."""
    K = len(freqs)
    y = np.array([it["label"] for it in items])
    segs = [cut(it["fb"], it["onset"], fs, lat, win, it["n_on"]) for it in items]
    out = [None] * len(items)
    F = {i: fbcca_scores(s, fs, freqs) for i, s in enumerate(segs) if s is not None}
    if method == "fbcca":
        for i, s in F.items():
            out[i] = (int(np.argmax(s)), margin(s))
        return out
    idx = np.array(sorted(F))
    counts = np.bincount(y[idx], minlength=K)
    kf = int(min(k, counts.min()))
    if kf < 2:
        return out
    rng = np.random.default_rng(seed)
    fold = np.zeros(len(items), int)
    for c in range(K):
        ii = idx[y[idx] == c]
        rng.shuffle(ii)
        fold[ii] = np.arange(len(ii)) % kf
    for f in range(kf):
        tr = idx[fold[idx] != f]
        te = idx[fold[idx] == f]
        if np.bincount(y[tr], minlength=K).min() < 2:
            continue
        W, T = trca_fit(np.stack([segs[i] for i in tr]), y[tr], K)
        for i in te:
            r = trca_scores(W, T, segs[i])
            s = r if method == "trca" else zs(r) + zs(F[i])
            out[i] = (int(np.argmax(s)), margin(s))
    return out


def pick(rows):
    """Best config: highest bits/min among those >= 90% accurate, else the most accurate (shortest on ties)."""
    good = [r for r in rows if r["acc"] >= 0.9 and r["n"] >= 8]
    if good:
        return max(good, key=lambda r: (r["itr"], r["acc"]))
    return max(rows, key=lambda r: (r["acc"], -r["win"], r["method"] != "fbcca"))


def recommend(per, k=4):
    """Choose k frequencies the user responds to best, avoiding near-duplicates and harmonic pairs."""
    def harmonic(a, b):
        r = max(a, b) / min(a, b)
        return round(r) >= 2 and abs(r - round(r)) < 0.04

    usable = [p for p in per if p["n"] >= 2]
    ranked = sorted(usable, key=lambda p: p["hits"] / p["n"] + 0.3 * np.log2(max(p["snr"] or 1.0, 1.0)), reverse=True)
    chosen = []
    for p in ranked:
        f = p["freq"]
        if any(abs(f - g) < 0.9 or harmonic(f, g) for g in chosen):
            continue
        chosen.append(f)
        if len(chosen) == k:
            break
    return sorted(chosen) if len(chosen) == k else None


class Model:
    """A trained per-user decoder. Saved as one .npz (arrays + JSON metadata)."""

    def __init__(self, meta, W=None, T=None):
        self.meta, self.W, self.T = meta, W, T

    @classmethod
    def fit(cls, items, freqs, fs, cfg, ssvep_ch, user):
        K = len(freqs)
        segs, ys = [], []
        for it in items:
            s = cut(it["fb"], it["onset"], fs, LAT, cfg["win"], it["n_on"])
            if s is not None:
                segs.append(s)
                ys.append(it["label"])
        y = np.array(ys)
        W = T = None
        if cfg["method"] != "fbcca":
            W, T = trca_fit(np.stack(segs), y, K)
        meta = {"user": user, "freqs": list(freqs), "fs": fs, "method": cfg["method"], "win": cfg["win"],
                "lat": LAT, "thr": cfg["thr"], "cv_acc": cfg["acc"], "cv_n": cfg["n"], "cv_itr": cfg["itr"],
                "cover": cfg["cover"], "acc_accepted": cfg["acc_accepted"], "n_train": len(segs), "ssvep_ch": ssvep_ch,
                "created": time.strftime("%Y-%m-%d %H:%M:%S")}
        return cls(meta, W, T)

    def save(self, path):
        arrs = {"meta": np.array(json.dumps(self.meta))}
        if self.W is not None:
            arrs.update(W=self.W, T=self.T)
        np.savez_compressed(path, **arrs)

    @classmethod
    def load(cls, path):
        d = np.load(path)
        meta = json.loads(str(d["meta"]))
        return cls(meta, d["W"] if "W" in d else None, d["T"] if "T" in d else None)

    def matches(self, cands):
        return len(cands) == len(self.meta["freqs"]) and all(match(f, self.meta["freqs"]) == i for i, f in enumerate(cands))

    def flicker_s(self):
        return self.meta["lat"] + self.meta["win"] + 0.15

    def decide(self, fb, onset, n_on):
        """fb: filter_bank() of the epoch's SSVEP channels. Returns (index, margin, accepted, scores) or None."""
        m = self.meta
        seg = cut(fb, onset, m["fs"], m["lat"], m["win"], n_on)
        if seg is None:
            return None
        F = fbcca_scores(seg, m["fs"], m["freqs"])
        if m["method"] == "fbcca":
            s = F
        elif m["method"] == "trca":
            s = trca_scores(self.W, self.T, seg)
        else:
            s = zs(trca_scores(self.W, self.T, seg)) + zs(F)
        mg = margin(s)
        thr = m["thr"] if m["thr"] is not None else float("-inf")  # no safe cut-off found: accept every pick
        return int(np.argmax(s)), mg, mg >= thr, s
