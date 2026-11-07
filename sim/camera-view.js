import { loadArm } from "./arm.js";
import { detectObjects } from "./detect.js";
import { createOverlay } from "./overlay.js";
import { STATE_CHANNEL, createRenderer, createScene } from "./scene.js";

const ASPECT = 4 / 3;
const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const status = document.getElementById("status");
const detectButton = document.getElementById("detect");
const flickerButton = document.getElementById("flicker");
const clearButton = document.getElementById("clear");
const detectStatus = document.getElementById("detect-status");

const renderer = createRenderer();
document.getElementById("viewport").append(renderer.domElement);
const { scene, tableCamera } = createScene(renderer);
const overlay = createOverlay(document.getElementById("viewport"));

let needsRender = true;
const requestRender = () => {
  needsRender = true;
  renderer.shadowMap.needsUpdate = true;
};

// Largest 4:3 frame that fits the window, so the image matches the camera.
function fit() {
  const width = Math.min(window.innerWidth, window.innerHeight * ASPECT);
  renderer.setSize(Math.floor(width), Math.floor(width / ASPECT));
  overlay.resize(Math.floor(width), Math.floor(width / ASPECT));
  needsRender = true;
}
window.addEventListener("resize", fit);
fit();

renderer.setAnimationLoop(() => {
  if (!needsRender) return;
  needsRender = false;
  renderer.render(scene, tableCamera);
});

async function start() {
  const arm = await loadArm((fraction) => {
    loadingText.textContent = `Loading arm ${Math.round(fraction * 100)}%`;
  });
  scene.add(arm.root);


  const setFlicker = (on) => {
    const flickering = overlay.setFlicker(on);
    flickerButton.textContent = flickering ? "Stop flicker" : "Start flicker";
    flickerButton.setAttribute("aria-pressed", String(flickering));
  };
  const detect = () => {
    const targets = detectObjects(renderer, scene, tableCamera, scene.getObjectByName("objects"));
    overlay.setTargets(targets);
    setFlicker(false);
    requestRender();
    const extra = Math.max(0, targets.length - overlay.frequencyCount);
    detectStatus.textContent = `${targets.length} object${targets.length === 1 ? "" : "s"} detected` +
      (extra ? `, ${extra} without a flicker frequency` : "");
    flickerButton.disabled = clearButton.disabled = targets.length === 0;
    return targets;
  };
  detectButton.addEventListener("click", detect);
  flickerButton.addEventListener("click", () => {
    setFlicker(flickerButton.getAttribute("aria-pressed") !== "true");
  });
  clearButton.addEventListener("click", () => {
    overlay.setTargets([]);
    setFlicker(false);
    detectStatus.textContent = "";
    flickerButton.disabled = clearButton.disabled = true;
  });
  detectButton.disabled = false;

  const channel = new BroadcastChannel(STATE_CHANNEL);
  channel.onmessage = ({ data }) => {
    if (data.type === "state") {
      for (const [name, value] of Object.entries(data.joints)) {
        if (arm.joints.has(name)) arm.setJoint(name, value);
      }
      for (const { id, position, quaternion } of data.objects) {
        const cube = scene.getObjectByName(id);
        cube?.position.fromArray(position);
        cube?.quaternion.fromArray(quaternion);
      }
      status.hidden = true;
      requestRender();
    } else if (data.type === "targets") {
      overlay.setTargets(data.targets, data.selected);
      setFlicker(false);
      detectStatus.textContent = data.selected ? `Sim picked target ${data.selected}` : "";
      flickerButton.disabled = clearButton.disabled = data.targets.length === 0;
    }
  };
  channel.postMessage({ type: "request-state" });

  window.sim = { scene, tableCamera, arm, requestRender, detect, overlay };
  requestRender();
  loading.hidden = true;
}

start().catch((error) => {
  console.error(error);
  loadingText.textContent = `Could not load the arm: ${error.message}`;
});
