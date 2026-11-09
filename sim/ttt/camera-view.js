import * as THREE from "three";
import { createBci, headsetProblem } from "../bci.js";
import { createGazeTracker } from "../gaze.js";
import { createWaves } from "../waves.js";
import { createChooser } from "./chooser.js";
import { createGazeLearning } from "./learn.js";
import { BOARD_TOP, CAMERA, GRID, GRID_SIZE, cellCenter } from "./layout.js";
import { CHANNEL, buildScene, createMirror, createRenderer } from "./scene.js";

// The camera tab: where the person plays. Everything here comes from one camera, the table camera
// (a 4K webcam, layout.js), the same one the arm uses to find pieces. Each frame is rendered once
// at the camera's own resolution, and every view is a crop of that frame, scaled up like a digital
// zoom on a real video feed: nothing is re-rendered sharper than the camera could see it. The view
// follows the turn by itself:
//   Your turn, choosing an X: a crop around your spare X pieces. Each is drawn with the camera's own mask
//     of it (what the detector found); the one you look at lights up yellow, OK makes it green.
//   Your turn, choosing a square: the board view, a crop around the board; the square you look at lights
//     up with a ghost X.
//   Otherwise (the arm moving, his turn): the player view, the whole frame.
// The small view in the dock shows the whole frame while the big one is zoomed (with the crop marked),
// and the board otherwise. It mirrors the sim tab live, and is the only place with eye tracking.
// Eyes: the webcam tracker (../gaze.js) with each person's saved 3D face model and gaze mapping (five
// dots to line it up each session, a full calibration the first time), plus what this tab learns from
// the choices they confirm (learn.js), saved per person. The OK: the headset (../bci.js) or the space bar.

const ASPECT = CAMERA.width / CAMERA.height;
const ZOOM_MARGIN = 0.05; // around what's being chosen, as a share of the image
const MIN_ZOOM = 0.3; // never closer than this share of the frame
const CELL_NAMES = ["top left", "top middle", "top right", "middle left", "the centre", "middle right", "bottom left", "bottom middle", "bottom right"];
const COLOURS = { idle: [255, 255, 255], gaze: [255, 200, 40], confirm: [60, 220, 110] };
const FULL = { x0: 0, y0: 0, s: 1 };

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
const caption = $("view-caption");
const pip = $("pip");
const pipLabel = $("pip-label");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- the camera's frame, and views of it
// The camera's sensor: a canvas the size of its frame, never shown as is.
// Only the part of the frame on screen is drawn, at the camera's own pixel density (or the screen's, if
// that's lower): the same picture as drawing the whole 4K frame and cropping it, for a fraction of the
// work. The canvas below is the drawing surface for that, never shown as is.
const renderer = createRenderer();
renderer.setPixelRatio(1);
renderer.shadowMap.autoUpdate = false; // shadows are worked out once a frame, not once per view drawn
const sensor = renderer.domElement;
// What's shown: a crop of that frame, scaled to fit, with the choosing highlights drawn on top.
const screen = document.createElement("canvas");
screen.className = "frame";
$("viewport").append(screen);
const ctx = screen.getContext("2d");
const pipCtx = pip.getContext("2d");
let ratio = 1;
function fit() {
  const free = window.innerHeight - dock.getBoundingClientRect().height;
  const width = Math.floor(Math.min(window.innerWidth, free * ASPECT));
  const height = Math.floor(width / ASPECT);
  ratio = Math.min(window.devicePixelRatio, 2);
  screen.width = Math.round(width * ratio);
  screen.height = Math.round(height * ratio);
  screen.style.width = `${width}px`;
  screen.style.height = `${height}px`;
  const box = pip.getBoundingClientRect();
  pip.width = Math.round(box.width * ratio);
  pip.height = Math.round(box.height * ratio);
  renderer.setSize(Math.max(screen.width, pip.width, 2), Math.max(screen.height, pip.height, 2), false);
  // The caption sits on the picture's own corner.
  const r = screen.getBoundingClientRect();
  caption.style.left = `${Math.max(12, r.left + 10)}px`;
}
window.addEventListener("resize", fit);
fit();
const viewRect = () => screen.getBoundingClientRect();

