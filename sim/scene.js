import * as THREE from "three";
import { RoomEnvironment } from "./vendor/RoomEnvironment.js";
import { buildCameraRig, buildTableCamera } from "./camera.js";
import { buildObjects } from "./objects.js";
import { buildWorld } from "./world.js";

// Shared by the main page and the camera tab, so both draw the same scene.

export function createRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; // set needsUpdate when something moves
  return renderer;
}

// The whole scene uses the arm's frame (z up, metres), so no conversions are needed.
export function createScene(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#c9c7c2");
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
  scene.environmentRotation.x = Math.PI / 2;

  const { group: world, reachBand } = buildWorld();
  const tableCamera = buildTableCamera();
  scene.add(world, buildObjects(), buildCameraRig(tableCamera));
  return { scene, reachBand, tableCamera };
}

// The main page broadcasts the arm's joint angles and the cubes' positions;
// camera tabs follow them.
export const STATE_CHANNEL = "pnjex-sim-state";

export function armPose(arm) {
  return Object.fromEntries([...arm.joints].map(([name, joint]) => [name, joint.value]));
}
