import * as THREE from "three";
import {
  BOARD_MARKERS, BOARD_MARKER_DIAMETER, CAMERA, CAMERA_VFOV, GRID, GRID_SIZE, BOARD_TOP, MARKERS, MARKER_DIAMETER, MOUNT_SIZE, O_TRAY, TABLE, TABLE_Z, X_PIECE,
  cellCenter,
} from "./layout.js";

// The arena: a dim room, a dark table with a battle mat, the glowing game board, the X supply pad,
// the opponent's O tray, his nameplate, and the table camera on its pole.

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

function canvasTexture(size, draw, { srgb = true } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = size[0];
  canvas.height = size[1];
  draw(canvas.getContext("2d"), size[0], size[1]);
  const texture = new THREE.CanvasTexture(canvas);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function woodTexture() {
  return canvasTexture([1024, 1024], (ctx) => {
    ctx.fillStyle = "#3a2a1f";
    ctx.fillRect(0, 0, 1024, 1024);
    let seed = 11;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 420; i += 1) {
      const y = random() * 1024;
      const wave = 4 + random() * 10;
      ctx.strokeStyle = `rgba(${15 + random() * 25}, ${8 + random() * 14}, 4, ${0.08 + random() * 0.18})`;
      ctx.lineWidth = 0.6 + random() * 2.4;
      ctx.beginPath();
      for (let x = 0; x <= 1024; x += 32) ctx.lineTo(x, y + Math.sin(x / 170 + i) * wave);
      ctx.stroke();
    }
  });
}

function buildTable() {
  const group = new THREE.Group();
  group.name = "table";
  const wood = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.55 });
  const length = TABLE.maxX - TABLE.minX;
  const top = new THREE.Mesh(new THREE.BoxGeometry(length, TABLE.halfY * 2, TABLE.thickness), wood);
  top.position.set((TABLE.maxX + TABLE.minX) / 2, 0, TABLE_Z - TABLE.thickness / 2);
  top.castShadow = true;
  top.receiveShadow = true;
  group.add(top);
  const legMaterial = new THREE.MeshStandardMaterial({ color: "#1d1712", roughness: 0.7 });
  const legHeight = TABLE.height - TABLE.thickness;
  for (const x of [TABLE.minX + 0.06, TABLE.maxX - 0.06]) {
    for (const y of [-TABLE.halfY + 0.06, TABLE.halfY - 0.06]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, legHeight), legMaterial);
      leg.position.set(x, y, TABLE_Z - TABLE.thickness - legHeight / 2);
      leg.castShadow = true;
      group.add(leg);
    }
  }
  return group;
}

function buildRoom() {
  const group = new THREE.Group();
  group.name = "room";
  const floorZ = TABLE_Z - TABLE.height;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshStandardMaterial({ color: "#2a2d33", roughness: 0.9 }));
  floor.position.set(0.2, 0, floorZ);
  floor.receiveShadow = true;
  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(6, 6, 3),
    new THREE.MeshStandardMaterial({ color: "#20242c", roughness: 0.95, side: THREE.BackSide }),
  );
  walls.position.set(0.2, 0, floorZ + 1.5 + 0.001);
  group.add(floor, walls);
  return group;
}

// The battle mat between the two players: red on the arm's half, teal on the opponent's.
function buildMat() {
  const x0 = MOUNT_SIZE / 2 + 0.004;
  const x1 = TABLE.maxX - 0.02;
  const halfY = 0.36;
  const w = x1 - x0;
  const texture = canvasTexture([1400, Math.round((1400 * halfY * 2) / w)], (ctx, W, H) => {
    // u runs along +x (towards the opponent), v along -y.
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, "#2a1414");
    g.addColorStop(0.5, "#15171d");
    g.addColorStop(1, "#10182a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 2;
    for (let x = 0; x < W; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = 0; y < H; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    const edge = 14;
    ctx.lineWidth = edge;
    // The arm's edge is light grey: a red line would blend into the red X pieces lying across it.
    ctx.strokeStyle = "#9aa3b2";
    ctx.beginPath();
    ctx.moveTo(edge / 2, edge / 2);
    ctx.lineTo(edge / 2, H - edge / 2);
    ctx.stroke();
    ctx.strokeStyle = "#3d7bff"; // blue, not cyan: the camera calibrates on a cyan sticker
    ctx.beginPath();
    ctx.moveTo(W - edge / 2, edge / 2);
    ctx.lineTo(W - edge / 2, H - edge / 2);
    ctx.stroke();
    ctx.font = `800 64px ${FONT}`;
    ctx.textAlign = "center";
    // Each side's label reads upright from that player's chair.
    ctx.save();
    ctx.translate(W * 0.9, H * 0.82);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "rgba(61,123,255,0.6)";
    ctx.fillText("TEAM O", 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(W * 0.05, H * 0.5);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = "rgba(255,90,60,0.6)";
    ctx.fillText("TEAM X", 0, 0);
    ctx.restore();
  });
  const mat = new THREE.Mesh(new THREE.PlaneGeometry(w, halfY * 2), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85 }));
  // The plane's u is along x already; flip v so it runs along -y.
  mat.rotation.z = 0;
  mat.position.set((x0 + x1) / 2, 0, TABLE_Z + 0.0004);
  mat.receiveShadow = true;
  mat.name = "mat";
  return mat;
}

