import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { loadArm } from "./arm.js";
import { createKinematics } from "./kinematics.js";
import { OBJECTS } from "./layout.js";
import { scatterObjects } from "./objects.js";
import { createPhysics } from "./physics.js";
import { STATE_CHANNEL, armPose, createRenderer, createScene } from "./scene.js";
import { createPickAndPlace } from "./task.js";
import { createBci } from "./bci.js";

// park (degrees) swings the arm to one side, high above the basket, so the table
// camera sees every object and every board sticker.
const ARM_JOINTS = [
  { name: "yaw_joint", label: "Yaw", park: -90 },
  { name: "shoulder_joint", label: "Shoulder", park: -10 },
  { name: "elbow_joint", label: "Elbow", park: -20 },
  { name: "roll_joint", label: "Wrist roll", park: 0 },
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
const { scene, tableCamera } = createScene(renderer);
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
let gazeMode = false; // "Pick with eyes + clench" is running: the camera tab shows grey/yellow boxes
let gazeWait = null; // a pick waiting for the camera tab: { resolve, reachable }
let stopGaze = () => {};
let startGaze = () => {};
// The camera tab reports in every 2 s: { seen (ms), ready, eyes, headset, clench }
const cameraTab = { seen: -1e9, ready: false };
const cameraOpen = () => performance.now() - cameraTab.seen < 5000;
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
const publishTargets = (targets, selected, extra = {}) => {
  shownTargets = { targets, selected, mode: gazeMode ? "gaze" : null, ...extra };
  channel.postMessage({ type: "targets", ...shownTargets });
};
channel.onmessage = ({ data }) => {
  if (data.type === "request-state" && arm) {
    sendState();
    channel.postMessage({ type: "targets", ...shownTargets });
  } else if (data.type === "gaze-select" && gazeWait) {
    // The camera tab: the person looked at a cube and clenched.
    const target = gazeWait.reachable.find((t) => t.id === data.id);
    if (target) {
      const { resolve } = gazeWait;
      gazeWait = null;
      resolve({ target, line: `Eyes + clench chose cube ${target.id}.` });
    } else {
      // out of reach (or stale): show the choices again
      publishTargets(gazeWait.onTable, null, { reachable: gazeWait.reachable.map((t) => t.id) });
    }
  } else if (data.type === "gaze-cancel") {
    stopGaze();
  } else if (data.type === "gaze-start") {
    startGaze(); // the camera tab finished setting up
  } else if (data.type === "camera-status") {
    Object.assign(cameraTab, data, { seen: performance.now() });
    showCameraLine();
  }
};
channel.postMessage({ type: "camera-ping" });

const cameraLine = document.getElementById("camera-line");
function showCameraLine() {
  if (!cameraOpen()) cameraLine.textContent = "Camera tab: not open";
  else if (!cameraTab.ready) cameraLine.textContent = "Camera tab: setting up (eyes, then jaw)…";
  else cameraLine.textContent = `Camera tab: ready · eyes ${cameraTab.eyes ? "calibrated" : "off (mouse)"} · ` +
    (cameraTab.headset ? `jaw ${cameraTab.clench ? "checked" : "not checked"}` : "no headset (space bar = clench)");
}
setInterval(showCameraLine, 2500);

// ---------------------------------------------------------------- headset: status and impedance check
const headsetStatus = document.getElementById("headset-status");
const impButton = document.getElementById("imp-check");
const impRows = document.getElementById("imp-rows");
const IMP_MAX_S = 45; // impedance mode pauses the EEG, so it switches itself off after this long
let impOn = false;
let impTimer = null;
const lastKohm = {};
const impWord = (k) => (k < 50 ? ["good", "good"] : k < 150 ? ["okay", "warn"] : ["poor contact", "bad"]);
function showImpedance(chans, live) {
  for (const c of chans) if (c.kohm != null) lastKohm[c.name] = c.kohm;
  const names = chans.length ? chans.map((c) => c.name) : Object.keys(lastKohm);
  if (!names.length) return;
  impRows.hidden = false;
  impRows.innerHTML = names.map((name) => {
    const k = live ? chans.find((c) => c.name === name)?.kohm : lastKohm[name];
    const [word, level] = k == null ? ["measuring…", ""] : impWord(k);
    return `<div class="imp-row"><span class="dot ${level}"></span><b>${name}</b><span>${word}</span>` +
      `<span class="k">${k == null ? "–" : `${k.toFixed(1)} kΩ`}</span></div>`;
  }).join("") + `<p class="hint-small">${live ? "Measuring now (EEG paused). " : "Last check. "}Good under 50 kΩ.</p>`;
}
const bci = createBci({
  interval: 500,
  onLive: ({ connected, live }) => {
    if (!connected) {
      headsetStatus.textContent = "Not connected. Start it with: python tools/ssvep_train.py --native --user nav";
      return;
    }
    const stale = live.stale_s != null && live.stale_s > 3 ? ` · no data for ${Math.round(live.stale_s)} s (Bluetooth?)` : "";
    const jaw = live.clench.calibrated?.ok ? "jaw clench checked" : "jaw clench not checked yet";
    const where = live.montage === "face" ? "eye corners + jaw + T7" : live.names.join(" ");
    headsetStatus.textContent = `${live.source}, ${live.fs} Hz, ${where}${stale} · ${jaw}`;
    if (impOn) showImpedance(live.imp.chans, true);
  },
});
async function setImpedance(on) {
  if (!bci.connected) {
    headsetStatus.textContent = "No headset: start tools/ssvep_train.py first.";
    return;
  }
  const result = await bci.impedance(on);
  if (result.error) {
    headsetStatus.textContent = result.error;
    return;
  }
  impOn = on;
  impButton.textContent = on ? "Done: resume EEG" : "Check electrodes (impedance)";
  bci.setInterval(on ? 250 : 500);
  clearTimeout(impTimer);
  if (on) impTimer = setTimeout(() => setImpedance(false), IMP_MAX_S * 1000);
  else showImpedance([], false);
}
impButton.addEventListener("click", () => setImpedance(!impOn));

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
    panel.querySelectorAll("button:not([data-keep]), input").forEach((element) => (element.disabled = true));
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
    if (cameraOpen() && cameraTab.ready) setTimeout(startGaze, 300); // straight back to picking
  };

  // The main thing: the camera tab tracks the eyes (the cube looked at turns yellow) and a jaw
  // clench picks it. Repeats until stopped (Esc, the button again) or no cube is left in reach.
  const gazeButton = document.getElementById("pick-gaze");
  const gazeChooser = ({ onTable, reachable }) => new Promise((resolve) => {
    gazeWait = { resolve, reachable, onTable };
    publishTargets(onTable, null, { reachable: reachable.map((t) => t.id) });
    taskStatus.textContent = "In the camera tab: look at a cube, clench to pick it (Esc stops)";
  });
  stopGaze = () => {
    if (!gazeMode) return;
    gazeMode = false;
    gazeButton.textContent = "Stopping after this pick…";
    if (gazeWait) {
      const { resolve } = gazeWait;
      gazeWait = null;
      resolve({ target: null, line: "Stopped.", cancelled: true });
    }
  };
  const pickWithGaze = async () => {
    if (gazeMode) return stopGaze();
    if (busy) return null;
    if (!cameraOpen()) {
      // The camera tab sets itself up (eyes, jaw) and then starts picking by itself.
      window.open(`camera.html${location.search}`, "pnjex-table-camera");
      taskStatus.textContent = "Opening the camera tab: it calibrates, then picking starts.";
      return null;
    }
    if (impOn) await setImpedance(false);
    gazeMode = true;
    gazeButton.textContent = "Stop";
    let picks = 0;
    let landed = 0;
    let nothingLeft = false;
    await runTask(async () => {
      while (gazeMode) {
        const result = await task.pickCube(gazeChooser);
        if (!result.decision) nothingLeft = true;
        if (!result.decision?.target) break; // stopped, or nothing left to pick
        picks += 1;
        if (result.landed) landed += 1;
      }
    });
    gazeMode = false;
    gazeButton.textContent = "Pick with eyes + clench";
    publishTargets([], null, nothingLeft ? { note: "No cubes left in reach. Press Scatter cubes in the sim tab." } : {});
    if (picks) taskStatus.textContent += ` (${landed} of ${picks} picks landed in the basket)`;
    return { picks, landed };
  };
  startGaze = () => {
    if (!gazeMode && !busy) pickWithGaze();
  };
  gazeButton.addEventListener("click", pickWithGaze);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") stopGaze();
  });

  // Animated rather than instant: a part that jumps through a cube would launch it.
  document.getElementById("home-pose").addEventListener("click", () => runTask(() => moveArm([0, 0, 0, 0], 0)));
  document.getElementById("park-pose").addEventListener("click", () => runTask(park));
  document.getElementById("scatter").addEventListener("click", scatter);
  document.getElementById("open-camera").addEventListener("click", () => {
    window.open(`camera.html${location.search}`, "pnjex-table-camera");
  });
  document.getElementById("reset-view").addEventListener("click", () => {
    camera.position.fromArray(HOME_VIEW.position);
    controls.target.fromArray(HOME_VIEW.target);
    needsRender = true;
  });

  // Console access for trying things out while the sim grows.
  window.sim = { renderer, scene, camera, tableCamera, controls, arm, kinematics, physics, task, requestRender, scatter, pickWithGaze, stopGaze, moveArm, waitForRest, bci };
  requestRender();
  loading.hidden = true;
}

start().catch((error) => {
  console.error(error);
  loadingText.textContent = `Could not load the arm: ${error.message}`;
});