let world = null;
let tableCamera = null;

// A view is a crop of the frame ({ x0, y0, s }: corner and size, as shares of the frame), eased.
let view = FULL;
let viewGoal = FULL;
let viewName = "player";
function cropAround(box) {
  const [u0, v0, u1, v1] = [box[0] - ZOOM_MARGIN, box[1] - ZOOM_MARGIN, box[2] + ZOOM_MARGIN, box[3] + ZOOM_MARGIN];
  const s = Math.min(1, Math.max(u1 - u0, v1 - v0, MIN_ZOOM));
  const clamp = (v) => Math.max(0, Math.min(1 - s, v));
  return { x0: clamp((u0 + u1) / 2 - s / 2), y0: clamp((v0 + v1) / 2 - s / 2), s };
}
const boardCrop = () => cropAround(boardBox());
function show(name, crop) {
  viewName = name;
  viewGoal = crop;
}
function stepZoom() {
  const d = Math.abs(view.x0 - viewGoal.x0) + Math.abs(view.y0 - viewGoal.y0) + Math.abs(view.s - viewGoal.s);
  if (d < 1e-4) return;
  const k = d < 0.002 ? 1 : 0.12;
  view = { x0: view.x0 + k * (viewGoal.x0 - view.x0), y0: view.y0 + k * (viewGoal.y0 - view.y0), s: view.s + k * (viewGoal.s - view.s) };
}

// Image (0-1 of the whole frame) -> window pixels, through the current crop.
function imageToWindow([u, v]) {
  const r = viewRect();
  return { x: r.left + ((u - view.x0) / view.s) * r.width, y: r.top + ((v - view.y0) / view.s) * r.height };
}
// World point -> its place in the whole frame (0-1), and -> window pixels through the crop.
const projected = new THREE.Vector3();
function worldToImage(x, y, z) {
  projected.set(x, y, z).project(tableCamera);
  return [(projected.x + 1) / 2, (1 - projected.y) / 2];
}
function worldToWindow(x, y, z) {
  const p = imageToWindow(worldToImage(x, y, z));
  p.behind = projected.z > 1;
  return p;
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

// Each X's mask (from the detector, in the camera's full frame), as small canvases in three looks.
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
        // Nothing over an X nobody is looking at (a white tint washed its colour out); the camera's mask
        // shows, outlined and tinted, on the one being looked at or picked.
        const alpha = state === "idle" ? 0 : edge ? 255 : inside ? 110 : 0;
        const i = ((y + 1) * (w + 2) + (x + 1)) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = alpha;
      }
    }
    cx.putImageData(img, 0, 0);
    out[state] = c;
  }
  return out;
}

// ---------------------------------------------------------------- talking to the sim tab
const channel = new BroadcastChannel(CHANNEL);
let mirror = null; // the sim's state, blended for smooth motion (scene.js)
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
    show("xs", cropAround([Math.min(...targets.map((t) => t.box[0])), Math.min(...targets.map((t) => t.box[1])), Math.max(...targets.map((t) => t.box[2])), Math.max(...targets.map((t) => t.box[3]))]));
  } else if (data.kind === "place") {
    cells = data.cells ?? [];
    chooser.offer(cells.map((c) => ({ id: c, name: `Put it ${CELL_NAMES[c]}`, screen: () => { const { x, y } = cellCenter(c); return worldToWindow(x, y, BOARD_TOP); } })), "a square");
    show("board", boardCrop());
  } else {
    chooser.offer([], "");
    show("player", FULL);
    if (data.kind === "again") say("Send OK to play again", 60000);
  }
}

