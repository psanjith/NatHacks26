import * as THREE from "three";
import { createBci } from "../bci.js";
import { createGazeTracker } from "../gaze.js";
import { createWaves } from "../waves.js";
import { createChooser } from "./chooser.js";
import { createGazeLearning } from "./learn.js";
import { BOARD_TOP, GRID, GRID_SIZE, cellCenter } from "./layout.js";
import { CHANNEL, applySnapshot, buildScene, createRenderer } from "./scene.js";

// The camera tab: where the person plays. It shows the table camera's image (the same camera the arm
// uses to find pieces), mirrors the sim tab live, and is the only place with eye tracking.
//   Choosing an X: the view zooms in on your spare X pieces. Each is drawn with the camera's own mask of
//     it (what the detector found); the one you look at lights up yellow, OK makes it green.
//   Choosing a square: the view zooms in on the board; the square you look at lights up with a ghost X.
//   Otherwise (the arm moving, his turn) the view zooms back out to the whole table.
// Eyes: the webcam tracker (../gaze.js) with each person's saved 3D face model and gaze mapping (one dot
// to line it up each session, a full calibration the first time), plus what this tab learns from the
// choices they confirm (learn.js), saved per person. The OK: the headset (../bci.js) or the space bar.

const ASPECT = 4 / 3;
const ZOOM_MARGIN = 0.06; // around what's being chosen, as a share of the image
const MIN_ZOOM = 0.32; // never closer than this share of the image
const CELL_NAMES = ["top left", "top middle", "top right", "middle left", "the centre", "middle right", "bottom left", "bottom middle", "bottom right"];
const COLOURS = { idle: [255, 255, 255], gaze: [255, 200, 40], confirm: [60, 220, 110] };

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const loading = $("loading");
const loadingText = $("loading-text");
const status = $("status");
const promptLine = $("prompt");
const dock = document.querySelector(".dock");
const eyesStatus = $("eyes-status");
const learnStatus = $("learn-status");
const jawFill = $("jaw-fill");
const jawMark = $("jaw-mark");
const jawStatus = $("jaw-status");
const dot = $("gaze-dot");
const layer = $("gaze-layer");
const bubble = $("bubble");
const toastLine = $("toast");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- image + overlay
const renderer = createRenderer();
$("viewport").append(renderer.domElement);
const overlay = document.createElement("canvas");
overlay.className = "overlay";
$("viewport").append(overlay);
const ctx = overlay.getContext("2d");
let ratio = 1;
function fit() {
  const free = window.innerHeight - dock.getBoundingClientRect().height;
  const width = Math.floor(Math.min(window.innerWidth, free * ASPECT));
  const height = Math.floor(width / ASPECT);
  renderer.setSize(width, height);
  ratio = Math.min(window.devicePixelRatio, 2);
  overlay.width = Math.round(width * ratio);
  overlay.height = Math.round(height * ratio);
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
}
window.addEventListener("resize", fit);
fit();
const viewRect = () => renderer.domElement.getBoundingClientRect();

let world = null;
let tableCamera = null;

// Zoom: a crop of the camera image ({ x0, y0, s }: corner and size, shares of the image), eased.
let view = { x0: 0, y0: 0, s: 1 };
let viewGoal = view;
function applyView() {
  if (view.s >= 0.999) tableCamera.clearViewOffset();
  else tableCamera.setViewOffset(4, 3, view.x0 * 4, view.y0 * 3, view.s * 4, view.s * 3);
}
function zoomTo(box) {
  if (!box) {
    viewGoal = { x0: 0, y0: 0, s: 1 };
    return;
  }
  const [u0, v0, u1, v1] = [box[0] - ZOOM_MARGIN, box[1] - ZOOM_MARGIN, box[2] + ZOOM_MARGIN, box[3] + ZOOM_MARGIN];
  const s = Math.min(1, Math.max(u1 - u0, v1 - v0, MIN_ZOOM));
  const clamp = (v) => Math.max(0, Math.min(1 - s, v));
  viewGoal = { x0: clamp((u0 + u1) / 2 - s / 2), y0: clamp((v0 + v1) / 2 - s / 2), s };
}
function stepZoom() {
  const d = Math.abs(view.x0 - viewGoal.x0) + Math.abs(view.y0 - viewGoal.y0) + Math.abs(view.s - viewGoal.s);
  if (d < 1e-4) return;
  const k = d < 0.002 ? 1 : 0.12;
  view = { x0: view.x0 + k * (viewGoal.x0 - view.x0), y0: view.y0 + k * (viewGoal.y0 - view.y0), s: view.s + k * (viewGoal.s - view.s) };
  applyView();
}

