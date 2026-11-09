import { solveLinear } from "../linalg.js";

// The tracker learns each person as they play. Every choice they confirm (and don't cancel) says where
// they were really looking: the middle of what they chose. Pairs of (where the tracker said, where they
// were looking) build up a small correction on top of the tracker: an offset first, then a full affine
// map (stretch, shear, offset) once there are enough pairs. Newer pairs count more, and pairs from
// earlier sessions less (the head sits differently each time). Coordinates are shares of the camera
// view (0-1), so the correction doesn't depend on the window's size. Saved per person.

const MAX_PAIRS = 80;
const AFFINE_AFTER = 8; // pairs needed before the stretch/shear part is fitted (offset only before that)
const RECENCY = 0.94; // weight multiplier per newer pair
const OLD_SESSION = 0.35; // weight of pairs from earlier sessions
const RIDGE = 0.08; // pull of the stretch/shear towards none, relative to the total weight
const MAX_SHIFT = 0.2;

export function createGazeLearning() {
  let pairs = []; // { p: [x, y], t: [x, y], s: session }
  let session = Date.now();
  let A = [[1, 0], [0, 1]];
  let b = [0, 0];

  function weights() {
    return pairs.map((pair, i) => RECENCY ** (pairs.length - 1 - i) * (pair.s === session ? 1 : OLD_SESSION));
  }

  function fit() {
    A = [[1, 0], [0, 1]];
    b = [0, 0];
    if (pairs.length < 2) return;
    const w = weights();
    const W = w.reduce((s, v) => s + v, 0);
    if (pairs.length < AFFINE_AFTER) {
      for (const d of [0, 1]) b[d] = pairs.reduce((s, pair, i) => s + w[i] * (pair.t[d] - pair.p[d]), 0) / W;
    } else {
      // For each output: minimise sum w (a . p + c - t)^2 + RIDGE W |a - e|^2.
      for (const d of [0, 1]) {
        const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        const v = [0, 0, 0];
        pairs.forEach((pair, i) => {
          const x = [pair.p[0], pair.p[1], 1];
          for (let r = 0; r < 3; r += 1) {
            v[r] += w[i] * x[r] * pair.t[d];
            for (let c = 0; c < 3; c += 1) M[r][c] += w[i] * x[r] * x[c];
          }
        });
        for (const r of [0, 1]) {
          M[r][r] += RIDGE * W;
          v[r] += RIDGE * W * (r === d ? 1 : 0);
        }
        const sol = solveLinear(M, v);
        if (!sol) continue;
        A[d] = [sol[0], sol[1]];
        b[d] = sol[2];
      }
      // Keep it sane: mild stretch and shear only.
      for (const d of [0, 1]) {
        A[d][d] = Math.min(1.3, Math.max(0.75, A[d][d]));
        A[d][1 - d] = Math.min(0.25, Math.max(-0.25, A[d][1 - d]));
      }
    }
    b = b.map((v) => Math.min(MAX_SHIFT, Math.max(-MAX_SHIFT, v)));
  }

  const apply = ([x, y]) => [A[0][0] * x + A[0][1] * y + b[0], A[1][0] * x + A[1][1] * y + b[1]];

  // Typical miss (median distance, as a share of the view's width) before and after the correction,
  // over this session's pairs.
  function stats() {
    const mine = pairs.filter((p) => p.s === session);
    const median = (list) => (list.length ? list.sort((a, c) => a - c)[Math.floor(list.length / 2)] : null);
    return {
      pairs: pairs.length,
      session: mine.length,
      rawMiss: median(mine.map((p) => Math.hypot(p.p[0] - p.t[0], p.p[1] - p.t[1]))),
      fixedMiss: median(mine.map((p) => {
        const q = apply(p.p);
        return Math.hypot(q[0] - p.t[0], q[1] - p.t[1]);
      })),
      affine: pairs.length >= AFFINE_AFTER,
    };
  }

  return {
    apply,
    add(p, t) {
      pairs.push({ p, t, s: session });
      if (pairs.length > MAX_PAIRS) pairs = pairs.slice(-MAX_PAIRS);
      fit();
    },
    newSession() {
      session = Date.now();
      fit();
    },
    load(data) {
      pairs = Array.isArray(data?.pairs) ? data.pairs.filter((p) => p.p?.length === 2 && p.t?.length === 2).slice(-MAX_PAIRS) : [];
      fit();
    },
    export: () => ({ version: 1, pairs }),
    stats,
  };
}