// The board: a dark slab with glowing grid lines, framed in brushed metal.
function buildBoard() {
  const group = new THREE.Group();
  group.name = "game_board";
  const px = 1024;
  const draw = (lit) => (ctx, W, H) => {
    if (!lit) {
      const g = ctx.createRadialGradient(W / 2, H / 2, W * 0.1, W / 2, H / 2, W * 0.75);
      g.addColorStop(0, "#1b2232");
      g.addColorStop(1, "#0d1119");
      ctx.fillStyle = g;
    } else ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const s = W / GRID_SIZE;
    const b = GRID.border * s;
    const p = GRID.pitch * s;
    ctx.lineCap = "round";
    // Outer frame of the grid area.
    ctx.strokeStyle = lit ? "#2c6c80" : "#3a4d66";
    ctx.lineWidth = 6;
    ctx.strokeRect(b, b, W - 2 * b, H - 2 * b);
    // The four grid lines, glowing.
    ctx.strokeStyle = lit ? "#bff6ff" : "#d8fbff";
    ctx.shadowColor = "#3fe0ff";
    ctx.shadowBlur = lit ? 26 : 10;
    ctx.lineWidth = 11;
    for (const k of [1, 2]) {
      ctx.beginPath();
      ctx.moveTo(b + k * p, b + 0.12 * p);
      ctx.lineTo(b + k * p, H - b - 0.12 * p);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(b + 0.12 * p, b + k * p);
      ctx.lineTo(W - b - 0.12 * p, b + k * p);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  };
  const map = canvasTexture([px, px], draw(false));
  const emissiveMap = canvasTexture([px, px], draw(true));
  const top = new THREE.MeshStandardMaterial({ map, emissiveMap, emissive: "#ffffff", emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.2 });
  const metal = new THREE.MeshStandardMaterial({ color: "#59606b", metalness: 0.85, roughness: 0.3 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(GRID_SIZE, GRID_SIZE, GRID.thickness), [metal, metal, metal, metal, top, metal]);
  slab.position.set(GRID.x, GRID.y, TABLE_Z + GRID.thickness / 2);
  slab.castShadow = true;
  slab.receiveShadow = true;
  group.add(slab);
  // Green calibration stickers on the corners.
  const dot = new THREE.CircleGeometry(BOARD_MARKER_DIAMETER / 2, 32);
  const green = new THREE.MeshStandardMaterial({ color: "#1fd65a", roughness: 0.6 });
  for (const { x, y } of BOARD_MARKERS) {
    const m = new THREE.Mesh(dot, green);
    m.position.set(x, y, BOARD_TOP + 0.0003);
    m.receiveShadow = true;
    group.add(m);
  }
  return group;
}

// Glow squares and a ghost X for each cell: yellow while looked at, green once confirmed, gold for a win.
const HIGHLIGHT = {
  gaze: { color: "#ffd23f", opacity: 0.55, ghost: 0.45 },
  confirm: { color: "#3ee07a", opacity: 0.7, ghost: 0.75 },
  win: { color: "#ffb000", opacity: 0.8, ghost: 0 },
  hint: { color: "#ffffff", opacity: 0.16, ghost: 0 },
};

function buildHighlights() {
  const group = new THREE.Group();
  group.name = "highlights";
  const glow = canvasTexture([256, 256], (ctx, W, H) => {
    const r = 46;
    ctx.clearRect(0, 0, W, H);
    ctx.shadowColor = "#fff";
    ctx.shadowBlur = 30;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.roundRect(28, 28, W - 56, H - 56, r);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.beginPath();
    ctx.roundRect(28, 28, W - 56, H - 56, r);
    ctx.fill();
  });
  const plane = new THREE.PlaneGeometry(GRID.pitch * 0.96, GRID.pitch * 0.96);
  const ghostShape = (() => {
    const h = X_PIECE.length / 2;
    const w = X_PIECE.width / 2;
    const outline = [[h, w], [w, w], [w, h], [-w, h], [-w, w], [-h, w], [-h, -w], [-w, -w], [-w, -h], [w, -h], [w, -w], [h, -w]];
    return new THREE.ShapeGeometry(new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y))));
  })();
  const cells = [];
  for (let i = 0; i < 9; i += 1) {
    const { x, y } = cellCenter(i);
    const square = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    square.position.set(x, y, BOARD_TOP + 0.0008);
    const ghost = new THREE.Mesh(ghostShape, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
    ghost.position.set(x, y, BOARD_TOP + 0.0012);
    ghost.rotation.z = Math.PI / 4;
    square.visible = ghost.visible = false;
    group.add(square, ghost);
    cells.push({ square, ghost, state: null });
  }
  function set(index, state) {
    const cell = cells[index];
    if (!cell || cell.state === state) return;
    cell.state = state;
    const style = state && HIGHLIGHT[state];
    cell.square.visible = Boolean(style);
    cell.ghost.visible = Boolean(style?.ghost);
    if (!style) return;
    cell.square.material.color.set(style.color);
    cell.square.material.opacity = style.opacity;
    cell.ghost.material.color.set(style.color);
    cell.ghost.material.opacity = style.ghost;
  }
  const clear = () => cells.forEach((_, i) => set(i, null));
  // Win glow pulses.
  function pulse(t) {
    for (const cell of cells) if (cell.state === "win") cell.square.material.opacity = 0.55 + 0.35 * Math.sin(t * 6);
  }
  return { group, set, clear, pulse, get states() { return cells.map((c) => c.state); } };
}