// Image (0-1) -> window pixels, through the current zoom.
function imageToWindow([u, v]) {
  const r = viewRect();
  return { x: r.left + ((u - view.x0) / view.s) * r.width, y: r.top + ((v - view.y0) / view.s) * r.height };
}
// World point -> window pixels (and its 0-1 image position, unzoomed, for framing).
const projected = new THREE.Vector3();
function worldToWindow(x, y, z) {
  const r = viewRect();
  projected.set(x, y, z).project(tableCamera);
  return { x: r.left + ((projected.x + 1) / 2) * r.width, y: r.top + ((1 - projected.y) / 2) * r.height, behind: projected.z > 1 };
}
function worldToImage(x, y, z) {
  const p = worldToWindow(x, y, z);
  const r = viewRect();
  return [view.x0 + ((p.x - r.left) / r.width) * view.s, view.y0 + ((p.y - r.top) / r.height) * view.s];
}
const cellCorners = (cell, k = 0.46) => {
  const { x, y } = cellCenter(cell);
  const h = GRID.pitch * k;
  return [[x + h, y + h], [x + h, y - h], [x - h, y - h], [x - h, y + h]].map(([a, b]) => worldToWindow(a, b, BOARD_TOP));
};
function boardBox() {
  const h = GRID_SIZE / 2;
  const pts = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([sx, sy]) => worldToImage(GRID.x + sx * h, GRID.y + sy * h, BOARD_TOP));
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

// Each X's mask (from the detector, in its 640x480 image), as small canvases in three looks.
function maskCanvases({ w, h, bits }) {
  const out = {};
  for (const [state, [r, g, b]] of Object.entries(COLOURS)) {
    const c = document.createElement("canvas");
    c.width = w + 2;
    c.height = h + 2;
    const cx = c.getContext("2d");
    const img = cx.createImageData(w + 2, h + 2);
    const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? bits[y * w + x] : 0);
    for (let y = -1; y <= h; y += 1) {
      for (let x = -1; x <= w; x += 1) {
        const inside = at(x, y);
        const edge = inside && (!at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1));
        const alpha = edge ? 255 : inside ? (state === "idle" ? 40 : 120) : 0;
        const i = ((y + 1) * (w + 2) + (x + 1)) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = state === "idle" && edge ? 150 : alpha;
      }
    }
    cx.putImageData(img, 0, 0);
    out[state] = c;
  }
  return out;
}

// ---------------------------------------------------------------- talking to the sim tab
const channel = new BroadcastChannel(CHANNEL);
let latest = null; // the newest state snapshot
let lastFromSim = -1e9;
let asking = { kind: null, token: 0 }; // what the sim tab is waiting for
let targets = []; // pick: [{ id, center, box, mask, canvases }]
let cells = []; // place: [cell]
let speech = null; // { text, until }
let toastTimer = null;

function showGame({ scores, turn }) {
  $("score-you").textContent = scores.you;
  $("score-him").textContent = scores.him;
  $("score-draw").textContent = scores.draw;
  $("turn").textContent = turn;
}

function onAsk(data) {
  if (!world) return; // still loading: it asks for everything again once loaded
  if (data.kind === asking.kind && data.token === asking.token) return;
  asking = { kind: data.kind, token: data.token };
  targets = [];
  cells = [];
  if (data.kind === "pick") {
    targets = (data.targets ?? []).map((t) => ({ ...t, canvases: maskCanvases(t.mask) }));
    chooser.offer(targets.map((t, i) => ({ id: t.id, name: `Pick this X (${i + 1} of ${targets.length})`, screen: () => imageToWindow(t.center) })), "one of your X's");
    zoomTo([Math.min(...targets.map((t) => t.box[0])), Math.min(...targets.map((t) => t.box[1])), Math.max(...targets.map((t) => t.box[2])), Math.max(...targets.map((t) => t.box[3]))]);
  } else if (data.kind === "place") {
    cells = data.cells ?? [];
    chooser.offer(cells.map((c) => ({ id: c, name: `Put it ${CELL_NAMES[c]}`, screen: () => { const { x, y } = cellCenter(c); return worldToWindow(x, y, BOARD_TOP); } })), "a square");
    zoomTo(boardBox());
  } else {
    chooser.offer([], "");
    zoomTo(null);
    if (data.kind === "again") say("Send OK to play again", 60000);
  }
}

