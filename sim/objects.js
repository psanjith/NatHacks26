import * as THREE from "three";
import { BASKET, BOARD_SIZE, CUBE_SIZE, OBJECTS, SCATTER, TABLE_Z, positionOf } from "./layout.js";

const geometry = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);

export function buildObjects() {
  const group = new THREE.Group();
  group.name = "objects";
  for (const object of OBJECTS) {
    const material = new THREE.MeshStandardMaterial({ color: object.color, roughness: 0.55 });
    const cube = new THREE.Mesh(geometry, material);
    cube.name = object.id;
    cube.castShadow = true;
    cube.receiveShadow = true;
    cube.position.set(...positionOf(object));
    cube.position.z += CUBE_SIZE / 2;
    cube.rotation.z = (object.yaw * Math.PI) / 180; // one face points at the arm
    group.add(cube);
  }
  return group;
}

// Drops every cube at a random spot (see SCATTER in layout.js) with a random spin.
export function scatterObjects(group, random = Math.random) {
  const placed = [];
  for (const cube of group.children) {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const yaw = THREE.MathUtils.degToRad(SCATTER.minYaw + (SCATTER.maxYaw - SCATTER.minYaw) * random());
      const r = Math.sqrt(SCATTER.minR ** 2 + (SCATTER.maxR ** 2 - SCATTER.minR ** 2) * random());
      const x = r * Math.cos(yaw);
      const y = r * Math.sin(yaw);
      const offBoard = Math.max(Math.abs(x), Math.abs(y)) > BOARD_SIZE / 2 + CUBE_SIZE * 0.75;
      const basketGap = Math.max(Math.abs(x - BASKET.x), Math.abs(y - BASKET.y)) - BASKET.size / 2;
      const apart = placed.every(([px, py]) => Math.hypot(px - x, py - y) >= SCATTER.minGap);
      if (!offBoard || basketGap < SCATTER.basketClearance || !apart) continue;
      placed.push([x, y]);
      cube.position.set(x, y, TABLE_Z + CUBE_SIZE / 2);
      cube.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), random() * Math.PI / 2);
      break;
    }
  }
}
