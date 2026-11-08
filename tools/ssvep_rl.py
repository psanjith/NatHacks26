"""Reinforcement-learning SSVEP decoder: a contextual bandit with linear Thompson sampling.

Each trial the agent sees, for every square on screen, how strongly each EEG channel follows that
square's frequency (log signal-to-noise at the frequency and its 2nd/3rd harmonics, relative to the
other squares). It picks one square (action), gets reward +1 if it was the square the person was
cued to look at and -1 if not, and updates. It never sees the label itself, only right/wrong.

Exploration: Thompson sampling (pick with weights sampled from the posterior), so early on it tries
things and settles as evidence builds up. Rehearsal/demo picks are greedy (posterior mean).
The agent is saved after every update in logs/users/<user>/rl_agent.npz and keeps learning across runs.
"""
import json
import os
import time

import numpy as np
from scipy.signal import butter, filtfilt, iirnotch, sosfiltfilt

LAT = 0.15             # visual response latency skipped at flicker onset (s)
HARM = (1, 2, 3)
MAX_S = 6.5            # longest analysis window (Test 1/2 flicker is 7 s)
REWARD = (1.0, -1.0)   # right, wrong


def mains_aliases(fs):
    """Frequencies where mains hum (60 Hz and harmonics) lands after sampling at fs."""
    out = []
    for k in range(1, 8):
        f = abs(k * 60 - round(k * 60 / fs) * fs)
        out.append(f)
    return out


def features(x, fs, onset, n_on, cands):
    """x: (channels, samples) raw epoch. Returns Phi (len(cands), channels * len(HARM)) or None."""
    a = onset + int(LAT * fs)
    n = min(n_on - int(LAT * fs) - int(0.05 * fs), int(MAX_S * fs))
    if n < 2 * fs or a + n > x.shape[1]:
        return None
    seg = x[:, a:a + n].astype(float)
    seg = seg - seg.mean(1, keepdims=True)
    b, aa = iirnotch(60, 30, fs)
    seg = filtfilt(b, aa, seg, axis=1)
    seg = sosfiltfilt(butter(4, [3, 45], "bandpass", fs=fs, output="sos"), seg, axis=1)
    N = max(8 * fs, n)                                   # zero-pad to 0.125 Hz bins
    A = np.abs(np.fft.rfft(seg * np.hanning(n), n=N))
    f = np.fft.rfftfreq(N, 1 / fs)
    bad = mains_aliases(fs)
    S = []
    for fr in cands:
        row = []
        for h in HARM:
            g = fr * h
            if g > 45 or any(abs(g - m) < 0.6 for m in bad):   # skip harmonics sitting on aliased hum (e.g. 20 Hz)
                row.extend([0.0] * seg.shape[0])
                continue
            k = int(np.argmin(np.abs(f - g)))
            nb = (np.abs(f - g) > 0.5) & (np.abs(f - g) < 1.5)
            row.extend(np.log(A[:, k] / A[:, nb].mean(1)))
        S.append(row)
    S = np.array(S)
    S = S - S.mean(0, keepdims=True)                     # relative to the other squares
    return np.hstack([S, np.ones((len(cands), 1))])      # + baseline: absorbs the average reward, never changes the pick


def peak_prior(n_ch):
    """Starting belief: a square whose frequency shows up more strongly is more likely the one.
    Last weight is the baseline (expected reward of a pick before looking: mostly wrong)."""
    w = []
    for h in HARM:
        w.extend([{1: 0.3, 2: 0.15, 3: 0.05}[h]] * n_ch)
    return np.array(w + [-0.5])


class Agent:
    def __init__(self, n_ch, prior="peak", lam=30.0, v=0.1):
        self.n_ch = n_ch
        self.dim = n_ch * len(HARM) + 1
        self.prior = prior
        self.lam, self.v = lam, v
        self.m0 = peak_prior(n_ch) if prior == "peak" else np.zeros(self.dim)
        self.A = lam * np.eye(self.dim)
        self.b = lam * self.m0.copy()
        self.n = 0
        self.rewards = []          # 1 = right, 0 = wrong, in order
        self.log = []              # (time, n_cands, picked, right)
        self.rng = np.random.default_rng()

    # -- decisions
    def mean(self):
        return np.linalg.solve(self.A, self.b)

    def _cov(self):
        return self.v ** 2 * np.linalg.inv(self.A)

    def pick(self, Phi, explore=True):
        """Returns (index, prob_each): prob = share of posterior samples that would pick each square."""
        mu, cov = self.mean(), self._cov()
        W = self.rng.multivariate_normal(mu, cov, size=300)
        probs = np.bincount(np.argmax(Phi @ W.T, axis=0), minlength=len(Phi)) / 300
        w = W[0] if explore else mu
        return int(np.argmax(Phi @ w)), probs

    # -- learning
    def update(self, phi, right):
        r = REWARD[0] if right else REWARD[1]
        self.A += np.outer(phi, phi)
        self.b += r * phi
        self.n += 1
        self.rewards.append(int(bool(right)))

    def stats(self, last=20):
        R = self.rewards
        rec = R[-last:]
        return {"updates": self.n, "recent_acc": round(float(np.mean(rec)), 3) if rec else None, "recent_n": len(rec),
                "all_acc": round(float(np.mean(R)), 3) if R else None, "prior": self.prior, "channels": self.n_ch,
                "curve": [round(float(np.mean(R[max(0, i - 9):i + 1])), 2) for i in range(len(R))][-60:]}

    # -- persistence
    def save(self, path):
        tmp = path + ".tmp.npz"
        np.savez(tmp, A=self.A, b=self.b, m0=self.m0, rewards=np.array(self.rewards, int),
                 meta=np.array(json.dumps({"n_ch": self.n_ch, "prior": self.prior, "lam": self.lam, "v": self.v,
                                           "n": self.n, "saved": time.strftime("%Y-%m-%d %H:%M:%S")})))
        os.replace(tmp, path)

    @classmethod
    def load(cls, path):
        d = np.load(path)
        m = json.loads(str(d["meta"]))
        ag = cls(m["n_ch"], m["prior"], m["lam"], m["v"])
        ag.A, ag.b, ag.m0 = d["A"], d["b"], d["m0"]
        ag.rewards = d["rewards"].tolist()
        ag.n = m["n"]
        return ag


