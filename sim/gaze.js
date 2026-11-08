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

export function createGazeTracker() {
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

  async function start(preview) {
    if (running) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
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
      update(landmarker.detectForVideo(video, performance.now()));
    }
    requestAnimationFrame(loop);
  }

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
            else if (step.kind !== "face" && feat) samples.push({ kind: step.kind, f: feat.slice(), x: step.x + o.x, y: step.y + o.y, k: index });
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
    const still = order.map((i) => ({ x: grid[i][0], y: grid[i][1], ms: 1700, settle: 600, kind: "still",
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
    const stillSamples = samples.filter((s) => s.kind === "still");
    const headSamples = samples.filter((s) => s.kind === "head").filter((_, i) => i % 2 === 0);
    if (new Set(stillSamples.map((s) => s.k)).size < 7 || stillSamples.length < 60) {
      template = null;
      return { ok: false, reason: face ? "too few clear looks (blinking, or the face was lost)" : "no face in the webcam" };
    }
    const all = [...stillSamples, ...headSamples];
    const fitted = fitGaze(all);
    if (!fitted) {
      template = null;
      return { ok: false, reason: "could not fit (try again)" };
    }
    // Honest error: predict each still dot from a fit without it.
    const errors = [];
    for (const k of new Set(stillSamples.map((s) => s.k))) {
      const m = fitGaze(all.filter((s) => s.k !== k));
      const mine = stillSamples.filter((s) => s.k === k);
      if (!m || !mine.length) continue;
      const p = mine.map((s) => predictGaze(m, s.f, false));
      errors.push(Math.hypot(p.reduce((a, q) => a + q.x, 0) / p.length - mine[0].x, p.reduce((a, q) => a + q.y, 0) / p.length - mine[0].y));
    }
    errors.sort((a, b) => a - b);
    model = fitted;
    screenPoint = null;
    const errorPx = Math.round(errors[Math.floor(errors.length / 2)] ?? 0);
    profileMeta = { person, screen: { w: screen.width, h: screen.height }, errorPx, saved: new Date().toISOString() };
    return { ok: true, errorPx, samples: all.length };
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
    template = p.template;
    model = { ...p.model, offset: p.model.offset.slice() };
    profileMeta = { person: p.person, screen: p.screen, errorPx: p.errorPx, saved: p.saved };
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
  };
}