channel.onmessage = ({ data }) => {
  lastFromSim = performance.now();
  if (data.type === "state") latest = data;
  else if (data.type === "ask") onAsk(data);
  else if (data.type === "game") showGame(data);
  else if (data.type === "line") speech = { text: data.text, until: performance.now() + data.ms };
  else if (data.type === "toast") {
    toastLine.textContent = data.text;
    toastLine.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastLine.hidden = true), data.ms);
  } else if (data.type === "camera-ping") broadcast();
};

// ---------------------------------------------------------------- eyes, learning, OK
const gaze = createGazeTracker({ goodErrorPx: Number(params.get("eyeError")) || undefined });
const MOUSE_ONLY = params.get("eyes") === "mouse";
const learning = createGazeLearning();
let mouse = null;
window.addEventListener("mousemove", (event) => (mouse = { x: event.clientX, y: event.clientY }));
let busy = false; // calibrating or checking the OK signal: no choosing
let ready = false;

// The tracker's raw point (window px) for the last few seconds, for "where were the eyes just before OK".
const history = [];
function toView(p) {
  const r = viewRect();
  return [(p.x - r.left) / r.width, (p.y - r.top) / r.height];
}
function fromView([x, y]) {
  const r = viewRect();
  return { x: r.left + x * r.width, y: r.top + y * r.height };
}
// Where the person is looking: the tracker, corrected by what it has learned about them; the mouse without it.
function gazePoint() {
  if (!gaze.calibrated) return mouse;
  const p = gaze.point;
  return p ? fromView(learning.apply(toView(p))) : null;
}
function rawSince(ms) {
  const recent = history.filter((h) => h.t > performance.now() - ms);
  if (recent.length < 3) return null;
  return { x: recent.reduce((s, h) => s + h.x, 0) / recent.length, y: recent.reduce((s, h) => s + h.y, 0) / recent.length };
}

const chooser = createChooser({
  gaze,
  point: gazePoint,
  onFocus: (id, state) => channel.postMessage({ type: "focus", kind: asking.kind, id, state }),
  onPrompt: (text) => {
    if (busy || (speech?.text === "Send OK to play again" && asking.kind === "again")) return;
    promptLine.hidden = !text;
    if (text) promptLine.textContent = text;
  },
  onChoose: (id, { seen, target }) => {
    channel.postMessage({ type: "choose", token: asking.token, id });
    // They were looking at what they chose: learn from it (raw tracker point vs the target's middle).
    if (seen && target) {
      learning.add(toView(seen), toView(target));
      saveLearning();
      showLearning();
    }
  },
});

const personBox = $("person");
let person = (params.get("user") || localStorage.getItem("reach-person") || "prakul").toLowerCase();
personBox.value = person;
const cleanName = (name) => name.toLowerCase().replace(/[^a-z0-9_-]/g, "");

async function loadJson(url, key) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (response.ok) return await response.json();
  } catch { /* fall back to this browser's copy */ }
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
async function saveJson(url, key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* private window */ }
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const result = await response.json();
    return result.ok ? `saved to ${result.file}` : result.error;
  } catch (error) {
    return `saved in this browser only (${error.message})`;
  }
}
const saveLearning = () => saveJson(`gazelearn/${person}.json`, `reach-ttt-learn-${person}`, learning.export());
function showLearning() {
  if (!gaze.calibrated) {
    learnStatus.textContent = "";
    return;
  }
  const s = learning.stats();
  const pct = (v) => (v === null ? "–" : `${(v * 100).toFixed(1)}%`);
  learnStatus.textContent = s.pairs
    ? `Learned from ${s.pairs} of ${person}'s choices (${s.affine ? "offset + stretch" : "offset"}); this session's typical miss ${pct(s.rawMiss)} → ${pct(s.fixedMiss)} of the view`
    : `Learns ${person}'s eyes from each choice they confirm`;
}

