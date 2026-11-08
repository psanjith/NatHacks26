"""Live decoding with a model from SSVEP-Analysis-Toolbox (Wang et al., IEEE TNSRE 2024) instead of ours.

The toolbox models are trained per person: each one is fit on this person's earlier trials at the
candidate frequencies, and refit (without the trial being scored) as new trials come in, so every
guess comes from a model that never saw that trial.

Needs the toolbox's pinned versions (numpy < 1.24), so run the trainer from a Python 3.9 venv:
  <py39 venv>/bin/python tools/ssvep_train.py --native --user nav --decoder ecca
"""
import os
import sys
import warnings

import numpy as np

import ssvep_model as sm

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "SSVEP-Analysis-Toolbox-main"))
warnings.filterwarnings("ignore")

from SSVEPAnalysisToolbox.algorithms import ECCA, ETRCA, MSETRCA, SCCA_qr, TDCA  # noqa: E402
from SSVEPAnalysisToolbox.utils.algsupport import gen_ref_sin  # noqa: E402

WEIGHTS = [(m + 1) ** -1.25 + 0.25 for m in range(len(sm.BANDS))]
WIN_S = 3.0          # analysis window after the visual latency (Test 1 = 7 s flicker, Test 2 = 4 s)
DELAY = 3            # TDCA needs a few samples past the window
MIN_PER_FREQ = 2     # trained models need at least this many earlier trials per frequency

DECODERS = {
    "ecca": ("Toolbox eCCA", lambda: ECCA(weights_filterbank=WEIGHTS), True),
    "etrca": ("Toolbox eTRCA", lambda: ETRCA(weights_filterbank=WEIGHTS), True),
    "msetrca": ("Toolbox ms-eTRCA", lambda: MSETRCA(n_neighbor=1, weights_filterbank=WEIGHTS), True),
    "tdca": ("Toolbox TDCA", lambda: TDCA(n_component=3, weights_filterbank=WEIGHTS, n_delay=DELAY), True),
    "fbcca": ("Toolbox FBCCA", lambda: SCCA_qr(weights_filterbank=WEIGHTS), False),
}


class ToolboxDecoder:
    def __init__(self, key, fs):
        self.key = key
        self.name, self.make, self.trained = DECODERS[key]
        self.fs = fs
        self.n = int(WIN_S * fs)
        self._cache = {}          # (cands, ids of training trials) -> fitted model

    def segment(self, fb, onset, n_on):
        a = onset + int(sm.LAT * self.fs)
        if n_on < int(sm.LAT * self.fs) + self.n or a + self.n + DELAY > fb.shape[2]:
            return None
        return fb[:, :, a:a + self.n + DELAY]

    def _fit(self, cands, train, fb_of):
        X, Y = [], []
        for t in train:
            k = sm.match(t.get("target_freq"), cands) if t.get("target_freq") else None
            if k is None or t["test"] not in ("single", "four"):
                continue
            seg = self.segment(fb_of(t), t["onset"], t["n_on"])
            if seg is not None:
                X.append(seg)
                Y.append(k)
        ref = [gen_ref_sin(f, self.fs, self.n + DELAY, 5, 0) for f in cands]
        if self.trained:
            counts = np.bincount(Y, minlength=len(cands)) if Y else np.zeros(len(cands), int)
            if counts.min() < MIN_PER_FREQ:
                return None, counts.tolist()
        m = self.make()
        m.fit(X=X if self.trained else None, Y=Y if self.trained else None, ref_sig=ref, freqs=list(cands))
        return m, len(Y)

    def predict(self, trial, cands, train, fb_of):
        """Returns {pred, n_train} or {error}. `train` must not include `trial`."""
        seg = self.segment(fb_of(trial), trial["onset"], trial["n_on"])
        if seg is None:
            return {"error": f"flicker shorter than {WIN_S + sm.LAT:.2f} s"}
        key = (tuple(round(c, 3) for c in cands), tuple(sorted((t["session"], t["id"]) for t in train)))
        if key not in self._cache:
            self._cache = {key: self._fit(cands, train, fb_of)}     # keep only the latest fit
        m, info = self._cache[key]
        if m is None:
            return {"error": f"not enough earlier trials per frequency to train ({info}, need {MIN_PER_FREQ} each)"}
        p = np.array(m.predict([seg]))
        if p.ndim > 1:          # some toolbox models return (labels, ...) per call
            p = p[0]
        p = int(p[0])
        return {"pred": cands[p], "index": p, "n_train": info}
