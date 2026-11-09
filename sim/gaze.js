import { solveLinear } from "./linalg.js";

// Webcam eye tracker with a saved per-person face model.
//
// MediaPipe Face Landmarker gives 478 face points in 3D (both irises included) for every webcam frame.
// Each person's profile holds:
//   - a 3D model of the rigid parts of their face (forehead, brows, nose, eye corners, cheekbones,
//     temples; not the mouth, jaw or eyelids). Every frame it's fitted to the live points, which gives
//     the head's position and rotation; talking and blinking don't move it.
//   - their gaze mapping: each iris measured against its own eye corners (same depth, so head turns
//     barely distort it), plus the head pose from the face model, mapped to a point on the screen by
//     a ridge regression. Calibration has the person keep their eyes on a dot while making one kind
//     of head movement per dot (turn, slide sideways, nod, slide up/down, lean in/out), so it learns
//     what each does. (In a simulated head, mixing them in one movement left the tracker unable to
//     tell a turn from a sideways lean: 88-181 px off; separated: 11-22 px.)
// The profile is calibrated once (about 45 s) and saved; later sessions load it and only re-align
// on one dot. Positions are kept in screen pixels, so moving the window doesn't break it.
// "Away": no face, the head turned well outside what calibration saw, or the gaze off the window.
// "Talking": the jaw has been opening in the last moment (from MediaPipe's jaw score).
//
// The library and face model load from jsDelivr / Google on first use (internet needed once).

const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21";
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const EYES = [
  { iris: 468, outer: 33, inner: 133, top: 159, bottom: 145 }, // the person's right eye
  { iris: 473, outer: 263, inner: 362, top: 386, bottom: 374 }, // the person's left eye
];
// Rigid face points (MediaPipe indices): forehead, nose bridge and tip, brows, eye corners, cheekbones, temples.
const RIGID = [10, 151, 9, 8, 168, 6, 197, 195, 5, 4, 1, 33, 133, 263, 362, 70, 105, 300, 334, 116, 345, 234, 454, 127, 356];
// Inputs to the gaze mapping, and the smallest spread each is scaled by (the head hardly moves
// during the still dots; scaling by that tiny spread would make later head moves look enormous).
// right eye along / up / open, left eye along / up / open (vs its own corners), MediaPipe look left-right / up-down,
// head turn / nod / tilt, head x / y in the frame, head size (distance).
const MIN_SPREAD = [0.03, 0.02, 0.03, 0.03, 0.02, 0.03, 0.08, 0.08, 0.04, 0.04, 0.04, 0.02, 0.02, 0.03];
const HEAD_TURN = [8, 9]; // head turn and nod: turned well past what calibration saw = looking away
const MAX_Z = 3; // inputs further out than this many spreads are clamped
const AWAY_Z = 4; // head turned this many spreads past what calibration saw = looking away
const AWAY_MARGIN = 0.12; // gaze this far outside the window (share of its size) = looking away
const SMOOTH = 0.3; // share of each new estimate in the shown point
const MEDIAN_OF = 5; // frames: one bad frame can't fling the point
const TALK_JAW = 0.12; // MediaPipe jawOpen above this in the last TALK_MS = talking
const TALK_MS = 800;
const PROFILE_VERSION = 1;

// ---------------------------------------------------------------- small linear algebra
function jacobiEigen(A) {
  const n = A.length;
  const a = A.map((r) => r.slice());
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep += 1) {
    let off = 0;
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) off += a[i][j] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((r, i) => r[i]), vectors: v };
}

