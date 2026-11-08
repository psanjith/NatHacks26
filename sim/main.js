import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { loadArm } from "./arm.js";
import { createKinematics } from "./kinematics.js";
import { OBJECTS } from "./layout.js";
import { scatterObjects } from "./objects.js";
import { createPhysics } from "./physics.js";
import { STATE_CHANNEL, armPose, createRenderer, createScene } from "./scene.js";
import { createPickAndPlace } from "./task.js";
import { createEegChooser, drawTrace, loadReplay } from "./eeg-replay.js";

// park (degrees) swings the arm to one side, high above the basket, so the table
// camera sees every object and every board sticker.
const ARM_JOINTS = [
  { name: "yaw_joint", label: "Yaw", park: -90 },
  { name: "shoulder_joint", label: "Shoulder", park: 0 },
  { name: "elbow_joint", label: "Elbow", park: 25 },
  { name: "wrist_joint", label: "Wrist", park: 30 },
];
const ARM_SPEED = 70; // degrees per second for animated moves
const HOME_VIEW = { position: [0.3, -1.95, 1.25], target: [0.42, 0, 0.22] };

const panel = document.querySelector(".panel");
const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const sliders = document.getElementById("sliders");
const cameraView = document.getElementById("camera-view");
const taskStatus = document.getElementById("task-status");

const renderer = createRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.getElementById("viewport").append(renderer.domElement);
const { scene, reachBand, tableCamera } = createScene(renderer);
const objects = scene.getObjectByName("objects");

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

let needsRender = true;
const requestRender = () => {
  needsRender = true;
  renderer.shadowMap.needsUpdate = true;
};

// Camera tabs (camera.html) mirror the arm and cubes through this channel.
const channel = new BroadcastChannel(STATE_CHANNEL);
let arm = null;
let shownTargets = { targets: [], selected: null };
const position = new THREE.Vector3();
const rotation = new THREE.Quaternion();
const size = new THREE.Vector3();
function worldState() {
  return {
    joints: armPose(arm),
    objects: OBJECTS.map(({ id }) => {
      const cube = scene.getObjectByName(id);
      cube.updateWorldMatrix(true, false);
      cube.matrixWorld.decompose(position, rotation, size);
      return { id, position: position.toArray(), quaternion: rotation.toArray() };
    }),
  };
}
const sendState = () => channel.postMessage({ type: "state", ...worldState() });
// Sent right away rather than from the render loop, which the browser pauses
// while this tab is in the background. Several changes in one go send one message.
let stateQueued = false;
const queueState = () => {
  if (stateQueued || !arm) return;
  stateQueued = true;
  queueMicrotask(() => {
    stateQueued = false;
    sendState();
  });
};
const worldChanged = () => {
  queueState();
  requestRender();
};
const publishTargets = (targets, selected) => {
  shownTargets = { targets, selected };
  channel.postMessage({ type: "targets", ...shownTargets });
};
channel.onmessage = ({ data }) => {
  if (data.type === "request-state" && arm) {
    sendState();
    channel.postMessage({ type: "targets", ...shownTargets });
  }
};

controls.addEventListener("change", () => (needsRender = true));
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  needsRender = true;
});

let physics = null;
let lastSimulated = performance.now();
function simulate() {
  const now = performance.now();
  const elapsed = (now - lastSimulated) / 1000;
  lastSimulated = now;
  if (physics?.advance(elapsed)) worldChanged();
}

renderer.setAnimationLoop(() => {
  simulate();
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
  let current = value;

  const set = (next) => {
    current = Number(next);
    input.value = current;
    output.textContent = `${Math.round(current)}${unit}`;
    onInput(current);
    worldChanged();
  };
  input.addEventListener("input", () => set(input.value));
  row.append(name, output, input);
  sliders.append(row);
  set(value);
  return { set, get: () => current, reset: () => set(value) };
}

// Steps animations by time. In a background tab (say, while the camera tab is in
// front) the browser pauses animation frames and slows timers to about once a
// second, so a small worker supplies ~60 ticks a second instead.
const ticker = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 16);"], { type: "text/javascript" })));
const tickWaiters = [];
ticker.onmessage = () => {
  if (document.hidden) simulate(); // keeps physics running while the camera tab is in front
  tickWaiters.splice(0).forEach((resolve) => resolve());
};
const nextFrame = () => new Promise((resolve) => (document.hidden ? tickWaiters.push(resolve) : requestAnimationFrame(resolve)));
async function animate(duration, step) {
  const start = performance.now();
  for (;;) {
    const k = Math.min(1, (performance.now() - start) / duration);
    step(k);
    if (k >= 1) return;
    await nextFrame();
  }
}

