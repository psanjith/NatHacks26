import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { RoomEnvironment } from "./vendor/RoomEnvironment.js";
import { loadArm } from "./arm.js";
import { buildObjects } from "./objects.js";
import { buildCameraRig, buildTableCamera } from "./camera.js";
import { buildWorld } from "./world.js";

// park (degrees) swings the arm to one side so the table camera sees every object.
const ARM_JOINTS = [
  { name: "yaw_joint", label: "Yaw", park: -90 },
  { name: "shoulder_joint", label: "Shoulder", park: -30 },
  { name: "elbow_joint", label: "Elbow", park: 25 },
  { name: "wrist_joint", label: "Wrist", park: 30 },
];
const HOME_VIEW = { position: [0.3, -1.95, 1.25], target: [0.42, 0, 0.22] };

const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const sliders = document.getElementById("sliders");
const cameraView = document.getElementById("camera-view");

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById("viewport").append(renderer.domElement);

// The whole scene uses the arm's frame (z up, metres), so no conversions are needed.
const scene = new THREE.Scene();
scene.background = new THREE.Color("#c9c7c2");
const environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04);
scene.environment = environment.texture;
scene.environmentIntensity = 0.45;
scene.environmentRotation.x = Math.PI / 2;

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.01, 30);
camera.up.set(0, 0, 1);
camera.position.fromArray(HOME_VIEW.position);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.fromArray(HOME_VIEW.target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.15;
controls.maxDistance = 2.4;
controls.maxPolarAngle = Math.PI * 0.53;

const { group: world, reachBand } = buildWorld();
const tableCamera = buildTableCamera();
scene.add(world, buildObjects(), buildCameraRig(tableCamera));

let needsRender = true;
const requestRender = () => {
  needsRender = true;
  renderer.shadowMap.needsUpdate = true;
};
renderer.shadowMap.autoUpdate = false;
controls.addEventListener("change", () => (needsRender = true));

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  needsRender = true;
});

renderer.setAnimationLoop(() => {
  controls.update();
  if (!needsRender) return;
  needsRender = false;
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  renderer.render(scene, camera);
  renderCameraView();
});

function renderCameraView() {
  const { left, bottom, width, height } = cameraView.getBoundingClientRect();
  const fromBottom = window.innerHeight - bottom;
  renderer.setViewport(left, fromBottom, width, height);
  renderer.setScissor(left, fromBottom, width, height);
  renderer.setScissorTest(true);
  renderer.render(scene, tableCamera);
  renderer.setScissorTest(false);
}

function addSlider({ label, min, max, value, unit, onInput }) {
  const row = document.createElement("label");
  row.className = "slider";
  const name = document.createElement("span");
  name.textContent = label;
  const output = document.createElement("output");
  const input = document.createElement("input");
  input.type = "range";
  input.min = min;
  input.max = max;
  input.step = 1;

  const set = (next) => {
    input.value = next;
    output.textContent = `${Math.round(next)}${unit}`;
    onInput(Number(next));
    requestRender();
  };
  input.addEventListener("input", () => set(input.value));
  row.append(name, output, input);
  sliders.append(row);
  set(value);
  return { set, reset: () => set(value) };
}

async function start() {
  const arm = await loadArm((fraction) => {
    loadingText.textContent = `Loading arm ${Math.round(fraction * 100)}%`;
  });
  scene.add(arm.root);

  const controlsList = ARM_JOINTS.map(({ name, label }) => {
    const [low, high] = arm.joints.get(name).range;
    return addSlider({
      label,
      min: Math.round(THREE.MathUtils.radToDeg(low)),
      max: Math.round(THREE.MathUtils.radToDeg(high)),
      value: 0,
      unit: "°",
      onInput: (degrees) => arm.setJoint(name, THREE.MathUtils.degToRad(degrees)),
    });
  });
  controlsList.push(addSlider({
    label: "Claw", min: 0, max: 100, value: 0, unit: "%",
    onInput: (percent) => arm.setClaw(percent / 100),
  }));

  document.getElementById("home-pose").addEventListener("click", () => {
    controlsList.forEach((control) => control.reset());
  });
  document.getElementById("park-pose").addEventListener("click", () => {
    ARM_JOINTS.forEach(({ park }, index) => controlsList[index].set(park));
  });
  document.getElementById("reset-view").addEventListener("click", () => {
    camera.position.fromArray(HOME_VIEW.position);
    controls.target.fromArray(HOME_VIEW.target);
    needsRender = true;
  });
  document.getElementById("show-reach").addEventListener("change", (event) => {
    reachBand.visible = event.target.checked;
    needsRender = true;
  });

  // Console access for trying things out while the sim grows.
  window.sim = { scene, camera, tableCamera, controls, arm, requestRender };
  requestRender();
  loading.hidden = true;
}

start().catch((error) => {
  console.error(error);
  loadingText.textContent = `Could not load the arm: ${error.message}`;
});
