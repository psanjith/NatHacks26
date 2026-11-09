import * as THREE from "three";
import { RoomEnvironment } from "../vendor/RoomEnvironment.js";
import { loadArm } from "../arm.js";
import { createBusinessman } from "./businessman.js";
import { buildPieces } from "./pieces.js";
import { buildWorld } from "./world.js";

// The scene both tabs draw: the main sim (physics, arm, opponent, game) and the camera tab (the table
// camera's image, where the person chooses). The main sim sends snapshots; the camera tab mirrors them.

export const CHANNEL = "reach-ttt";
export const ARM_JOINTS = ["yaw_joint", "shoulder_joint", "elbow_joint", "roll_joint"];

export function createRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

export async function buildScene(renderer, { nextFrame, onProgress = () => {} }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#14171d");
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;
  scene.environmentRotation.x = Math.PI / 2;
  const { group: world, highlights, tableCamera } = buildWorld();
  const pieceSet = buildPieces();
  const bm = createBusinessman({ nextFrame });
  scene.add(world, pieceSet.group, bm.root);
  const arm = await loadArm(onProgress);
  scene.add(arm.root);
  return { scene, tableCamera, highlights, pieceSet, bm, arm };
}

// Everything that moves, as plain data: arm joints (radians) and claw, every piece's pose, the
// opponent's pose and face.
export function snapshot({ arm, pieceSet, bm }) {
  const r = (v) => Math.round(v * 1e5) / 1e5;
  return {
    joints: ARM_JOINTS.map((name) => r(arm.joints.get(name).value)),
    claw: r(arm.claw),
    pieces: [...pieceSet.xs, ...pieceSet.os].map((m) => [...m.position.toArray(), ...m.quaternion.toArray()].map(r)),
    bm: bm.exportState(),
  };
}

export function applySnapshot(s, { arm, pieceSet, bm }) {
  ARM_JOINTS.forEach((name, i) => arm.setJoint(name, s.joints[i]));
  arm.setClaw(s.claw);
  [...pieceSet.xs, ...pieceSet.os].forEach((m, i) => {
    const p = s.pieces[i];
    m.position.set(p[0], p[1], p[2]);
    m.quaternion.set(p[3], p[4], p[5], p[6]);
  });
  bm.importState(s.bm);
}