// Outlines on the table where the X pieces wait.
function buildOTray() {
  const group = new THREE.Group();
  group.name = "o_tray";
  const material = new THREE.MeshStandardMaterial({ color: "#2c3038", roughness: 0.6, metalness: 0.2 });
  const w = O_TRAY.pitch * 2 + 0.05;
  const d = O_TRAY.pitch * 3 + 0.05;
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, d, 0.002), material);
  base.position.set(O_TRAY.x, O_TRAY.y, TABLE_Z + 0.001);
  base.receiveShadow = true;
  group.add(base);
  return { group, top: TABLE_Z + 0.002 };
}

function buildNameplate() {
  const texture = canvasTexture([1024, 256], (ctx, W, H) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#2b2f36");
    g.addColorStop(1, "#14171c");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#c9a24a";
    ctx.lineWidth = 10;
    ctx.strokeRect(12, 12, W - 24, H - 24);
    ctx.fillStyle = "#f0d48a";
    ctx.textAlign = "center";
    ctx.font = `800 92px ${FONT}`;
    ctx.fillText("MR. PEMBERTON", W / 2, 128);
    ctx.font = `600 50px ${FONT}`;
    ctx.fillStyle = "#c9cdd4";
    ctx.fillText("VP of Strategy", W / 2, 205);
  });
  const group = new THREE.Group();
  group.name = "nameplate";
  const face = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.4, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: "#14171c", roughness: 0.5 });
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.16, 0.04), [face, dark, dark, dark, dark, dark]);
  // Leans back slightly, facing the arm (-x).
  plate.rotation.y = -0.35;
  plate.rotation.z = Math.PI;
  plate.position.set(0.415, -0.2, TABLE_Z + 0.019);
  plate.castShadow = true;
  group.add(plate);
  return group;
}

function buildLights() {
  const group = new THREE.Group();
  const key = new THREE.DirectionalLight("#fff3e2", 2.0);
  key.position.set(-0.2, -0.7, 1.6);
  key.target.position.set(0.25, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  Object.assign(key.shadow.camera, { left: -0.9, right: 0.9, top: 0.9, bottom: -0.9, near: 0.3, far: 3.5 });
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.0012;
  group.add(key, key.target);
  const fill = new THREE.DirectionalLight("#cfe0ff", 0.45);
  fill.position.set(-0.6, 0.9, 0.9);
  group.add(fill);
  // Team-coloured rim lights from each side of the table. Soft, and blue rather than cyan: a strong
  // cyan cast on the white arm would pass for the camera's cyan calibration sticker.
  const red = new THREE.PointLight("#ff7a5c", 0.9, 1.4, 2);
  red.position.set(-0.4, -0.4, 0.4);
  const blue = new THREE.PointLight("#7aa6ff", 1.3, 1.8, 2);
  blue.position.set(1.0, 0.35, 0.65);
  group.add(red, blue);
  return group;
}

function buildMarkers() {
  const group = new THREE.Group();
  group.name = "calibration_markers";
  const geometry = new THREE.CircleGeometry(MARKER_DIAMETER / 2, 40);
  for (const marker of MARKERS) {
    const sticker = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: marker.color, roughness: 0.6 }));
    sticker.name = `marker_${marker.id}`;
    sticker.position.set(marker.x, marker.y, 0.0004);
    sticker.receiveShadow = true;
    group.add(sticker);
  }
  return group;
}