// Rotation R, scale s, translation t with points ≈ s R template + t (Horn's quaternion method).
// template: centred [x,y,z] rows; points: same rows, live.
export function fitPose(template, points) {
  const n = points.length;
  const c = [0, 0, 0];
  points.forEach((p) => p.forEach((v, k) => (c[k] += v / n)));
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let tt = 0;
  template.forEach((t, i) => {
    const p = points[i];
    for (let a = 0; a < 3; a += 1) for (let b = 0; b < 3; b += 1) S[a][b] += t[a] * (p[b] - c[b]);
    tt += t[0] * t[0] + t[1] * t[1] + t[2] * t[2];
  });
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const { values, vectors } = jacobiEigen(N);
  const k = values.indexOf(Math.max(...values));
  const [w, x, y, z] = vectors.map((row) => row[k]);
  const R = [
    [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
  ];
  let num = 0;
  template.forEach((t, i) => {
    const r = [0, 1, 2].map((a) => R[a][0] * t[0] + R[a][1] * t[1] + R[a][2] * t[2]);
    num += r[0] * (points[i][0] - c[0]) + r[1] * (points[i][1] - c[1]) + r[2] * (points[i][2] - c[2]);
  });
  return { R, s: num / tt, t: c };
}

// ---------------------------------------------------------------- gaze mapping (ridge regression)
export function predictGaze(m, f, withOffset = true) {
  let x = m.wx[0];
  let y = m.wy[0];
  f.forEach((v, i) => {
    const z = Math.max(-MAX_Z, Math.min(MAX_Z, (v - m.mean[i]) / m.std[i]));
    x += m.wx[i + 1] * z;
    y += m.wy[i + 1] * z;
  });
  return withOffset ? { x: x + m.offset[0], y: y + m.offset[1] } : { x, y };
}

// samples: [{ f, x, y }] (x, y in screen pixels)
export function fitGaze(samples) {
  const d = samples[0].f.length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const { f } of samples) f.forEach((v, i) => (mean[i] += v / samples.length));
  for (const { f } of samples) f.forEach((v, i) => (std[i] += (v - mean[i]) ** 2 / samples.length));
  std.forEach((v, i) => (std[i] = Math.max(Math.sqrt(v), MIN_SPREAD[i] ?? 0.01)));
  const rows = samples.map(({ f }) => [1, ...f.map((v, i) => Math.max(-MAX_Z, Math.min(MAX_Z, (v - mean[i]) / std[i])))]);
  const A = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
  const bx = new Array(d + 1).fill(0);
  const by = new Array(d + 1).fill(0);
  rows.forEach((r, k) => {
    for (let i = 0; i <= d; i += 1) {
      bx[i] += r[i] * samples[k].x;
      by[i] += r[i] * samples[k].y;
      for (let j = 0; j <= d; j += 1) A[i][j] += r[i] * r[j];
    }
  });
  const lambda = 0.05 * samples.length;
  for (let i = 1; i <= d; i += 1) A[i][i] += lambda;
  const wx = solveLinear(A, bx);
  const wy = solveLinear(A, by);
  return wx && wy ? { mean, std, wx, wy, offset: [0, 0] } : null;
}

// ---------------------------------------------------------------- cleaning up calibration frames
const DOT_MS = 2200; // how long each still dot stays up
const DOT_SETTLE_MS = 800; // frames from before this are ignored: the eyes are still getting there
const BLINK_GAP_MS = 120; // no usable frame for this long = a blink or a lost face (or 3 frame times, if slower)
const BLINK_GUARD_MS = 120; // eyelids are part closed around a blink, so frames this close to one go too
const OUTLIER_Z = 4; // a frame this many spreads from the dot's typical value...
const OUTLIER_FEATURES = 2; // ...on this many inputs is dropped (eyes moving shift several together; one can just be jitter)

// Drops the frames right before and after a gap in the frames. Samples need t (ms).
export function dropBlinkEdges(samples) {
  if (samples.length < 3) return samples;
  const steps = samples.slice(1).map((s, i) => s.t - samples[i].t).sort((a, b) => a - b);
  const limit = Math.max(BLINK_GAP_MS, 3 * steps[steps.length >> 1]);
  const gaps = [];
  for (let i = 1; i < samples.length; i += 1) if (samples[i].t - samples[i - 1].t > limit) gaps.push([samples[i - 1].t, samples[i].t]);
  return samples.filter((s) => !gaps.some(([a, b]) => s.t >= a - BLINK_GUARD_MS && s.t <= b + BLINK_GUARD_MS));
}

// One still dot's frames without blink edges and frames that disagree with the rest (a glance away,
// eyes not settled). The eyes should be still here, so "typical" is the median of each input.
export function cleanDot(samples) {
  const clear = dropBlinkEdges(samples);
  if (clear.length < 5) return clear;
  const median = (values) => values.slice().sort((a, b) => a - b)[values.length >> 1];
  const d = clear[0].f.length;
  const mid = [];
  const spread = [];
  for (let i = 0; i < d; i += 1) {
    const values = clear.map((s) => s.f[i]);
    mid[i] = median(values);
    spread[i] = Math.max(1.4826 * median(values.map((v) => Math.abs(v - mid[i]))), 0.1 * (MIN_SPREAD[i] ?? 0.01));
  }
  return clear.filter((s) => s.f.filter((v, i) => Math.abs(v - mid[i]) / spread[i] > OUTLIER_Z).length < OUTLIER_FEATURES);
}