async function startWebcam() {
  if (gaze.running) return;
  eyesStatus.textContent = "Eyes: starting the webcam…";
  await gaze.start($("webcam"));
  $("webcam").hidden = false;
  for (let t = 0; !gaze.face && t < 150; t += 1) await sleep(100);
}

// The person's saved profile (one dot to line it up), or a new one (about 45 s), saved for next time.
async function eyesForPerson({ fresh = false } = {}) {
  if (busy) return;
  if (MOUSE_ONLY) {
    eyesStatus.textContent = "Eyes: off (?eyes=mouse): the mouse stands in for your gaze";
    return;
  }
  busy = true;
  promptLine.hidden = true;
  try {
    await startWebcam();
    layer.hidden = false;
    const saved = fresh ? null : await loadJson(`profiles/${person}.json`, `reach-eyes-${person}`);
    const loaded = saved ? gaze.importProfile(saved) : { ok: false, reason: "no saved profile" };
    let line = null;
    if (loaded.ok) {
      const result = await gaze.recenter(layer, viewRect());
      if (result.ok) line = `Eyes: ${person}'s saved face model (±${saved.errorPx} px), lined up`;
    }
    if (!line) {
      const result = await gaze.calibrateProfile(layer, viewRect(), person);
      if (!result.ok) {
        eyesStatus.textContent = `Eyes: calibration didn't work (${result.reason}). The mouse stands in.`;
        return;
      }
      const where = await saveJson(`profiles/${person}.json`, `reach-eyes-${person}`, gaze.exportProfile());
      line = `Eyes: new face model for ${person} (±${result.errorPx} px), ${where}`;
    }
    eyesStatus.textContent = line;
    learning.load(await loadJson(`gazelearn/${person}.json`, `reach-ttt-learn-${person}`));
    learning.newSession();
    showLearning();
  } catch (error) {
    const reason = error.message === "cancelled" ? "calibration cancelled" : error.name === "NotAllowedError" ? "webcam blocked" : error.message;
    eyesStatus.textContent = `Eyes: ${reason}. The mouse stands in for your gaze.`;
  } finally {
    layer.hidden = true;
    busy = false;
  }
}

async function recenterEyes() {
  if (busy || !gaze.calibrated) return;
  busy = true;
  try {
    layer.hidden = false;
    const result = await gaze.recenter(layer, viewRect());
    learning.newSession();
    chooser.say(result.ok ? `Re-centred (moved ${result.shiftPx} px)` : `Re-centre didn't work: ${result.reason}`);
  } catch { /* Esc */ } finally {
    layer.hidden = true;
    busy = false;
  }
}

function say(text, ms = 2500) {
  promptLine.hidden = false;
  promptLine.textContent = text;
  if (ms < 60000) setTimeout(() => { if (promptLine.textContent === text) promptLine.hidden = true; }, ms);
}

function onOk(source) {
  waves.flash();
  jawFill.parentElement.classList.add("fired");
  setTimeout(() => jawFill.parentElement.classList.remove("fired"), 500);
  if (busy) return;
  if (asking.kind === "again") {
    promptLine.hidden = true;
    channel.postMessage({ type: "choose", token: asking.token, id: "again" });
    asking = { kind: null, token: asking.token };
    return;
  }
  if (!chooser.active && !chooser.confirming) {
    chooser.say(asking.kind ? "Hold on…" : "Wait for your turn", 1500);
    return;
  }
  chooser.ok(source, () => (gaze.calibrated ? rawSince(900) : null));
}