function strut(from, to, radius, material) {
  const start = new THREE.Vector3(...from);
  const direction = new THREE.Vector3(...to).sub(start);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), 16), material);
  mesh.position.copy(start).addScaledVector(direction, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

export function buildTableCamera() {
  const camera = new THREE.PerspectiveCamera(CAMERA_VFOV, CAMERA.width / CAMERA.height, 0.05, 6);
  camera.name = "table_camera";
  camera.position.set(CAMERA.lens.x, CAMERA.lens.y, CAMERA.lens.z);
  camera.up.set(0, 0, 1);
  camera.lookAt(CAMERA.aim.x, CAMERA.aim.y, CAMERA.aim.z);
  camera.updateMatrixWorld();
  return camera;
}

// A pole clamped to the table's right-hand edge beside the camera, with a short boom out to it.
function buildCameraRig(camera) {
  const rig = new THREE.Group();
  rig.name = "camera_rig";
  const metal = new THREE.MeshStandardMaterial({ color: "#23262b", metalness: 0.5, roughness: 0.45 });
  const glass = new THREE.MeshStandardMaterial({ color: "#0c0e12", metalness: 0.2, roughness: 0.15 });
  const { x, y, z } = CAMERA.lens;
  const poleX = Math.max(TABLE.minX + 0.04, Math.min(TABLE.maxX - 0.04, x));
  const poleY = -TABLE.halfY + 0.025;
  const boomZ = z + 0.07;
  rig.add(strut([poleX, poleY, TABLE_Z], [poleX, poleY, boomZ + 0.02], 0.012, metal));
  const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.03), metal);
  clamp.position.set(poleX, poleY, TABLE_Z + 0.015);
  rig.add(clamp);
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
  const body = camera.position.clone().addScaledVector(back, 0.035);
  rig.add(strut([poleX, poleY, boomZ], [x, y + 0.0, boomZ], 0.009, metal));
  rig.add(strut([x, y, boomZ], body.toArray(), 0.007, metal));
  const head = new THREE.Group();
  head.position.copy(body);
  head.quaternion.copy(camera.quaternion);
  head.add(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.04), metal));
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.016, 24), glass);
  lens.rotation.x = Math.PI / 2;
  lens.position.z = -0.027;
  head.add(lens);
  rig.add(head);
  return rig;
}

function buildMug() {
  const group = new THREE.Group();
  group.name = "mug";
  const white = new THREE.MeshStandardMaterial({ color: "#f3f1ec", roughness: 0.35 });
  const coffee = new THREE.MeshStandardMaterial({ color: "#3b2416", roughness: 0.2 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.036, 0.1, 32, 1, true), white);
  body.rotation.x = Math.PI / 2;
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.036, 32), white);
  bottom.position.z = -0.05;
  const top = new THREE.Mesh(new THREE.CircleGeometry(0.038, 32), coffee);
  top.position.z = 0.035;
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.007, 12, 24, Math.PI), white);
  handle.rotation.x = Math.PI / 2;
  handle.rotation.y = -Math.PI / 2;
  handle.position.set(0, -0.04, 0);
  group.add(body, bottom, top, handle);
  group.traverse((m) => { if (m.isMesh) m.castShadow = true; });
  group.position.set(0.39, -0.36, TABLE_Z + 0.05);
  return group;
}

export function buildWorld() {
  const group = new THREE.Group();
  group.name = "world";
  const highlights = buildHighlights();
  const tray = buildOTray();
  group.add(buildRoom(), buildTable(), buildMat(), buildBoard(), tray.group, buildNameplate(),
    buildLights(), buildMarkers(), buildMug(), highlights.group);
  const tableCamera = buildTableCamera();
  group.add(buildCameraRig(tableCamera));
  return { group, highlights, tableCamera, trayTop: tray.top };
}