// ---------------------------------------------------------------- is a calibration good enough?
export const GOOD_ERROR_PX = 175; // median error a profile must reach (about 12% of a laptop screen's width)
const WORST_DOT_FACTOR = 2; // and no single dot may be off by more than this many times that
const MIN_DOT_SAMPLES = 10; // a dot with fewer clear frames than this has to be redone
const MIN_DOTS = 7; // the fit needs at least this many usable dots
const DOTS_PER_ROUND = 3; // dots redone per round before scoring again

// dots: Map of dot id -> its samples. Each dot's error is predicted from a fit made without it, so it's
// an honest error, not how well the fit remembers its own data. A dot that can't be judged counts as
// Infinity. Returns { fitted, errors (Map id -> px), medianPx, worstPx }.
export function calibrationErrors(dots, head = []) {
  const usable = [...dots].filter(([, samples]) => samples.length >= MIN_DOT_SAMPLES);
  const errors = new Map([...dots.keys()].map((id) => [id, Infinity]));
  const fitted = usable.length >= MIN_DOTS ? fitGaze([...usable.flatMap(([, samples]) => samples), ...head]) : null;
  if (!fitted) return { fitted: null, errors, medianPx: Infinity, worstPx: Infinity };
  for (const [id, mine] of usable) {
    const m = fitGaze([...usable.filter(([other]) => other !== id).flatMap(([, samples]) => samples), ...head]);
    if (!m) continue;
    const p = mine.map((s) => predictGaze(m, s.f, false));
    errors.set(id, Math.hypot(p.reduce((a, q) => a + q.x, 0) / p.length - mine[0].x, p.reduce((a, q) => a + q.y, 0) / p.length - mine[0].y));
  }
  const sorted = [...errors.values()].sort((a, b) => a - b);
  return { fitted, errors, medianPx: sorted[Math.floor(sorted.length / 2)], worstPx: sorted[sorted.length - 1] };
}

export const calibrationGood = ({ fitted, medianPx, worstPx }, goodPx = GOOD_ERROR_PX) =>
  Boolean(fitted) && medianPx <= goodPx && worstPx <= WORST_DOT_FACTOR * goodPx;

// Keeps sending the person back to the dots that are off until the calibration is good. There's no
// limit on rounds: retake rejects (Esc) to give up, and then nothing is saved.
// retake(ids, result, round) resolves to a Map of id -> new samples, which replace the old ones
// (a bad dot's old samples are what's wrong, so they aren't kept).
export async function refineCalibration({ dots, head = [], goodPx = GOOD_ERROR_PX, retake }) {
  for (let round = 1; ; round += 1) {
    const result = calibrationErrors(dots, head);
    if (calibrationGood(result, goodPx)) return { ...result, rounds: round };
    // Dots with too few clear frames first. Then the worst few: one bad dot skews every other dot's
    // score, so most of the rest often look bad only because of it, and get better once it's redone.
    const short = [...dots].filter(([, samples]) => samples.length < MIN_DOT_SAMPLES).map(([id]) => id);
    const ids = short.length ? short : [...result.errors].filter(([, px]) => px > goodPx)
      .sort((a, b) => b[1] - a[1]).slice(0, DOTS_PER_ROUND).map(([id]) => id);
    const fresh = await retake(ids, result, round);
    for (const id of ids) dots.set(id, fresh.get(id) ?? []);
  }
}