async function start() {
  arm = await loadArm((fraction) => {
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

  // Moves the four joints (degrees) and/or the claw (percent) smoothly.
  async function moveArm(angles, clawPercent = null) {
    const from = controlsList.map((control) => control.get());
    const to = from.slice();
    if (angles) angles.forEach((value, i) => (to[i] = value));
    if (clawPercent !== null) to[4] = clawPercent;
    const jointSpan = Math.max(...to.slice(0, 4).map((value, i) => Math.abs(value - from[i])));
    const clawMoves = Math.abs(to[4] - from[4]) > 0.5;
    const duration = Math.max(jointSpan / ARM_SPEED * 1000, clawMoves ? 450 : 0, 250);
    await animate(duration, (k) => {
      const eased = k * k * (3 - 2 * k);
      to.forEach((value, i) => controlsList[i].set(from[i] + (value - from[i]) * eased));
    });
  }
  const park = () => moveArm(ARM_JOINTS.map(({ park }) => park));

  loadingText.textContent = "Starting physics";
  physics = await createPhysics({ arm, objects });
  lastSimulated = performance.now();

  // Resolves once every cube has stopped moving (or after timeoutMs).
  async function waitForRest(timeoutMs = 4000) {
    const start = performance.now();
    let still = 0;
    while (still < 10 && performance.now() - start < timeoutMs) {
      await nextFrame();
      still = physics.isAtRest() ? still + 1 : 0;
    }
  }

  const kinematics = createKinematics(arm);
  const task = createPickAndPlace({
    arm, kinematics, physics, renderer, scene, camera: tableCamera, objects,
    moveArm, park, nextFrame, waitForRest, worldChanged, publishTargets,
    setClaw: (percent) => controlsList[4].set(percent),
    setStatus: (text) => (taskStatus.textContent = text),
  });

  let busy = false;
  const runTask = async (job) => {
    if (busy) return null;
    busy = true;
    panel.classList.add("busy");
    panel.querySelectorAll("button, input").forEach((element) => (element.disabled = true));
    try {
      return await job();
    } catch (error) {
      console.error(error);
      taskStatus.textContent = `Something went wrong: ${error.message}`;
      return { ok: false, reason: error.message };
    } finally {
      panel.querySelectorAll("button, input").forEach((element) => (element.disabled = false));
      panel.classList.remove("busy");
      busy = false;
    }
  };
  // Drops each cube from a few centimetres up, tumbling, at a random spot.
  const scatter = () => {
    if (busy) return;
    scatterObjects(objects);
    for (const cube of objects.children) {
      cube.position.z += 0.03 + Math.random() * 0.07;
      cube.quaternion.random();
      physics.place(cube);
    }
    publishTargets([], null);
    taskStatus.textContent = "Cubes scattered";
    worldChanged();
  };
  const pick = () => runTask(() => task.pickRandom());

  // Brain control from recorded EEG: ?user=<name> picks whose recordings (default nav).
  const eegUser = new URLSearchParams(location.search).get("user") || "nav";
  const eegButton = document.getElementById("pick-eeg");
  const eegStats = document.getElementById("eeg-stats");
  eegButton.textContent = `Pick with ${eegUser[0].toUpperCase() + eegUser.slice(1)}’s EEG`;
  let eeg = null;
  const pickWithEeg = () => runTask(async () => {
    if (!eeg) {
      try {
        eeg = createEegChooser(await loadReplay(eegUser));
      } catch (error) {
        taskStatus.textContent = error.message;
        return { ok: false, reason: error.message };
      }
    }
    const result = await task.pickRandom((options) => {
      const decision = eeg.choose(options);
      if (decision.trial) drawTrace(document.getElementById("eeg-trace"), decision.trial.trace_oz);
      return decision;
    });
    const { n, right, wrong, unsure } = eeg.tally;
    const r = eeg.replay;
    eegStats.textContent = `Replayed ${n} of ${r.trials.length} recorded trials: ${right} right, ${wrong} wrong, ${unsure} not sure ` +
      `(${r.method}, ${r.win} s look, cross-validated ${Math.round(100 * r.cv_acc)}%)`;
    return result;
  });

  // Animated rather than instant: a part that jumps through a cube would launch it.
  document.getElementById("home-pose").addEventListener("click", () => runTask(() => moveArm([0, 0, 0, 0], 0)));
  document.getElementById("park-pose").addEventListener("click", () => runTask(park));
  document.getElementById("scatter").addEventListener("click", scatter);
  document.getElementById("pick").addEventListener("click", pick);
  eegButton.addEventListener("click", pickWithEeg);
  document.getElementById("open-camera").addEventListener("click", () => {
    window.open("camera.html", "pnjex-table-camera");
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
  window.sim = { renderer, scene, camera, tableCamera, controls, arm, kinematics, physics, task, requestRender, scatter, pick, pickWithEeg, moveArm, waitForRest };
  requestRender();
  loading.hidden = true;
}

start().catch((error) => {
  console.error(error);
  loadingText.textContent = `Could not load the arm: ${error.message}`;
});