# ---------------------------------------------------------------- shadow controller
WINDOW = 20           # cued trials over which the agent must beat the rule to take control
TAKEOVER_MARGIN = 2   # it must be at least this many right ahead to take over; it hands back as soon as it falls behind


class Controller:
    """The FFT-peak rule decides; the RL agent learns alongside it from every cued trial (bandit
    feedback: it only finds out whether ITS OWN exploratory pick was right). After each cued trial both
    are scored on their best guess, made before the answer was known. The agent takes control when it
    beat the rule over the last WINDOW cued trials, and hands control back if it falls behind again."""

    def __init__(self, path, n_ch):
        self.path, self.n_ch = path, n_ch
        self.agent = Agent(n_ch)
        self.rule_w = peak_prior(n_ch)
        self.rule_hits, self.agent_hits = [], []
        self._last_leader = "rule"
        self.is_new = not os.path.exists(path)
        if not self.is_new:
            self._load()

    def leader(self):
        r, a = self.rule_hits[-WINDOW:], self.agent_hits[-WINDOW:]
        if len(a) < WINDOW:
            return "rule"
        if sum(a) >= sum(r) + TAKEOVER_MARGIN:
            return "agent"
        return "agent" if self._last_leader == "agent" and sum(a) >= sum(r) else "rule"

    def step(self, Phi, target=None, save=True):
        rule = int(np.argmax(Phi @ self.rule_w))
        best, probs = self.agent.pick(Phi, explore=False)
        who = self.leader()                         # decided before the answer is known
        self._last_leader = who
        pick = best if who == "agent" else rule
        sc = Phi @ (self.agent.mean() if who == "agent" else self.rule_w)
        top2 = np.sort(sc)[-2:]
        res = {"pick": pick, "rule": rule, "agent": best, "decider": who,
               "agent_conf": round(float(probs[best]), 2), "gap": round(float(top2[1] - top2[0]), 3)}
        if target is not None:
            self.rule_hits.append(int(rule == target))
            self.agent_hits.append(int(best == target))
            a, _ = self.agent.pick(Phi, explore=True)      # exploratory action the agent learns from
            self.agent.update(Phi[a], a == target)
            res["learned_from"] = a
            if save:
                self.save()
        return res

    def stats(self):
        r, a = self.rule_hits[-WINDOW:], self.agent_hits[-WINDOW:]
        roll = lambda h: [round(float(np.mean(h[max(0, i - WINDOW + 1):i + 1])), 2) for i in range(len(h))][-80:]
        return {"leader": self.leader(), "window": WINDOW, "margin": TAKEOVER_MARGIN, "n_window": len(a), "rule_window": sum(r), "agent_window": sum(a),
                "n_all": len(self.agent_hits), "rule_all": sum(self.rule_hits), "agent_all": sum(self.agent_hits),
                "updates": self.agent.n, "rule_curve": roll(self.rule_hits), "agent_curve": roll(self.agent_hits),
                "channels": self.n_ch}

    def reset(self):
        self.agent = Agent(self.n_ch)
        self.rule_hits, self.agent_hits = [], []
        self._last_leader = "rule"
        self.save()

    def save(self):
        ag = self.agent
        tmp = self.path + ".tmp.npz"
        np.savez(tmp, A=ag.A, b=ag.b, m0=ag.m0, rewards=np.array(ag.rewards, int),
                 rule_hits=np.array(self.rule_hits, int), agent_hits=np.array(self.agent_hits, int),
                 meta=np.array(json.dumps({"n_ch": self.n_ch, "prior": ag.prior, "lam": ag.lam, "v": ag.v, "n": ag.n,
                                           "saved": time.strftime("%Y-%m-%d %H:%M:%S")})))
        os.replace(tmp, self.path)

    def _load(self):
        d = np.load(self.path)
        m = json.loads(str(d["meta"]))
        ag = Agent(m["n_ch"], m["prior"], m["lam"], m["v"])
        ag.A, ag.b, ag.m0, ag.n = d["A"], d["b"], d["m0"], m["n"]
        ag.rewards = d["rewards"].tolist()
        self.agent = ag
        self.rule_hits, self.agent_hits = d["rule_hits"].tolist(), d["agent_hits"].tolist()