// Gaze inputs from one frame (MediaPipe landmarks L, frame W x H, blendshape scores), given the face model.
export function gazeInputs(template, L, W, H, score) {
  const { R, s, t } = fitPose(template, RIGID.map((i) => [L[i].x * W, L[i].y * H, L[i].z * W]));
  const P = (i) => [L[i].x * W, L[i].y * H];
  // Eye axes from the line through both outer eye corners, so a tilted head doesn't read as looking up.
  const [ra, la] = [P(33), P(263)];
  const span = Math.hypot(la[0] - ra[0], la[1] - ra[1]) || 1;
  const ax = [(la[0] - ra[0]) / span, (la[1] - ra[1]) / span];
  const ay = [-ax[1], ax[0]];
  const f = [];
  for (const eye of EYES) {
    const o = P(eye.outer), n = P(eye.inner), c = P(eye.iris), tp = P(eye.top), b = P(eye.bottom);
    const w = Math.hypot(n[0] - o[0], n[1] - o[1]) || 1;
    const dx = c[0] - (o[0] + n[0]) / 2;
    const dy = c[1] - (o[1] + n[1]) / 2;
    f.push((dx * ax[0] + dy * ax[1]) / w, (dx * ay[0] + dy * ay[1]) / w, Math.hypot(b[0] - tp[0], b[1] - tp[1]) / w);
  }
  const sc = (name) => score[name] ?? 0;
  f.push(
    (sc("eyeLookOutLeft") + sc("eyeLookInRight") - sc("eyeLookInLeft") - sc("eyeLookOutRight")) / 2,
    (sc("eyeLookUpLeft") + sc("eyeLookUpRight") - sc("eyeLookDownLeft") - sc("eyeLookDownRight")) / 2,
    R[0][2], R[1][2], R[1][0], t[0] / W, t[1] / H, s,
  );
  return f;
}

// The face model: the average shape of the rigid points over a few still frames, centred.
export function faceModel(sets) {
  const centred = sets.map((pts) => {
    const c = [0, 1, 2].map((k) => pts.reduce((a, p) => a + p[k], 0) / pts.length);
    return pts.map((p) => p.map((v, k) => v - c[k]));
  });
  return centred[0].map((_, i) => [0, 1, 2].map((k) => centred.reduce((a, pts) => a + pts[i][k], 0) / centred.length));
}

// Where this window's content starts on the screen, so the mapping can live in screen pixels.
const origin = () => ({ x: window.screenX + (window.outerWidth - window.innerWidth) / 2, y: window.screenY + (window.outerHeight - window.innerHeight) });

export { RIGID, EYES };

