"""Export one person's recorded SSVEP trials, organised by frequency, and a replay file for the sim.

  python tools/ssvep_export.py --user nav

Writes to logs/users/<user>/ (git-ignored):
  by_hz/<freq>Hz/<session>_trial_<id>_<test>.csv   one file per trial: time_s (0 = flicker onset), O1, Oz, O2, T7 in uV
  dataset.npz       every trial in one file: x (trials, 4, n) padded with NaN, freq, test, session, id, onset, n_on, fs
  sim_replay.json   for the sim's "Pick with Nav's EEG": each trial at the model's 4 frequencies with the
                    decision a model that never saw that trial makes (cross-validated), so the replay is honest.
The trainer runs this automatically after Train and when it exits.
"""
import argparse
import glob
import json
import os
import shutil
import time

import numpy as np

import ssvep_model as sm

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NAMES = ["O1", "Oz", "O2", "T7"]


def user_dir(user):
    return os.path.join(ROOT, "logs", "users", user)


def load_trials(udir):
    out = []
    for p in sorted(glob.glob(os.path.join(udir, "*", "trial_*.npz"))):
        try:
            d = np.load(p)
            t = json.loads(str(d["meta"]))
            t["x"] = d["x"].astype(float)
            out.append(t)
        except Exception as e:
            print(f"skipping {p}: {e}")
    return out


def export(udir, trials, ssvep_idx, model=None, fb_of=None):
    """trials: dicts with x (4, n), fs, onset, n_on, target_freq, test, session, id."""
    labelled = [t for t in trials if t.get("target_freq") is not None and t["test"] in ("single", "four")]
    if not labelled:
        return {"trials": 0}
    fb_of = fb_of or (lambda t: sm.filter_bank(t["x"][ssvep_idx], t["fs"]))
    # 1) one CSV per trial, grouped by frequency
    hz_dir = os.path.join(udir, "by_hz")
    shutil.rmtree(hz_dir, ignore_errors=True)
    per_hz = {}
    for t in labelled:
        name = f"{t['target_freq']:.2f}".rstrip("0").rstrip(".") + "Hz"
        d = os.path.join(hz_dir, name)
        os.makedirs(d, exist_ok=True)
        x, fs = t["x"], t["fs"]
        tt = (np.arange(x.shape[1]) - t["onset"]) / fs
        with open(os.path.join(d, f"{t['session']}_trial_{t['id']:03d}_{t['test']}.csv"), "w") as fh:
            fh.write(f"# freq_hz={t['target_freq']:.4f} test={t['test']} spacing={t.get('spacing')} fs={fs} "
                     f"flicker_s={t['n_on'] / fs:.3f} decoder_said={t.get('fb_pred')}\n")
            fh.write("time_s," + ",".join(NAMES) + "\n")
            for i in range(x.shape[1]):
                fh.write(f"{tt[i]:.3f}," + ",".join(f"{v:.3f}" for v in x[:, i]) + "\n")
        per_hz[name] = per_hz.get(name, 0) + 1
    # 2) everything in one array file
    n = max(t["x"].shape[1] for t in labelled)
    X = np.full((len(labelled), labelled[0]["x"].shape[0], n), np.nan, np.float32)
    for i, t in enumerate(labelled):
        X[i, :, : t["x"].shape[1]] = t["x"]
    np.savez_compressed(os.path.join(udir, "dataset.npz"), x=X,
                        freq=np.array([t["target_freq"] for t in labelled]), test=np.array([t["test"] for t in labelled]),
                        session=np.array([t["session"] for t in labelled]), id=np.array([t["id"] for t in labelled]),
                        onset=np.array([t["onset"] for t in labelled]), n_on=np.array([t["n_on"] for t in labelled]),
                        fs=labelled[0]["fs"], channels=np.array(NAMES))
    out = {"trials": len(labelled), "per_hz": per_hz, "dir": hz_dir}
    # 3) sim replay at the model's 4 frequencies
    if model is not None:
        m = model.meta
        freqs = m["freqs"]
        items, src = [], []
        for t in labelled:
            k = sm.match(t["target_freq"], freqs)
            if k is not None:
                items.append({"fb": fb_of(t), "onset": t["onset"], "n_on": t["n_on"], "label": k, "test": t["test"]})
                src.append(t)
        preds = sm.heldout_predictions(items, freqs, m["fs"], m["method"], m["win"]) if items else []
        thr = m["thr"] if m["thr"] is not None else float("-inf")
        rec = []
        for it, t, p in zip(items, src, preds):
            if p is None:
                continue
            k, mg = p
            seg = t["x"][ssvep_idx[1] if len(ssvep_idx) > 1 else ssvep_idx[0]]
            a = t["onset"] + int(m["lat"] * t["fs"])
            trace = seg[a: a + int(m["win"] * t["fs"])]
            trace = np.round(trace - trace.mean(), 1)[::2].tolist()  # Oz, 100 samples/s, for drawing
            rec.append({"id": f"{t['session']}/{t['id']}", "freq_index": it["label"], "freq": freqs[it["label"]],
                        "pred_index": k, "margin": round(mg, 3), "accepted": bool(mg >= thr),
                        "correct": k == it["label"], "test": t["test"], "trace_oz": trace})
        replay = {"user": m.get("user"), "freqs": freqs, "method": m["method"], "win": m["win"], "lat": m["lat"],
                  "thr": m["thr"], "cv_acc": m["cv_acc"], "created": time.strftime("%Y-%m-%d %H:%M:%S"),
                  "note": "Each decision comes from a model that never saw that trial (cross-validated).",
                  "trials": rec}
        with open(os.path.join(udir, "sim_replay.json"), "w") as fh:
            json.dump(replay, fh)
        ok = sum(r["correct"] for r in rec)
        out["replay"] = {"n": len(rec), "correct": ok, "unsure": sum(not r["accepted"] for r in rec)}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--user", default="nav")
    ap.add_argument("--ssvep-ch", default="1,2,3")
    args = ap.parse_args()
    udir = user_dir(args.user)
    trials = load_trials(udir)
    mp = os.path.join(udir, "model.npz")
    model = sm.Model.load(mp) if os.path.exists(mp) else None
    if model is None:
        print("No model.npz yet (press Train in the trainer): exporting recordings only, no sim replay.")
    res = export(udir, trials, [int(c) - 1 for c in args.ssvep_ch.split(",")], model)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
