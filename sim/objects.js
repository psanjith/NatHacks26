import * as THREE from "three";
import { CUBE_SIZE, OBJECTS, positionOf } from "./layout.js";

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