export function createGazeTracker({ goodErrorPx = GOOD_ERROR_PX } = {}) {
  let landmarker = null;
  let video = null;
  let running = false;
  let face = false;
  let rigid = null; // latest rigid face points (px, 3D), for building a face model
  let feat = null; // latest gaze inputs, or null (no face, blink, or no face model yet)
  let frames = 0;
  let template = null; // the person's face model: centred rigid points
  let model = null; // gaze mapping { mean, std, wx, wy, offset }, screen pixels
  let profileMeta = null; // { person, screen, errorPx, saved }
  let screenPoint = null; // smoothed gaze, screen pixels
  let away = true;
  let lastJawOpen = -1e9; // when the jaw was last open (talking)
  const recent = []; // raw estimates of the last 3 s: { t, x, y } (screen pixels)
  let lastVideoTime = -1;
  // Tracking quality, for switching to the headset's eye glances when the webcam can't keep up.
  // brightness: mean brightness (0-255) of a tiny copy of the webcam image, a few times a second.
  // jitter: median jump between consecutive raw gaze estimates over the last second, in px. A look
  // from one cube to another is one big jump (the median ignores it); poor tracking jumps every frame.
  // Both are judged against what they were at the last calibration or re-centre, not fixed numbers,
  // since every webcam and room differs.
  const tiny = document.createElement("canvas");
  tiny.width = 32;
  tiny.height = 24;
  const tinyCtx = tiny.getContext("2d", { willReadFrequently: true });
  let brightness = null;
  let lastBrightness = 0;
  let refBrightness = null;
  let refJitter = null;

  async function start(preview) {
    if (running) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false });
    video = document.createElement("video");
    Object.assign(video, { muted: true, playsInline: true, autoplay: true, srcObject: stream });
    preview?.append(video);
    await video.play();
    const { FaceLandmarker, FilesetResolver } = await import(`${MP}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true,
    });
    try {
      landmarker = await FaceLandmarker.createFromOptions(files, options("GPU"));
    } catch {
      landmarker = await FaceLandmarker.createFromOptions(files, options("CPU"));
    }
    running = true;
    loop();
  }

  function loop() {
    if (!running) return;
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const now = performance.now();
      update(landmarker.detectForVideo(video, now));
      if (now - lastBrightness > 250) {
        lastBrightness = now;
        measureBrightness();
      }
    }
    requestAnimationFrame(loop);
  }

  const cameraSize = () => (video?.videoWidth ? { w: video.videoWidth, h: video.videoHeight } : null);

  function measureBrightness() {
    tinyCtx.drawImage(video, 0, 0, tiny.width, tiny.height);
    const d = tinyCtx.getImageData(0, 0, tiny.width, tiny.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    brightness = sum / (d.length / 4);
  }

  // Median jump between consecutive points ({ x, y }), or null if there are too few.
  function medianJump(points) {
    if (points.length < 6) return null;
    const jumps = [];
    for (let i = 1; i < points.length; i += 1) jumps.push(Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    jumps.sort((a, b) => a - b);
    return jumps[Math.floor(jumps.length / 2)];
  }
  const jitter = () => medianJump(recent.filter((p) => p.t >= performance.now() - 1000));

  function update(result) {
    const L = result.faceLandmarks?.[0];
    face = Boolean(L);
    frames += 1;
    if (!L) {
      feat = null;
      rigid = null;
      screenPoint = null;
      away = true;
      return;
    }
    const W = video.videoWidth;
    const H = video.videoHeight;
    const score = {};
    for (const c of result.faceBlendshapes?.[0]?.categories ?? []) score[c.categoryName] = c.score;
    const now = performance.now();
    if ((score.jawOpen ?? 0) > TALK_JAW) lastJawOpen = now;
    rigid = RIGID.map((i) => [L[i].x * W, L[i].y * H, L[i].z * W]);
    if (!template) {
      feat = null;
      return;
    }
    const f = gazeInputs(template, L, W, H, score);
    const blink = ((score.eyeBlinkLeft ?? 0) + (score.eyeBlinkRight ?? 0)) / 2 > 0.45;
    feat = blink ? null : f;
    if (!model) return;
    const headOut = HEAD_TURN.some((i) => Math.abs((f[i] - model.mean[i]) / model.std[i]) > AWAY_Z);
    if (feat) {
      const raw = predictGaze(model, feat);
      recent.push({ t: now, ...raw });
      while (recent.length && recent[0].t < now - 3000) recent.shift();
      const last = recent.slice(-MEDIAN_OF);
      const med = (k) => last.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(last.length / 2)];
      const steady = { x: med("x"), y: med("y") };
      screenPoint = screenPoint ? { x: screenPoint.x + SMOOTH * (steady.x - screenPoint.x), y: screenPoint.y + SMOOTH * (steady.y - screenPoint.y) } : steady;
    }
    const p = windowPoint();
    const offWindow = p && (p.x < -AWAY_MARGIN * innerWidth || p.x > (1 + AWAY_MARGIN) * innerWidth ||
      p.y < -AWAY_MARGIN * innerHeight || p.y > (1 + AWAY_MARGIN) * innerHeight);
    away = headOut || !p || offWindow;
  }

  const windowPoint = () => {
    if (!screenPoint) return null;
    const o = origin();
    return { x: screenPoint.x - o.x, y: screenPoint.y - o.y };
  };

  // ---------------------------------------------------------------- calibration dots
  // steps: [{ x, y, ms, settle, text, kind }] in window pixels. kind "face" collects rigid points
  // (for the face model), "still"/"head" collect gaze inputs. Rejects on Esc.
  async function runDots(canvas, steps) {
    const ctx = canvas.getContext("2d");
    const ratio = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.round(window.innerWidth * ratio);
    canvas.height = Math.round(window.innerHeight * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    let aborted = false;
    const onKey = (event) => {
      if (event.key === "Escape") aborted = true;
    };
    window.addEventListener("keydown", onKey);
    const samples = [];
    const draw = (step, k, index) => {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.fillStyle = "rgba(10, 12, 16, 0.85)";
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.fillStyle = "#f1f2f4";
      ctx.font = "600 18px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${step.text}  (${index + 1} of ${steps.length})`, window.innerWidth / 2, 40);
      const head = step.kind === "head";
      ctx.beginPath();
      ctx.arc(step.x, step.y, head ? 14 + 6 * Math.sin(k * Math.PI * 6) : 6 + 26 * (1 - k), 0, Math.PI * 2);
      ctx.strokeStyle = head ? "#7aa2ff" : "#ffcf6e";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(step.x, step.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = head ? "#7aa2ff" : "#ffcf6e";
      ctx.fill();
    };
    try {
      for (const [index, step] of steps.entries()) {
        const start = performance.now();
        let seen = frames;
        for (;;) {
          if (aborted) throw new Error("cancelled");
          const t = performance.now() - start;
          if (t >= step.ms) break;
          draw(step, t / step.ms, index);
          if (t > step.settle && frames !== seen) {
            const o = origin();
            if (step.kind === "face" && rigid) samples.push({ kind: "face", rigid: rigid.map((p) => p.slice()) });
            else if (step.kind !== "face" && feat) samples.push({ kind: step.kind, f: feat.slice(), x: step.x + o.x, y: step.y + o.y, k: index, t: performance.now() });
          }
          seen = frames;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }
      return samples;
    } finally {
      window.removeEventListener("keydown", onKey);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  // Full profile (about 45 s): face model (2.6 s), 9 still dots, then 5 dots held while making one head movement each.
  async function calibrateProfile(canvas, rect, person) {
    if (!running) throw new Error("eye tracker not started");
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const faceSamples = await runDots(canvas, [{ x: cx, y: cy, ms: 2600, settle: 600, kind: "face",
      text: "Making a model of your face: look at the dot and keep still" }]);
    if (faceSamples.length < 15) return { ok: false, reason: face ? "too few clear frames" : "no face in the webcam" };
    template = averageFace(faceSamples.map((s) => s.rigid));
    model = null;
    const grid = [];
    for (const fy of [0.08, 0.5, 0.92]) for (const fx of [0.08, 0.5, 0.92]) grid.push([rect.left + fx * rect.width, rect.top + fy * rect.height]);
    const order = [4, ...[0, 1, 2, 3, 5, 6, 7, 8].sort(() => Math.random() - 0.5)];
    const still = order.map((i) => ({ x: grid[i][0], y: grid[i][1], ms: DOT_MS, settle: DOT_SETTLE_MS, kind: "still",
      text: "Look at each dot until it shrinks. Keep your head still." }));
    const moving = [
      [0.5, 0.5, "slowly turn your head left and right"],
      [0.15, 0.5, "slide your head side to side (lean, don't turn)"],
      [0.85, 0.5, "slowly nod up and down"],
      [0.5, 0.15, "sit up taller, then lower (move your head up and down)"],
      [0.5, 0.85, "lean in towards the screen, then back"],
    ].map(([fx, fy, how]) => ({ x: rect.left + fx * rect.width, y: rect.top + fy * rect.height, ms: 5000, settle: 400,
      kind: "head", text: `Eyes on the blue dot: ${how}` }));
    const samples = await runDots(canvas, [...still, ...moving]);
    const dots = new Map(order.map((id) => [id, []]));
    for (const sample of samples) if (sample.kind === "still") dots.get(order[sample.k]).push(sample);
    for (const [id, frames] of dots) dots.set(id, cleanDot(frames));
    // The head moves on purpose during these dots, so only blink edges go. Each dot on its own: the gap between dots isn't a blink.
    const headSamples = moving.flatMap((_, m) => dropBlinkEdges(samples.filter((s) => s.kind === "head" && s.k === still.length + m))).filter((_, i) => i % 2 === 0);
    if (![...dots.values()].some((d) => d.length)) {
      template = null;
      return { ok: false, reason: face ? "too few clear looks (blinking, or the face was lost)" : "no face in the webcam" };
    }
    // Not good enough: back to the dots that are off, until it is. Esc gives up (nothing is saved).
    const result = await refineCalibration({
      dots,
      head: headSamples,
      goodPx: goodErrorPx,
      retake: async (ids, { medianPx }, round) => {
        const how = Number.isFinite(medianPx) ? `Off by ${Math.round(medianPx)} px, needs ${goodErrorPx}.` : "Some dots weren't clear.";
        const tip = round >= 3 ? " Light on your face, no window behind you, same distance." : "";
        const steps = ids.map((id) => ({ x: grid[id][0], y: grid[id][1], ms: DOT_MS, settle: DOT_SETTLE_MS, kind: "still",
          text: `${how} Look at each dot again, head still.${tip} (Esc gives up)` }));
        const fresh = new Map(ids.map((id) => [id, []]));
        for (const sample of await runDots(canvas, steps)) fresh.get(ids[sample.k]).push(sample);
        for (const [id, frames] of fresh) fresh.set(id, cleanDot(frames));
        return fresh;
      },
    });
    model = result.fitted;
    screenPoint = null;
    const errorPx = Math.round(result.medianPx);
    profileMeta = { person, screen: { w: screen.width, h: screen.height }, camera: cameraSize(), errorPx, saved: new Date().toISOString() };
    refBrightness = brightness;
    return { ok: true, errorPx, rounds: result.rounds };
  }

  const averageFace = faceModel;
  // One dot in the middle: shifts the whole mapping so it lines up again (a new session, a head move).
  async function recenter(canvas, rect) {
    if (!model) throw new Error("calibrate first");
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const samples = await runDots(canvas, [{ x, y, ms: 1600, settle: 500, kind: "still", text: "Look at the dot" }]);
    if (samples.length < 8) return { ok: false, reason: "no clear look at the dot" };
    const p = samples.map((s) => predictGaze(model, s.f, false));
    model.offset = [samples[0].x - p.reduce((a, q) => a + q.x, 0) / p.length, samples[0].y - p.reduce((a, q) => a + q.y, 0) / p.length];
    refBrightness = brightness; // this session's lighting
    refJitter = medianJump(p); // how much the estimate jumps while the eyes are still on one dot
    screenPoint = null;
    return { ok: true, shiftPx: Math.round(Math.hypot(...model.offset)) };
  }

  function meanSince(t0) {
    const r = recent.filter((p) => p.t >= t0);
    if (r.length < 3) return null;
    return { x: r.reduce((a, p) => a + p.x, 0) / r.length, y: r.reduce((a, p) => a + p.y, 0) / r.length };
  }

  // Drift correction: the person was really looking at `truth` (window pixels) while the tracker
  // said `seen` (screen pixels, from meanSince). Shifts the mapping part of the way there.
  function correct(truth, seen, weight = 0.5, maxPx = 150) {
    if (!model || !seen) return 0;
    const o = origin();
    let dx = (truth.x + o.x - seen.x) * weight;
    let dy = (truth.y + o.y - seen.y) * weight;
    const size = Math.hypot(dx, dy);
    if (size > maxPx) {
      dx *= maxPx / size;
      dy *= maxPx / size;
    }
    model.offset = [model.offset[0] + dx, model.offset[1] + dy];
    return Math.round(Math.hypot(dx, dy));
  }

  // Saved profiles (plain JSON): the face model and the gaze mapping.
  function exportProfile() {
    if (!template || !model) return null;
    const r = (v) => Math.round(v * 1e5) / 1e5;
    return { version: PROFILE_VERSION, ...profileMeta, template: template.map((p) => p.map(r)),
      model: { mean: model.mean.map(r), std: model.std.map(r), wx: model.wx.map(r), wy: model.wy.map(r), offset: model.offset.map(r) } };
  }

  function importProfile(p) {
    if (!p || p.version !== PROFILE_VERSION || !p.template || !p.model) return { ok: false, reason: "not a profile from this version" };
    if (p.screen && (p.screen.w !== screen.width || p.screen.h !== screen.height)) {
      return { ok: false, reason: `made on a ${p.screen.w}×${p.screen.h} screen, this one is ${screen.width}×${screen.height}` };
    }
    // The face model is in webcam pixels, so it only fits the size it was made at (older profiles: 640x480).
    const madeAt = p.camera ?? { w: 640, h: 480 };
    const now = cameraSize();
    if (now && (madeAt.w !== now.w || madeAt.h !== now.h)) return { ok: false, reason: `made with a ${madeAt.w}×${madeAt.h} webcam image, this one is ${now.w}×${now.h}` };
    if (p.errorPx > goodErrorPx) return { ok: false, reason: `its error is ${p.errorPx} px, it needs to be ${goodErrorPx} or less` };
    template = p.template;
    model = { ...p.model, offset: p.model.offset.slice() };
    profileMeta = { person: p.person, screen: p.screen, camera: madeAt, errorPx: p.errorPx, saved: p.saved };
    screenPoint = null;
    return { ok: true };
  }

  return {
    start,
    calibrateProfile,
    recenter,
    meanSince,
    correct,
    exportProfile,
    importProfile,
    get running() { return running; },
    get calibrated() { return Boolean(model && template); },
    get face() { return face; },
    get point() { return model ? windowPoint() : null; }, // window pixels
    get away() { return !model || away; },
    get talking() { return performance.now() - lastJawOpen < TALK_MS; },
    get profile() { return profileMeta; },
    get camera() { return cameraSize(); }, // { w, h } the webcam actually gives, or null
    // { brightness, refBrightness (0-255), jitter, refJitter (px) }; any can be null (not measured yet).
    get quality() { return { brightness, refBrightness, jitter: jitter(), refJitter }; },
  };
}