// The sim tab this tab follows: the newest one (sim tabs say hello when they start). Messages from any
// other sim tab, including ones still running older code, are ignored.
let simId = null;
const send = (message) => channel.postMessage({ ...message, to: simId });
channel.onmessage = ({ data }) => {
  if (!data.sim) return; // older sim code: no id
  if (data.type === "sim-hello" && data.sim !== simId) {
    simId = data.sim;
    mirror?.reset();
    asking = { kind: null, token: 0 };
    send({ type: "request-state" });
    return;
  }
  if (simId === null) simId = data.sim;
  if (data.sim !== simId) return;
  lastFromSim = performance.now();
  if (data.type === "state") mirror?.push(data);
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
  onFocus: (id, state) => send({ type: "focus", kind: asking.kind, id, state }),
  onPrompt: (text) => {
    if (busy || (speech?.text === "Send OK to play again" && asking.kind === "again")) return;
    promptLine.hidden = !text;
    if (text) promptLine.textContent = text;
  },
  onChoose: (id, { seen, target }) => {
    send({ type: "choose", token: asking.token, id });
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

// The person's saved profile (five dots to line it up), or a new one (about 45 s), saved for next time.
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
      if (result.ok) line = `Eyes: ${person}'s saved face model, lined up on ${result.dots} dots (within ${result.fitPx} px)${result.fitPx > 2 * saved.errorPx ? `. That's much worse than when it was made (${saved.errorPx} px): press New eye profile` : ""}`;
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
    chooser.say(result.ok ? `Lined up again (moved ${result.shiftPx} px, within ${result.fitPx} px)` : `Lining up didn't work: ${result.reason}`);
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
    send({ type: "choose", token: asking.token, id: "again" });
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
let headsetWas = false; // connected at the last poll
const bci = createBci({
  keys: true,
  onClench: onOk,
  onLive: ({ connected, live }) => {
    waves.push(live);
    if (!connected) {
      headsetWas = false;
      waves.setMessage(`${headsetProblem(bci)} Space bar = OK.`);
      jawFill.style.width = "0%";
      jawMark.hidden = true;
      jawStatus.textContent = `OK signal: ${bci.trainer ? "no data from the headset" : "no headset"} (space bar = OK)`;
      return;
    }
    // The headset just came (back) and its OK signal hasn't been checked: check it now.
    if (!headsetWas && ready && !busy && !live.clench.calibrated?.ok) setTimeout(() => !busy && okCheck().then(broadcast), 500);
    headsetWas = true;
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
    chooser.say(`${headsetProblem(bci)} The space bar works as OK meanwhile.`, 5000);
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
  send({ type: "camera-status", ready, eyes: gaze.calibrated, headset: bci.connected, ok: Boolean(bci.live?.clench?.calibrated?.ok) });
}
setInterval(broadcast, 2000);

// ---------------------------------------------------------------- drawing
// The crop of the camera's frame, scaled to the screen.
// Draws one crop of the camera's frame onto a canvas: renders just that part of the view, at no more
// than the camera's pixels in it, then scales it to the canvas.
function shoot(crop, canvas, c2d) {
  const w = Math.max(2, Math.min(canvas.width, Math.round(crop.s * CAMERA.width)));
  const h = Math.max(2, Math.round((w * CAMERA.height) / CAMERA.width));
  if (crop.s < 0.999) tableCamera.setViewOffset(CAMERA.width, CAMERA.height, crop.x0 * CAMERA.width, crop.y0 * CAMERA.height, crop.s * CAMERA.width, crop.s * CAMERA.height);
  renderer.setViewport(0, 0, w, h);
  renderer.render(world.scene, tableCamera);
  tableCamera.clearViewOffset(); // the overlay projects with the whole frame
  c2d.setTransform(1, 0, 0, 1, 0, 0);
  c2d.imageSmoothingEnabled = true;
  c2d.imageSmoothingQuality = "high";
  c2d.drawImage(sensor, 0, sensor.height - h, w, h, 0, 0, canvas.width, canvas.height);
}
function drawFrame() {
  shoot(view, screen, ctx);
}

// The small view in the dock: the board when the big one shows the whole frame, otherwise the whole
// frame with the big view's crop marked on it.
function drawPip() {
  if (!pip.width || !pip.height) return;
  const pipShows = viewName === "player" ? "board" : "player";
  const crop = pipShows === "board" ? boardCrop() : FULL;
  shoot(crop, pip, pipCtx);
  if (pipShows === "player" && view.s < 0.999) {
    pipCtx.lineWidth = 2 * ratio;
    pipCtx.strokeStyle = "#ffcf6e";
    pipCtx.strokeRect(view.x0 * pip.width, view.y0 * pip.height, view.s * pip.width, view.s * pip.height);
  }
  const label = pipShows === "board" ? "Board view" : "Player view (whole frame)";
  if (pipLabel.textContent !== label) pipLabel.textContent = label;
}

// What the big view is, in camera pixels: a crop is only ever the camera's own pixels, scaled up.
function drawCaption() {
  const name = { player: "Player view", board: "Board view", xs: "Your X's" }[viewName];
  const w = Math.round(view.s * CAMERA.width);
  const h = Math.round(view.s * CAMERA.height);
  const text = view.s > 0.999
    ? `${name} · the camera's whole ${CAMERA.width}×${CAMERA.height} frame`
    : `${name} · ${w}×${h} of the camera's ${CAMERA.width}×${CAMERA.height} pixels (digital zoom ${(1 / view.s).toFixed(1)}×)`;
  if (caption.textContent !== text) caption.textContent = text;
}

function drawOverlay() {
  const r = viewRect();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
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

// The gaze dot glides to where the eyes are (about 60 ms to get most of the way) instead of jumping.
let dotAt = null;
function drawDot() {
  const p = gaze.calibrated ? gazePoint() : null;
  if (!dot.dataset.on || !p || busy) {
    dot.hidden = true;
    dotAt = null;
    return;
  }
  dot.hidden = false;
  dotAt = dotAt ? { x: dotAt.x + 0.3 * (p.x - dotAt.x), y: dotAt.y + 0.3 * (p.y - dotAt.y) } : { ...p };
  dot.style.transform = `translate(${Math.max(8, Math.min(innerWidth - 8, dotAt.x))}px, ${Math.max(8, Math.min(innerHeight - 8, dotAt.y))}px)`;
  dot.classList.toggle("away", gaze.away);
  dot.classList.toggle("talking", gaze.talking);
}

// Every screen frame: tell the sim tab to step (it's in the background, where the browser slows its own
// timers), pose the mirror for this moment, draw the camera's frame, and show a crop of it.
let last = performance.now();
let frames = 0;
function frame() {
  const now = performance.now();
  send({ type: "tick" });
  if (gaze.calibrated && gaze.point) {
    history.push({ t: now, ...gaze.point });
    while (history.length && history[0].t < now - 3000) history.shift();
  }
  stepZoom();
  if (!busy) chooser.tick(now);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (mirror.apply()) world.bm.apply(dt, now / 1000);
  renderer.shadowMap.needsUpdate = true;
  drawFrame();
  drawOverlay();
  if ((frames += 1) % 2 === 0) drawPip(); // the small view at half the rate: it's small

  drawCaption();
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
  if ((event.key === "m" || event.key === "M") && !event.repeat) onOk("key"); // M = OK, like a clench (or Space)
  else if (event.key === "Escape") chooser.escape();
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
  mirror = createMirror(world);
  world.highlights.group.visible = false; // this tab draws its own highlights over the image
  show("player", FULL);
  renderer.setAnimationLoop(frame);
  loading.hidden = true;
  send({ type: "request-state" });
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
  window.tttCam = { world, chooser, learning, gaze, sensor, boardCrop, worldToImage, get view() { return view; }, get viewName() { return viewName; }, get asking() { return asking; }, get targets() { return targets; }, get cells() { return cells; }, imageToWindow, worldToWindow, cellCenter };
}

start().catch((error) => {
  console.error(error);
  loadingText.textContent = `Could not start: ${error.message}`;
});