const waves = createWaves($("waves"));
const bci = createBci({
  keys: true,
  onClench: onOk,
  onLive: ({ connected, live }) => {
    waves.push(live);
    if (!connected) {
      waves.setMessage("Headset not connected: run tools/ssvep_train.py. Space bar = OK.");
      jawFill.style.width = "0%";
      jawMark.hidden = true;
      jawStatus.textContent = "OK signal: no headset (space bar = OK)";
      return;
    }
    const c = live.clench;
    if (!c.ready) {
      jawStatus.textContent = "OK signal: settling…";
      return;
    }
    jawFill.style.width = `${Math.min(100, (100 * c.level) / 1.6)}%`;
    jawMark.hidden = false;
    jawMark.style.left = `${100 / 1.6}%`;
    jawStatus.textContent = `OK signal (jaw clench for now): ${Math.round(100 * c.level)}% · ${c.used.join(c.agree ? " + " : " or ")}${c.calibrated?.ok ? "" : " · not checked"}`;
  },
});

// Relax 5 s, then send OK and hold it 3 s: the trainer sets the threshold.
async function okCheck() {
  if (!bci.connected) {
    chooser.say("No headset: start tools/ssvep_train.py first. The space bar works as OK meanwhile.", 4000);
    return null;
  }
  busy = true;
  const countdown = async (text, seconds) => {
    for (let s = seconds; s > 0; s -= 1) {
      say(`${text} ${s}`, 1100);
      await sleep(1000);
    }
  };
  let result = null;
  try {
    await bci.calibrateClench("rest");
    await countdown("OK check: relax…", 5);
    await bci.calibrateClench("clench");
    await countdown("Now send OK and HOLD it…", 3);
    result = await bci.calibrateClench("done");
    say(result.error ? `OK check: ${result.error}` : result.verdict, 5000);
  } catch (error) {
    say(`OK check failed: ${error.message}`, 5000);
  } finally {
    busy = false;
  }
  return result;
}

function broadcast() {
  channel.postMessage({ type: "camera-status", ready, eyes: gaze.calibrated, headset: bci.connected, ok: Boolean(bci.live?.clench?.calibrated?.ok) });
}
setInterval(broadcast, 2000);

