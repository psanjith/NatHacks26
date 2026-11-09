import { calibrate, pixelToPlane, worldToPixel } from "../calibrate.js";
import { HEIGHT, WIDTH, captureFrame, findBlobs } from "../detect.js";
import { solveLinear } from "../linalg.js";
import { BOARD_MARKERS, BOARD_TOP, MARKERS, O_PIECE, TABLE_Z, X_PIECE, cellAt, onBoard } from "./layout.js";

// The table camera reads the pieces from pixels only, like the cube sim: compare the frame with an
// image of the same view without the pieces (the "plate"; on a real camera, a photo of the empty
// table), keep what changed, and group it into blobs. Each blob is then
//   - an X or an O by its colour (red or teal) and, as a check, by its shape (an O has a hole);
//   - placed on the table: its pixels are projected onto the plane of the piece's top half;
//   - for an X, turned: its four arms show up as a fourfold pattern around the centre, and the angle
//     of that pattern (the fourth circular harmonic of the pixels' directions) is the direction of
//     its bars, which only matters modulo 90°;
//   - kept as a pixel mask, which the camera tab draws over the piece.
// Calibration: the mount's four stickers give a first camera pose (../calibrate.js); the board's four
// green corner stickers, near the middle of the image, then refine it (all eight points, least-squares
// reprojection error). Real piece poses are never read here.

const DIFF_THRESHOLD = 26;
const MIN_AREA = 30;
const SHADOW = { minRatio: 0.2, maxChroma: 0.07 };
// Share of a piece's height to project its pixels at. The visible sides pull the centre towards the
// camera; projecting a little below the top face cancels that, by an amount that depends on the shape
// and on this camera's angle (measured: an X came out 1.35 mm too close at 0.6, an O 2 mm too far at 0.4).
const PROJECT_AT = { X: 0.4, O: 0.6 };
const EDGE_PX = 6; // stickers whose centre is this close to the image's edge may be cut off: not used
const MATCH_PX = 30; // a board sticker must be found this close to where the first pose puts it

function isShadow(r, g, b, R, G, B) {
  const lit = R + G + B;
  const now = r + g + b;
  if (now >= lit || lit === 0 || now === 0) return false;
  if (now / lit < SHADOW.minRatio) return false;
  const chroma = Math.abs(r / now - R / lit) + Math.abs(g / now - G / lit) + Math.abs(b / now - B / lit);
  return chroma < SHADOW.maxChroma;
}

function morph(mask, op) {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < HEIGHT - 1; y += 1) {
    for (let x = 1; x < WIDTH - 1; x += 1) {
      const p = y * WIDTH + x;
      const n = mask[p] + mask[p - 1] + mask[p + 1] + mask[p - WIDTH] + mask[p + WIDTH];
      out[p] = op === "erode" ? (n === 5 ? 1 : 0) : (n > 0 ? 1 : 0);
    }
  }
  return out;
}

function colourKind(r, g, b) {
  const sum = r + g + b || 1;
  const [cr, cg, cb] = [r / sum, g / sum, b / sum];
  if (cr > 0.5 && cg < 0.3) return "X";
  if (cr < 0.24 && cb > 0.3 && cg > 0.28) return "O";
  return null;
}

const isGreen = (r, g, b) => g > 70 && r < 0.62 * g && b < 0.62 * g;

