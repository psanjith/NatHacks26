import * as THREE from "three";
import { GRID, GRID_SIZE, MOUNT_SIZE, O_PIECE, O_SUPPLY, TABLE_Z, X_PIECE, X_SCATTER, X_SUPPLY, supplyPose } from "./layout.js";

// X and O pieces: extruded shapes with rounded edges. An X's own frame has its bars along x and y (a
// plus sign); its yaw is the direction of one bar, so yaw 45° reads as an "X" on the grid.

const BEVEL = 0.0012;

function xGeometry() {
  const h = X_PIECE.length / 2 - BEVEL;
  const w = X_PIECE.width / 2 - BEVEL;
  const outline = [[h, w], [w, w], [w, h], [-w, h], [-w, w], [-h, w], [-h, -w], [-w, -w], [-w, -h], [w, -h], [w, -w], [h, -w]];
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const depth = X_PIECE.height - 2 * BEVEL;
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: BEVEL, bevelThickness: BEVEL, bevelSegments: 3 });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function oGeometry() {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, O_PIECE.outer - BEVEL, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, O_PIECE.inner + BEVEL, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const depth = O_PIECE.height - 2 * BEVEL;
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: BEVEL, bevelThickness: BEVEL, bevelSegments: 3, curveSegments: 40 });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

export function buildPieces() {
  const group = new THREE.Group();
  group.name = "pieces";
  const xMaterial = new THREE.MeshStandardMaterial({ color: X_PIECE.color, roughness: 0.42, metalness: 0.05 });
  const oMaterial = new THREE.MeshStandardMaterial({ color: O_PIECE.color, roughness: 0.42, metalness: 0.05 });
  const xGeo = xGeometry();
  const oGeo = oGeometry();
  const xs = X_SUPPLY.map((_, i) => {
    const mesh = new THREE.Mesh(xGeo, xMaterial);
    mesh.name = `x_${i}`;
    mesh.userData.kind = "X";
    return mesh;
  });
  const os = O_SUPPLY.map((_, i) => {
    const mesh = new THREE.Mesh(oGeo, oMaterial);
    mesh.name = `o_${i}`;
    mesh.userData.kind = "O";
    return mesh;
  });
  for (const mesh of [...xs, ...os]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  resetPieces({ xs, os });
  return { group, xs, os };
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);

// Every piece back in its supply, flat on the table.
export function resetPieces({ xs, os }) {
  xs.forEach((mesh, i) => {
    const { x, y, yaw } = supplyPose(X_SUPPLY[i]);
    mesh.position.set(x, y, TABLE_Z + X_PIECE.height / 2);
    mesh.quaternion.setFromAxisAngle(Z_AXIS, yaw);
  });
  os.forEach((mesh, i) => {
    const { x, y } = O_SUPPLY[i];
    mesh.position.set(x, y, TABLE_Z + O_PIECE.height / 2);
    mesh.quaternion.identity();
  });
}

// Throws these X's onto random spots the arm can reach (X_SCATTER), at random angles, keeping clear of
// the board, of each other and of any pieces in `keepClearOf` (positions). allowed(x, y, yaw): any
// other test a spot and angle must pass (main.js: inside the camera's frame, and an arm pick that grips
// it well). Returns false if no layout fitted.
export function scatterXs(meshes, keepClearOf = [], { allowed = () => true, random = Math.random } = {}) {
  const S = X_SCATTER;
  const offBoard = (x, y) => Math.abs(x - GRID.x) > GRID_SIZE / 2 + S.boardClearance || Math.abs(y - GRID.y) > GRID_SIZE / 2 + S.boardClearance;
  const offMount = (x, y) => Math.max(Math.abs(x), Math.abs(y)) > MOUNT_SIZE / 2 + S.mountClearance; // the arm's raised plate
  for (let layout = 0; layout < 200; layout += 1) {
    const taken = keepClearOf.map((p) => [p.x, p.y]);
    const spots = [];
    for (let k = 0; k < meshes.length; k += 1) {
      let spot = null;
      for (let tries = 0; tries < 300 && !spot; tries += 1) {
        const [lo, hi] = S.yawRanges[Math.floor(random() * S.yawRanges.length)];
        const yaw = ((lo + random() * (hi - lo)) * Math.PI) / 180;
        const r = S.minR + random() * (S.maxR - S.minR);
        const x = r * Math.cos(yaw);
        const y = r * Math.sin(yaw);
        const turn = random() * Math.PI * 2;
        if (offBoard(x, y) && offMount(x, y) && !taken.some(([a, b]) => Math.hypot(a - x, b - y) < S.minGap) && allowed(x, y, turn)) spot = [x, y, turn];
      }
      if (!spot) break;
      taken.push(spot);
      spots.push(spot);
    }
    if (spots.length < meshes.length) continue; // didn't all fit: start this layout again
    meshes.forEach((mesh, k) => {
      mesh.position.set(spots[k][0], spots[k][1], TABLE_Z + X_PIECE.height / 2);
      mesh.quaternion.setFromAxisAngle(Z_AXIS, spots[k][2]);
    });
    return true;
  }
  return false;
}

// Collision shapes in the piece's own frame: [half extents, centre, angle about z].
export function pieceBoxes(kind) {
  if (kind === "X") {
    const { length, width, height } = X_PIECE;
    return [
      { half: [length / 2, width / 2, height / 2], at: [0, 0, 0], angle: 0 },
      { half: [width / 2, length / 2, height / 2], at: [0, 0, 0], angle: 0 },
    ];
  }
  const { outer, inner, height, segments } = O_PIECE;
  const mid = (outer + inner) / 2;
  const half = mid * Math.tan(Math.PI / segments) * 1.08;
  return Array.from({ length: segments }, (_, k) => {
    const a = (k / segments) * Math.PI * 2;
    return { half: [(outer - inner) / 2, half, height / 2], at: [mid * Math.cos(a), mid * Math.sin(a), 0], angle: a };
  });
}