// ---------------------------------------------------------------- drawing
function drawOverlay() {
  const r = viewRect();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  const local = (p) => ({ x: p.x - r.left, y: p.y - r.top });
  const stateOf = (id) => (chooser.confirming === id ? "confirm" : chooser.gazed === id ? "gaze" : "idle");
  if (asking.kind === "pick") {
    ctx.imageSmoothingEnabled = true;
    for (const t of targets) {
      const { x, y, w, h, width, height } = t.mask;
      const a = local(imageToWindow([(x - 1) / width, (y - 1) / height]));
      const b = local(imageToWindow([(x + w + 1) / width, (y + h + 1) / height]));
      const state = stateOf(t.id);
      ctx.drawImage(t.canvases[state], a.x, a.y, b.x - a.x, b.y - a.y);
      if (state !== "idle") {
        const c = local(imageToWindow([t.box[0], t.box[1]]));
        ctx.font = "600 14px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillStyle = state === "confirm" ? "#3cdc6e" : "#ffc828";
        ctx.fillText(state === "confirm" ? "Picking this X" : "This X?", c.x, c.y - 8);
      }
    }
  } else if (asking.kind === "place") {
    for (const cell of cells) {
      const state = stateOf(cell);
      const quad = cellCorners(cell).map(local);
      ctx.beginPath();
      quad.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      const [cr, cg, cb] = COLOURS[state];
      ctx.lineWidth = state === "idle" ? 1.5 : 3;
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${state === "idle" ? 0.45 : 1})`;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${state === "idle" ? 0.06 : 0.28})`;
      ctx.fill();
      ctx.stroke();
      if (state !== "idle") {
        // A ghost X where it would go, at 45° like the arm will put it.
        const { x, y } = cellCenter(cell);
        const k = GRID.pitch * 0.3;
        ctx.lineWidth = 6;
        ctx.lineCap = "round";
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.9)`;
        for (const [[x0, y0], [x1, y1]] of [[[x + k, y + k], [x - k, y - k]], [[x + k, y - k], [x - k, y + k]]]) {
          const p = local(worldToWindow(x0, y0, BOARD_TOP));
          const q = local(worldToWindow(x1, y1, BOARD_TOP));
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
        }
      }
    }
  }
}

function placeBubble(now) {
  if (!speech || now > speech.until || speech.text === "Send OK to play again") {
    bubble.hidden = true;
    return;
  }
  const r = viewRect();
  const p = world.bm.mouthSide(1);
  const s = worldToWindow(p.x, p.y, p.z);
  bubble.hidden = false;
  const inView = !s.behind && s.x > r.left && s.x < r.right - 40 && s.y > r.top + 40 && s.y < r.bottom;
  bubble.textContent = inView ? speech.text : `Mr. Pemberton: ${speech.text}`;
  const width = bubble.offsetWidth;
  const x = inView ? Math.min(r.right - width - 8, s.x + 12) : r.right - width - 12;
  const y = inView ? Math.max(r.top + 50, s.y - 20) : r.top + 50;
  bubble.style.transform = `translate(${x}px, ${y}px)`;
}

function drawDot() {
  const p = gaze.calibrated ? gazePoint() : null;
  if (!dot.dataset.on || !p || busy) {
    dot.hidden = true;
    return;
  }
  dot.hidden = false;
  dot.style.transform = `translate(${Math.max(8, Math.min(innerWidth - 8, p.x))}px, ${Math.max(8, Math.min(innerHeight - 8, p.y))}px)`;
  dot.classList.toggle("away", gaze.away);
  dot.classList.toggle("talking", gaze.talking);
}

let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (latest) {
    applySnapshot(latest, world);
    world.bm.apply(dt, now / 1000);
  }
  if (gaze.calibrated && gaze.point) {
    history.push({ t: now, ...gaze.point });
    while (history.length && history[0].t < now - 3000) history.shift();
  }
  stepZoom();
  if (!busy) chooser.tick(now);
  renderer.render(world.scene, tableCamera);
  drawOverlay();
  placeBubble(now);
  drawDot();
  const simGone = now - lastFromSim > 3000;
  status.hidden = !simGone;
  if (simGone) status.textContent = "The sim tab isn't running: open ttt.html (it moves the arm and plays Mr. Pemberton).";
}

// ---------------------------------------------------------------- start
personBox.addEventListener("change", () => {
  const name = cleanName(personBox.value);
  if (!name || name === person) return;
  person = name;
  personBox.value = name;
  try { localStorage.setItem("reach-person", name); } catch { /* fine */ }
  eyesForPerson();
});
personBox.addEventListener("keydown", (event) => event.stopPropagation());
$("recalibrate").addEventListener("click", (event) => {
  event.currentTarget.blur();
  eyesForPerson({ fresh: true });
});
$("ok-check").addEventListener("click", (event) => {
  event.currentTarget.blur();
  okCheck();
});
window.addEventListener("keydown", (event) => {
  if (event.target.closest?.("input")) return;
  if (event.key === "Escape") chooser.escape();
  else if (event.key === "r" || event.key === "R") recenterEyes();
  else if (event.key === "d" || event.key === "D") {
    if (dot.dataset.on) delete dot.dataset.on;
    else dot.dataset.on = "1";
  }
});

async function start() {
  world = await buildScene(renderer, {
    nextFrame: () => new Promise((resolve) => requestAnimationFrame(resolve)),
    onProgress: (f) => (loadingText.textContent = `Loading arm ${Math.round(f * 100)}%`),
  });
  tableCamera = world.tableCamera;
  world.highlights.group.visible = false; // this tab draws its own highlights over the image
  renderer.setAnimationLoop(frame);
  loading.hidden = true;
  channel.postMessage({ type: "request-state" });
  if (document.visibilityState !== "visible") {
    status.hidden = false;
    status.textContent = "Bring this tab to the front to start the eye tracker.";
    await new Promise((resolve) => document.addEventListener("visibilitychange", function on() {
      if (document.visibilityState === "visible") {
        document.removeEventListener("visibilitychange", on);
        resolve();
      }
    }));
  }
  await eyesForPerson();
  for (let t = 0; !bci.connected && t < 15; t += 1) await sleep(100); // the headset's first poll
  if (bci.connected && !bci.live?.clench?.calibrated?.ok) await okCheck();
  ready = true;
  broadcast();
  showLearning();
  window.tttCam = { world, chooser, learning, gaze, get view() { return view; }, get asking() { return asking; }, get targets() { return targets; }, get cells() { return cells; }, imageToWindow, worldToWindow, cellCenter };
}

start().catch((error) => {
  console.error(error);
  loadingText.textContent = `Could not start: ${error.message}`;
});
