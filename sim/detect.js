import * as THREE from "three";

// Finds objects in the table camera's image by background subtraction:
// compare the live frame with a "plate" of the same view without objects,
// keep the pixels that changed (minus shadows), and group them into blobs.
// Only pixels are used, so this works the same way on a real camera with a
// photo of the empty table as the plate. In the sim the plate is rendered
// with the objects hidden and the arm in its current pose.

export const WIDTH = 640;
export const HEIGHT = 480;
const DIFF_THRESHOLD = 28; // 0-255 on any channel
const MIN_AREA = 60; // pixels at 640x480
const SHADOW = { minRatio: 0.2, maxChroma: 0.06 };
// Touching objects show up as one blob. Each blob is split where neighbouring
// pixels change colour (brightness aside), then pieces of similar average colour
// are joined again, so a cube's lit and shaded faces stay one object while two
// touching cubes of different colours come apart.
const SPLIT_CHROMA = 0.09;
const MERGE_CHROMA = 0.22; // a red cube's shaded face differs from its lit face by ~0.16; red and yellow by ~0.4

export function detectObjects(renderer, scene, camera, objects) {
  const frame = captureFrame(renderer, scene, camera);
  const wasVisible = objects.visible;
  objects.visible = false;
  const plate = captureFrame(renderer, scene, camera);
  objects.visible = wasVisible;
  renderer.shadowMap.needsUpdate = true;
  return segment(frame.data, plate.data, WIDTH, HEIGHT);
}

// One camera image as RGBA bytes, rows top to bottom.
export function captureFrame(renderer, scene, camera) {
  const target = new THREE.WebGLRenderTarget(WIDTH, HEIGHT);
  const flipped = new Uint8Array(WIDTH * HEIGHT * 4);
  renderer.shadowMap.needsUpdate = true;
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(target, 0, 0, WIDTH, HEIGHT, flipped);
  renderer.setRenderTarget(null);
  target.dispose();
  const data = new Uint8Array(flipped.length); // WebGL reads bottom row first
  const row = WIDTH * 4;
  for (let y = 0; y < HEIGHT; y += 1) data.set(flipped.subarray((HEIGHT - 1 - y) * row, (HEIGHT - y) * row), y * row);
  return { data, width: WIDTH, height: HEIGHT };
}

// A darker pixel with the same hue as the plate is a shadow, not an object.
function isShadow(r, g, b, R, G, B) {
  const lit = R + G + B;
  const now = r + g + b;
  if (now >= lit || lit === 0 || now === 0) return false;
  if (now / lit < SHADOW.minRatio) return false;
  const chroma = Math.abs(r / now - R / lit) + Math.abs(g / now - G / lit) + Math.abs(b / now - B / lit);
  return chroma < SHADOW.maxChroma;
}

export function segment(frame, plate, width, height) {
  let mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = frame[i], g = frame[i + 1], b = frame[i + 2];
      const R = plate[i], G = plate[i + 1], B = plate[i + 2];
      const diff = Math.max(Math.abs(r - R), Math.abs(g - G), Math.abs(b - B));
      if (diff >= DIFF_THRESHOLD && !isShadow(r, g, b, R, G, B)) mask[y * width + x] = 1;
    }
  }
  mask = dilate(erode(mask, width, height), width, height); // drop specks
  const chroma = new Float32Array(width * height * 2);
  for (let p = 0; p < width * height; p += 1) {
    const sum = frame[p * 4] + frame[p * 4 + 1] + frame[p * 4 + 2] || 1;
    chroma[p * 2] = frame[p * 4] / sum;
    chroma[p * 2 + 1] = frame[p * 4 + 1] / sum;
  }
  const similar = (p, q) =>
    Math.abs(chroma[p * 2] - chroma[q * 2]) + Math.abs(chroma[p * 2 + 1] - chroma[q * 2 + 1]) < SPLIT_CHROMA;

  const blobOf = new Int32Array(width * height).fill(-1);
  findBlobs(mask, width, height, 1).forEach((points, blob) => {
    for (let i = 0; i < points.length; i += 2) blobOf[points[i + 1] * width + points[i]] = blob;
  });
  const groups = new Map(); // blob -> pieces of uniform colour
  for (const points of findBlobs(mask, width, height, 1, similar)) {
    let r = 0, g = 0;
    for (let i = 0; i < points.length; i += 2) {
      const p = points[i + 1] * width + points[i];
      r += chroma[p * 2]; g += chroma[p * 2 + 1];
    }
    const area = points.length / 2;
    const blob = blobOf[points[1] * width + points[0]];
    if (!groups.has(blob)) groups.set(blob, []);
    groups.get(blob).push({ points, area, r: r / area, g: g / area });
  }
  const objects = [];
  for (const pieces of groups.values()) {
    const merged = [];
    for (const piece of pieces.sort((a, b) => b.area - a.area)) {
      const match = merged.find((m) => Math.abs(m.r - piece.r) + Math.abs(m.g - piece.g) < MERGE_CHROMA);
      if (match) {
        match.points = match.points.concat(piece.points);
        match.area += piece.area;
      } else {
        merged.push({ ...piece });
      }
    }
    // A small leftover piece (a thin face, an edge) joins its closest-coloured neighbour.
    const pieceDistance = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g);
    const big = merged.filter((m) => m.area >= MIN_AREA * 3);
    for (const small of merged.filter((m) => m.area < MIN_AREA * 3)) {
      if (!big.length) continue;
      const nearest = big.reduce((a, b) => (pieceDistance(a, small) <= pieceDistance(b, small) ? a : b));
      nearest.points = nearest.points.concat(small.points);
      nearest.area += small.area;
    }
    const kept = big.length ? big : merged;
    objects.push(...kept.filter((m) => m.area >= MIN_AREA).map((m) => m.points));
  }
  const targets = objects.map((points) => describe(points, width, height));
  targets.sort((a, b) => a.center[0] - b.center[0]);
  targets.forEach((target, index) => (target.id = index + 1));
  return targets;
}

// Connected regions of a 0/1 mask, each as a flat [x0, y0, x1, y1, ...] list.
// joins(p, q), if given, decides whether two neighbouring pixels connect.
export function findBlobs(mask, width, height, minArea, joins = null) {
  const blobs = [];
  const seen = new Uint8Array(width * height);
  const stack = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    const points = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      const x = p % width;
      const y = (p - x) / width;
      points.push(x, y);
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (q >= 0 && q < mask.length && mask[q] && !seen[q] && (!joins || joins(p, q))) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (points.length / 2 >= minArea) blobs.push(points);
  }
  return blobs;
}

function describe(points, width, height) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sumX = 0, sumY = 0;
  const corners = [];
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i], y = points[i + 1];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    sumX += x; sumY += y;
    corners.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
  }
  const area = points.length / 2;
  // Everything is in 0-1 image coordinates (x right, y down) so any display size works.
  return {
    area,
    center: [(sumX / area + 0.5) / width, (sumY / area + 0.5) / height],
    box: [minX / width, minY / height, (maxX + 1) / width, (maxY + 1) / height],
    hull: convexHull(corners).map(([x, y]) => [x / width, y / height]),
  };
}

export function convexHull(points) {
  const unique = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()];
  unique.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(unique), ...half([...unique].reverse())];
}

function erode(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      out[p] = mask[p] & mask[p - 1] & mask[p + 1] & mask[p - width] & mask[p + width];
    }
  }
  return out;
}

function dilate(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      out[p] = mask[p] | mask[p - 1] | mask[p + 1] | mask[p - width] | mask[p + width];
    }
  }
  return out;
}