// ---------------------------------------------------------------- calibration refinement
// Rotation vector -> 3x3 matrix (Rodrigues), as rows.
function rodrigues([wx, wy, wz]) {
  const th = Math.hypot(wx, wy, wz);
  if (th < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = [wx / th, wy / th, wz / th];
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}
const mul = (M, v) => M.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

// Least-squares camera pose from world points and their pixels, starting from cal (K, R, t as in
// calibrate.js: R[k] is world axis k in camera coordinates). Turns the camera about its own centre
// (rotation vector w) and shifts it (d): c' = Rot(w) c + d.
function refinePose(cal, points) {
  const { K } = cal;
  let R = cal.R.map((col) => col.slice());
  let t = cal.t.slice();
  const project = (Rm, tv, X) => {
    const c = [0, 1, 2].map((i) => X[0] * Rm[0][i] + X[1] * Rm[1][i] + X[2] * Rm[2][i] + tv[i]);
    return [K.f * c[0] / c[2] + K.cx, K.f * c[1] / c[2] + K.cy];
  };
  const apply = (p) => {
    const Q = rodrigues(p.slice(0, 3));
    return { R: R.map((col) => mul(Q, col)), t: mul(Q, t).map((v, i) => v + p[3 + i]) };
  };
  const residual = (p) => {
    const m = apply(p);
    return points.flatMap(({ X, uv }) => {
      const q = project(m.R, m.t, X);
      return [q[0] - uv[0], q[1] - uv[1]];
    });
  };
  for (let it = 0; it < 20; it += 1) {
    const zero = [0, 0, 0, 0, 0, 0];
    const r = residual(zero);
    const J = zero.map((_, j) => {
      const p = zero.slice();
      p[j] += 1e-6;
      return residual(p).map((v, k) => (v - r[k]) / 1e-6);
    });
    const A = J.map((a, i) => J.map((b, j) => a.reduce((s, v, k) => s + v * b[k], 0) + (i === j ? 1e-6 : 0)));
    const g = J.map((a) => -a.reduce((s, v, k) => s + v * r[k], 0));
    const step = solveLinear(A, g);
    if (!step) break;
    const m = apply(step);
    R = m.R;
    t = m.t;
    if (Math.hypot(...step) < 1e-9) break;
  }
  const r = residual([0, 0, 0, 0, 0, 0]);
  const rms = Math.sqrt(r.reduce((s, v) => s + v * v, 0) / points.length);
  const center = [0, 1, 2].map((i) => -(R[i][0] * t[0] + R[i][1] * t[1] + R[i][2] * t[2]));
  return { ...cal, R, t, center, rmsPx: rms };
}

export function createVision({ renderer, scene, camera, pieces, hide = [], clearForCalibration = [] }) {
  let calibration = null;

  function capture() {
    const hidden = hide.filter((o) => o.visible);
    hidden.forEach((o) => (o.visible = false));
    const frame = captureFrame(renderer, scene, camera);
    pieces.visible = false;
    const plate = captureFrame(renderer, scene, camera);
    pieces.visible = true;
    hidden.forEach((o) => (o.visible = true));
    return { frame: frame.data, plate: plate.data };
  }

  // Calibrates with the table cleared (no pieces, nobody sitting there): teal pieces or a teal suit
  // would pass for the cyan sticker.
  function calibrateCamera() {
    const cleared = [pieces, ...hide, ...clearForCalibration].filter((o) => o.visible);
    cleared.forEach((o) => (o.visible = false));
    const image = captureFrame(renderer, scene, camera);
    cleared.forEach((o) => (o.visible = true));
    const first = calibrate(image, camera.fov);
    if (!first.ok) return (calibration = first);
    // The mount's stickers that aren't cut off by the image's edge...
    const points = [];
    first.markers.forEach((m, i) => {
      if (m.u > EDGE_PX && m.u < WIDTH - EDGE_PX && m.v > EDGE_PX && m.v < HEIGHT - EDGE_PX) points.push({ X: [MARKERS[i].x, MARKERS[i].y, 0], uv: [m.u, m.v] });
    });
    // ...and the board's green stickers, matched to where the first pose expects them.
    const green = new Uint8Array(WIDTH * HEIGHT);
    for (let p = 0; p < WIDTH * HEIGHT; p += 1) if (isGreen(image.data[p * 4], image.data[p * 4 + 1], image.data[p * 4 + 2])) green[p] = 1;
    const blobs = findBlobs(green, WIDTH, HEIGHT, 4).map((pts) => {
      let u = 0, v = 0;
      for (let i = 0; i < pts.length; i += 2) { u += pts[i]; v += pts[i + 1]; }
      return { u: (u * 2) / pts.length + 0.5, v: (v * 2) / pts.length + 0.5 };
    });
    let matched = 0;
    for (const m of BOARD_MARKERS) {
      const [pu, pv] = worldToPixel(first, m.x, m.y, BOARD_TOP);
      const near = blobs.map((b) => ({ b, d: Math.hypot(b.u - pu, b.v - pv) })).sort((a, b) => a.d - b.d)[0];
      if (near && near.d < MATCH_PX) {
        points.push({ X: [m.x, m.y, BOARD_TOP], uv: [near.b.u, near.b.v] });
        matched += 1;
      }
    }
    calibration = points.length >= 5 ? { ...refinePose(first, points), points: points.length, boardStickers: matched } : first;
    return calibration;
  }

  function measureBlob(points, frame, mask) {
    let r = 0, g = 0, b = 0, su = 0, sv = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const n = points.length / 2;
    for (let i = 0; i < points.length; i += 2) {
      const x = points[i], y = points[i + 1];
      const p = (y * WIDTH + x) * 4;
      r += frame[p]; g += frame[p + 1]; b += frame[p + 2];
      su += x; sv += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const kind = colourKind(r / n, g / n, b / n);
    if (!kind) return null;
    const cu = su / n + 0.5;
    const cv = sv / n + 0.5;
    const height = kind === "X" ? X_PIECE.height : O_PIECE.height;
    const rough = pixelToPlane(calibration, cu, cv, TABLE_Z + height / 2);
    const surface = onBoard(rough.x, rough.y) ? BOARD_TOP : TABLE_Z;
    const z = surface + height * PROJECT_AT[kind];
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    let mx = 0, my = 0;
    for (let i = 0, k = 0; i < points.length; i += 2, k += 1) {
      const q = pixelToPlane(calibration, points[i] + 0.5, points[i + 1] + 0.5, z);
      xs[k] = q.x;
      ys[k] = q.y;
      mx += q.x;
      my += q.y;
    }
    mx /= n;
    my /= n;
    let re = 0, im = 0;
    for (let k = 0; k < n; k += 1) {
      const dx = xs[k] - mx;
      const dy = ys[k] - my;
      const rr = dx * dx + dy * dy;
      const a = 4 * Math.atan2(dy, dx);
      re += rr * Math.cos(a);
      im += rr * Math.sin(a);
    }
    const centre = Math.round(cv - 0.5) * WIDTH + Math.round(cu - 0.5);
    // The blob's own pixels, cropped to its box, for drawing it.
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const bits = new Uint8Array(w * h);
    for (let i = 0; i < points.length; i += 2) bits[(points[i + 1] - y0) * w + (points[i] - x0)] = 1;
    return {
      kind, x: mx, y: my, yaw: kind === "X" ? Math.atan2(im, re) / 4 : null, area: n, hollow: !mask[centre], surface,
      cell: surface === BOARD_TOP ? cellAt(mx, my, 0.5) : -1,
      pixel: [cu / WIDTH, cv / HEIGHT], // centre in the image, 0-1
      box: [x0 / WIDTH, y0 / HEIGHT, (x1 + 1) / WIDTH, (y1 + 1) / HEIGHT],
      mask: { x: x0, y: y0, w, h, bits, width: WIDTH, height: HEIGHT },
    };
  }

  function detect() {
    if (!calibration?.ok) calibrateCamera();
    if (!calibration.ok) return { ok: false, reason: `calibration: ${calibration.reason}`, pieces: [] };
    const { frame, plate } = capture();
    let mask = new Uint8Array(WIDTH * HEIGHT);
    for (let p = 0; p < WIDTH * HEIGHT; p += 1) {
      const i = p * 4;
      const r = frame[i], g = frame[i + 1], b = frame[i + 2];
      const R = plate[i], G = plate[i + 1], B = plate[i + 2];
      const diff = Math.max(Math.abs(r - R), Math.abs(g - G), Math.abs(b - B));
      if (diff >= DIFF_THRESHOLD && !isShadow(r, g, b, R, G, B)) mask[p] = 1;
    }
    mask = morph(morph(mask, "erode"), "dilate");
    const found = findBlobs(mask, WIDTH, HEIGHT, MIN_AREA).map((points) => measureBlob(points, frame, mask)).filter(Boolean);
    return { ok: true, pieces: found };
  }

  function readBoard(found) {
    const board = Array(9).fill(null);
    for (const piece of found) if (piece.cell >= 0) board[piece.cell] = piece.kind;
    return board;
  }

  // Where a world point appears in the image (0-1), with the current calibration.
  const toImage = (x, y, z) => {
    const [u, v] = worldToPixel(calibration, x, y, z);
    return [u / WIDTH, v / HEIGHT];
  };

  return { detect, readBoard, calibrateCamera, toImage, get calibration() { return calibration; } };
}
