import * as THREE from "three";
import { TABLE_Z } from "./layout.js";
import { TABLE } from "./world.js";

// The table camera: in front of the arm and to its left, looking down at the
// objects. From here the arm sits behind the objects, so it hides the least.
// Park the arm before taking a frame to see every object in full.
const AIM = { x: 0.12, y: 0, z: 0 };
const LENS = { x: 0.592, y: 0.272, z: 0.778 }; // 30° left of straight ahead, 55° down, 0.95 m from AIM
const FOV_DEGREES = 32; // every object in frame with ~20% margin each side
const ASPECT = 4 / 3;

// A floor tripod just past the far end of the table, with a boom out to the camera.
const FLOOR_Z = TABLE_Z - TABLE.height;
const TRIPOD = { x: TABLE.maxX + 0.28, y: LENS.y, hubZ: FLOOR_Z + 0.75, legSpread: 0.3 };
const BOOM_Z = LENS.z + 0.09;

function strut(from, to, radius, material) {
  const start = new THREE.Vector3(...from);
  const direction = new THREE.Vector3(...to).sub(start);
  const geometry = new THREE.CylinderGeometry(radius, radius, direction.length(), 16);
  const result = new THREE.Mesh(geometry, material);
  result.position.copy(start).addScaledVector(direction, 0.5);
  result.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return result;
}

export function buildTableCamera() {
  const camera = new THREE.PerspectiveCamera(FOV_DEGREES, ASPECT, 0.05, 6);
  camera.name = "table_camera";
  camera.position.set(LENS.x, LENS.y, LENS.z);
  camera.up.set(0, 0, 1);
  camera.lookAt(AIM.x, AIM.y, AIM.z);
  camera.updateMatrixWorld();
  return camera;
}

export function buildCameraRig(camera) {
  const rig = new THREE.Group();
  rig.name = "camera_rig";
  const metal = new THREE.MeshStandardMaterial({ color: "#23262b", metalness: 0.5, roughness: 0.45 });
  const glass = new THREE.MeshStandardMaterial({ color: "#0c0e12", metalness: 0.2, roughness: 0.15 });
  const { x, y, hubZ, legSpread } = TRIPOD;

  for (const angle of [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3]) {
    const foot = [x + legSpread * Math.cos(angle), y + legSpread * Math.sin(angle), FLOOR_Z];
    rig.add(strut([x, y, hubZ], foot, 0.011, metal));
  }
  rig.add(strut([x, y, hubZ - 0.05], [x, y, BOOM_Z + 0.02], 0.016, metal)); // mast
  rig.add(strut([x, y, BOOM_Z], [LENS.x - 0.03, y, BOOM_Z], 0.011, metal)); // boom

  // The body sits behind the lens along the camera's line of sight.
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
  const bodyCenter = camera.position.clone().addScaledVector(back, 0.035);
  rig.add(strut([LENS.x, LENS.y, BOOM_Z], bodyCenter.toArray(), 0.008, metal)); // stem
  const head = new THREE.Group();
  head.position.copy(bodyCenter);
  head.quaternion.copy(camera.quaternion);
  head.add(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.04), metal));
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.016, 24), glass);
  lens.rotation.x = Math.PI / 2;
  lens.position.z = -0.027;
  head.add(lens);
  rig.add(head);
  return rig; // casts no shadow, so it never darkens the camera's own image
}
