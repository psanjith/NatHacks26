import * as THREE from "three";
import { REACH, TABLE_Z } from "./layout.js";

export const TABLE = { minX: -0.3, maxX: 0.7, halfY: 0.65, thickness: 0.035, height: 0.74 };
const ROOM = { halfSize: 2.6, height: 2.7, centerX: 0.2 };

function woodTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#b98a5a";
  ctx.fillRect(0, 0, 1024, 1024);

  // Fixed seed keeps the grain identical on every load.
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 420; i += 1) {
    const y = random() * 1024;
    const wave = 4 + random() * 10;
    ctx.strokeStyle = `rgba(${70 + random() * 40}, ${40 + random() * 25}, 20, ${0.05 + random() * 0.14})`;
    ctx.lineWidth = 0.6 + random() * 2.4;
    ctx.beginPath();
    for (let x = 0; x <= 1024; x += 32) {
      ctx.lineTo(x, y + Math.sin(x / 170 + i) * wave);
    }
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function buildTable() {
  const group = new THREE.Group();
  group.name = "table";
  const wood = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.6 });
  const length = TABLE.maxX - TABLE.minX;
  const centerX = (TABLE.maxX + TABLE.minX) / 2;

  const top = new THREE.Mesh(new THREE.BoxGeometry(length, TABLE.halfY * 2, TABLE.thickness), wood);
  top.position.set(centerX, 0, TABLE_Z - TABLE.thickness / 2);
  top.castShadow = true;
  top.receiveShadow = true;
  group.add(top);

  const legMaterial = new THREE.MeshStandardMaterial({ color: "#5d4631", roughness: 0.7 });
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
  const size = ROOM.halfSize * 2;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({ color: "#8d8f92", roughness: 0.85 }),
  );
  floor.position.set(ROOM.centerX, 0, floorZ);
  floor.receiveShadow = true;
  group.add(floor);

  // Inward-facing walls: they vanish when the camera is on their far side,
  // so the room never blocks the view.
  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, ROOM.height),
    new THREE.MeshStandardMaterial({ color: "#d9d6cf", roughness: 0.95, side: THREE.BackSide }),
  );
  walls.position.set(ROOM.centerX, 0, floorZ + ROOM.height / 2 + 0.001);
  group.add(walls);
  return group;
}

function buildReachBand() {
  const geometry = new THREE.RingGeometry(REACH.minR, REACH.maxR, 96, 1, -Math.PI / 2, Math.PI);
  const band = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: "#1f8fff", transparent: true, opacity: 0.32, depthWrite: false }),
  );
  band.name = "reach_band";
  band.position.z = TABLE_Z + 0.0004;
  band.visible = false;
  return band;
}

function buildLights() {
  const group = new THREE.Group();
  const key = new THREE.DirectionalLight("#fff4e6", 2.1);
  key.position.set(-0.35, -0.85, 1.6);
  key.target.position.set(0.15, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.camera.left = -0.9;
  key.shadow.camera.right = 0.9;
  key.shadow.camera.top = 0.9;
  key.shadow.camera.bottom = -0.9;
  key.shadow.camera.near = 0.3;
  key.shadow.camera.far = 3.5;
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.0012;
  group.add(key, key.target);

  const fill = new THREE.DirectionalLight("#dbe8ff", 0.5);
  fill.position.set(-0.8, 0.9, 0.9);
  group.add(fill);
  return group;
}

export function buildWorld() {
  const group = new THREE.Group();
  group.name = "world";
  const reachBand = buildReachBand();
  group.add(buildRoom(), buildTable(), reachBand, buildLights());
  return { group, reachBand };
}
