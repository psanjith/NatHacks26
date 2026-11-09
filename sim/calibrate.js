import { findBlobs } from "./detect.js";
import { MARKERS } from "./layout.js";
import { solveLinear } from "./linalg.js";

// Works out where the table camera is from one image of the board's four corner
// stickers (positions in layout.js) and the camera's lens (field of view).
// From that, any pixel can be turned into a point on the table.
//
// Conventions: pixels (u right, v down) in the 640x480 detection image; camera
// coordinates x right, y down, z forward; world is the arm's frame.

const MIN_MARKER_AREA = 12;

function stickerColour(r, g, b) {
  const max = Math.max(r, g, b);
  if (max < 30) return 0;
  if (Math.abs(r - b) < 0.3 * max && g < 0.55 * Math.min(r, b)) return 1; // magenta
  if (Math.abs(g - b) < 0.25 * max && r < 0.55 * Math.min(g, b)) return 2; // cyan
  return 0;
}

export function findMarkers({ data, width, height }) {
  const magenta = new Uint8Array(width * height);
  const cyan = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p += 1) {
    const kind = stickerColour(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
    if (kind === 1) magenta[p] = 1;
    if (kind === 2) cyan[p] = 1;
  }
  const centres = (mask) => findBlobs(mask, width, height, MIN_MARKER_AREA)
    .map((points) => {
      let u = 0, v = 0;
      for (let i = 0; i < points.length; i += 2) { u += points[i]; v += points[i + 1]; }
      const area = points.length / 2;
      return { u: u / area + 0.5, v: v / area + 0.5, area };
    })
    .sort((a, b) => b.area - a.area);
  return { magenta: centres(magenta), cyan: centres(cyan) };
}

export function calibrate(image, verticalFovDegrees) {
  const found = findMarkers(image);
  if (found.cyan.length < 1 || found.magenta.length < 3) {
    return { ok: false, reason: `saw ${found.cyan.length} cyan and ${found.magenta.length} magenta stickers, need 1 and 3`, found };
  }
  // The cyan sticker is the front-left corner. Seen from above, the corners run
  // counter-clockwise, which in image coordinates (v down) is decreasing angle.
  const corners = [found.cyan[0], ...found.magenta.slice(0, 3)];
  const cu = corners.reduce((s, c) => s + c.u, 0) / 4;
  const cv = corners.reduce((s, c) => s + c.v, 0) / 4;
  const angle = (c) => Math.atan2(c.v - cv, c.u - cu);
  const start = angle(corners[0]);
  const turn = (c) => (((start - angle(c)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ordered = [corners[0], ...corners.slice(1).sort((a, b) => turn(a) - turn(b))];

  const H = homography(MARKERS.map((m) => [m.x, m.y]), ordered.map((c) => [c.u, c.v]));
  if (!H) return { ok: false, reason: "stickers are in a line", found };

  const f = image.height / 2 / Math.tan((verticalFovDegrees * Math.PI) / 360);
  const K = { f, cx: image.width / 2, cy: image.height / 2 };
  const pose = poseFromHomography(H, K);
  if (pose.center[2] <= 0) return { ok: false, reason: "camera came out below the board", found };
  return { ok: true, K, ...pose, markers: ordered };
}

// 3x3 H with H [X Y 1] ~ [u v 1], from four or more point pairs.
export function homography(world, pixels) {
  const A = [];
  const b = [];
  world.forEach(([X, Y], i) => {
    const [u, v] = pixels[i];
    A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]); b.push(u);
    A.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]); b.push(v);
  });
  // Least squares through the normal equations (exact for four points).
  const AtA = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => A.reduce((s, row) => s + row[i] * row[j], 0)));
  const Atb = Array.from({ length: 8 }, (_, i) => A.reduce((s, row, k) => s + row[i] * b[k], 0));
  const h = solveLinear(AtA, Atb);
  return h && [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, s) => a.map((v) => v * s);
const norm = (a) => Math.sqrt(dot(a, a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// The board is the plane z = 0, so H = K [r1 r2 t] up to scale.
export function poseFromHomography(H, { f, cx, cy }) {
  const column = (j) => [(H[0][j] - cx * H[2][j]) / f, (H[1][j] - cy * H[2][j]) / f, H[2][j]];
  const [m1, m2, m3] = [column(0), column(1), column(2)];
  let lambda = 2 / (norm(m1) + norm(m2));
  if (m3[2] * lambda < 0) lambda = -lambda; // the board is in front of the camera
  const r1n = scale(m1, Math.sign(lambda) / norm(m1));
  const r2raw = scale(m2, lambda);
  const r2o = r2raw.map((v, i) => v - dot(r1n, r2raw) * r1n[i]);
  const r2n = scale(r2o, 1 / norm(r2o));
  const r3 = cross(r1n, r2n);
  const t = scale(m3, lambda);
  const R = [r1n, r2n, r3]; // columns
  // Camera centre in the world: C = -R^T t.
  const center = [0, 1, 2].map((i) => -(R[i][0] * t[0] + R[i][1] * t[1] + R[i][2] * t[2]));
  return { R, t, center };
}

// The pixel where world point (x, y, z) appears.
export function worldToPixel({ K, R, t }, x, y, z) {
  const c = [0, 1, 2].map((i) => x * R[0][i] + y * R[1][i] + z * R[2][i] + t[i]);
  return [K.f * c[0] / c[2] + K.cx, K.f * c[1] / c[2] + K.cy];
}

// The world point where pixel (u, v) meets the horizontal plane at height z.
export function pixelToPlane({ K, R, center }, u, v, z) {
  const ray = [(u - K.cx) / K.f, (v - K.cy) / K.f, 1]; // camera coordinates
  const world = [0, 1, 2].map((i) => R[i][0] * ray[0] + R[i][1] * ray[1] + R[i][2] * ray[2]); // R^T ray
  const s = (z - center[2]) / world[2];
  return { x: center[0] + s * world[0], y: center[1] + s * world[1], z };
}
