import { loadArm } from "./arm.js";
import { createBci } from "./bci.js";
import { createGazeTracker } from "./gaze.js";
import { createOverlay } from "./overlay.js";
import { STATE_CHANNEL, createRenderer, createScene } from "./scene.js";
import { createWaves } from "./waves.js";

// The person's screen: the table camera, the cube they look at turns yellow, a jaw clench picks it.
// On opening it sets itself up (webcam -> 9-dot eye calibration -> glance check if there are eye-corner
// electrodes -> clench check) and then tells the sim tab to start picking.
// Choosing a cube: "eyes" (webcam, the nearest cube to the gaze), or "glance" (eye-corner electrodes:
// glance at the left/right edge of the screen to move the highlight one cube). Glance mode is used when
// the webcam isn't calibrated or can't track the eyes (face lost, image too dark, tracking too shaky;
// see checkTracking); G switches between the two.
// Once the arm holds the cube, the same controls choose where it goes: look at a spot on the table (a
// ghost cube shows green if it passes the checks, red if not) or the basket, and clench.
const ASPECT = 4 / 3;
const DWELL_MS = 300; // the gaze must stay nearest one cube this long before it turns yellow
const SWITCH_RATIO = 0.8; // and be clearly closer to it than to the yellow one (no flicker between neighbours)
const HOLD_LOST_MS = 1500; // face lost this briefly (a blink, a glance at the arm): keep the yellow cube
const GLANCE_AFTER_MS = 2500; // face lost longer than this and glances are set up: switch to glances
const STEADY_MS = 400; // and stay on it this long before a clench picks it (no picking mid-glance)
// After a clench: this long to cancel with another clench. The headset needs longer: a clench only
// registers after ~0.6 s of holding, and the detector waits for the jaw to relax before it can count
// another, so "see it turn green, relax, clench again" takes 1.4 s even with perfect timing (measured).
const CONFIRM_MS = { eeg: 3000, key: 1500 };
const cancelHint = (c) => {
  const left = Math.max(0, Math.ceil((c.until - performance.now()) / 1000));
  return `${c.source === "eeg" ? "relax, then clench again" : "clench again"} to cancel (${left} s)`;
};
const MAX_GAZE_DISTANCE = 0.45; // gaze further than this (x image width) from every cube = none
const MAX_SPOT_DISTANCE = 0.12; // place mode: gaze further than this (x image width) from every spot = none

// When the webcam can't track the eyes, switch to the headset's glances (if they're set up).
// Thresholds are relative to the last calibration or re-centre, so they work with any webcam or room.
const DARK_RATIO = 0.4; // image darker than this share of its calibration brightness = too dark
const BRIGHT_AGAIN_RATIO = 0.55; // and back above this to count as bright enough again (a gap, so it doesn't flicker)
const SHAKY_RATIO = 3; // gaze jumping more than this many times its calibration jitter = too shaky
const CALM_RATIO = 2; // and back below this to count as steady again
const MIN_SHAKY_PX = 40; // never call it shaky below this, whatever the calibration jitter was
const DEFAULT_JITTER_PX = 12; // calibration jitter, if it wasn't measured
const DARK_MS = 1000; // too dark for this long: switch
const SHAKY_MS = 1500; // too shaky for this long: switch
const GOOD_MS = 2000; // everything fine for this long: back to the webcam
const TROUBLE = {
  face: "Can't see your face in the webcam",
  dark: "The webcam image is too dark",
  shaky: "Eye tracking is too shaky",
};

const $ = (id) => document.getElementById(id);
const loading = $("loading");
const loadingText = $("loading-text");
const status = $("status");
const promptLine = $("prompt");
const dock = document.querySelector(".dock");
const eyesStatus = $("eyes-status");
const jawFill = $("jaw-fill");
const jawMark = $("jaw-mark");
const jawStatus = $("jaw-status");
const webcam = $("webcam");
const dot = $("gaze-dot");
const layer = $("gaze-layer");

const renderer = createRenderer();
$("viewport").append(renderer.domElement);
const { scene, tableCamera } = createScene(renderer);
const overlay = createOverlay($("viewport"));
const waves = createWaves($("waves"));

let needsRender = true;
const requestRender = () => {
  needsRender = true;
  renderer.shadowMap.needsUpdate = true;
};

// Largest 4:3 frame that fits above the dock, so the image matches the camera.
function fit() {
  const free = window.innerHeight - dock.getBoundingClientRect().height;
  const width = Math.min(window.innerWidth, free * ASPECT);
  renderer.setSize(Math.floor(width), Math.floor(width / ASPECT));
  overlay.resize(Math.floor(width), Math.floor(width / ASPECT));
  needsRender = true;
}
window.addEventListener("resize", fit);
fit();

// ---------------------------------------------------------------- zoom in on the cubes (a crop of the camera image)
let view = { x0: 0, y0: 0, s: 1 };
let viewGoal = view;
function applyView(v) {
  if (v.s >= 0.999) tableCamera.clearViewOffset();
  else tableCamera.setViewOffset(4, 3, v.x0 * 4, v.y0 * 3, v.s * 4, v.s * 3);
  overlay.setView(v);
}
function updateZoom() {
  const targets = place ? place.spots : overlay.targets;
  if (!targets.length) {
    viewGoal = { x0: 0, y0: 0, s: 1 };
    return;
  }
  const xs = targets.flatMap((t) => [t.box[0], t.box[2]]);
  const ys = targets.flatMap((t) => [t.box[1], t.box[3]]);
  const [x0, x1] = [Math.min(...xs) - 0.07, Math.max(...xs) + 0.07];
  const [y0, y1] = [Math.min(...ys) - 0.07, Math.max(...ys) + 0.1]; // room for the labels below
  const s = Math.min(1, Math.max(x1 - x0, y1 - y0, 0.4));
  const clamp = (v) => Math.max(0, Math.min(1 - s, v));
  viewGoal = { x0: clamp((x0 + x1) / 2 - s / 2), y0: clamp((y0 + y1) / 2 - s / 2), s };
}
function stepZoom() {
  const d = Math.abs(view.x0 - viewGoal.x0) + Math.abs(view.y0 - viewGoal.y0) + Math.abs(view.s - viewGoal.s);
  if (d < 1e-4) return;
  const k = d < 0.002 ? 1 : 0.15;
  view = { x0: view.x0 + k * (viewGoal.x0 - view.x0), y0: view.y0 + k * (viewGoal.y0 - view.y0), s: view.s + k * (viewGoal.s - view.s) };
  applyView(view);
  requestRender();
}

// ---------------------------------------------------------------- eyes + clench
// ?eyeError=150 relaxes (or tightens) how good an eye calibration must be, in px.
const gaze = createGazeTracker({ goodErrorPx: Number(new URLSearchParams(location.search).get("eyeError")) || undefined });
let mouse = null;
window.addEventListener("mousemove", (event) => (mouse = { x: event.clientX, y: event.clientY }));
let channel = null;
let ready = false; // set-up finished
let armWaiting = false; // the sim tab is waiting for this person to pick a cube
let gazed = null;
let gazedSince = 0;
let candidate = null;
let candidateSince = 0;
let confirm = null; // { id, timer } during the cancel window
let busy = false; // calibrating eyes or checking the clench: clenches don't pick
let promptOverride = null; // { text, until }
let forceGlance = false; // G: glances choose even though the webcam works
let faceLostSince = null;
let awaySince = null;
let webcamTrouble = null; // null, or why the webcam can't track the eyes: "face" | "dark" | "shaky"
let darkSince = null;
let shakySince = null;
let goodSince = null;
// Place mode: the arm holds a cube and waits for where to put it.
let place = null; // { spots, suggested, sent }
let placeGazed = null;
let placeGazedSince = 0;
let placeCandidate = null;
let placeCandidateSince = 0;
let placeConfirm = null; // { id, timer } during the cancel window

const gazePoint = () => (gaze.calibrated ? gaze.point : mouse);
const glanceReady = () => Boolean(bci?.live?.eog?.amp);
function selectMode() {
  if (glanceReady() && (forceGlance || !gaze.calibrated || webcamTrouble)) return "glance";
  return gaze.calibrated ? "eyes" : "mouse"; // no glances set up: stay on the webcam (with a warning)
}

// Decides whether the webcam can track the eyes. Switching away needs the problem to last a moment
// (DARK_MS, SHAKY_MS, GLANCE_AFTER_MS); switching back needs everything fine for GOOD_MS, with a gap
// between the two thresholds, so it doesn't bounce between modes when the light is borderline.
function checkTracking(now) {
  if (!gaze.calibrated || !gaze.running) {
    webcamTrouble = null;
    darkSince = shakySince = goodSince = null;
    return;
  }
  const q = gaze.quality;
  const ratio = q.brightness !== null && q.refBrightness ? q.brightness / q.refBrightness : 1;
  const ref = q.refJitter ?? DEFAULT_JITTER_PX;
  const dark = ratio < DARK_RATIO;
  const shaky = q.jitter !== null && q.jitter > Math.max(MIN_SHAKY_PX, SHAKY_RATIO * ref);
  darkSince = dark ? darkSince ?? now : null;
  shakySince = shaky ? shakySince ?? now : null;
  const faceGone = faceLostSince !== null && now - faceLostSince > GLANCE_AFTER_MS;
  const darkLong = darkSince !== null && now - darkSince > DARK_MS;
  const shakyLong = shakySince !== null && now - shakySince > SHAKY_MS;
  const reason = darkLong ? "dark" : faceGone ? "face" : shakyLong ? "shaky" : null;
  if (!webcamTrouble) {
    if (!reason) return;
    webcamTrouble = reason;
    goodSince = null;
    say(glanceReady() ? `${TROUBLE[reason]}: choosing with eye glances` : `${TROUBLE[reason]}. Set up the glances (K) to choose without the webcam.`, 4000);
    return;
  }
  if (reason) webcamTrouble = reason; // still in trouble; keep the reason current
  const good = gaze.face && ratio > BRIGHT_AGAIN_RATIO && (q.jitter === null || q.jitter < Math.max(MIN_SHAKY_PX * 0.75, CALM_RATIO * ref));
  goodSince = good ? goodSince ?? now : null;
  if (goodSince !== null && now - goodSince > GOOD_MS) {
    webcamTrouble = null;
    goodSince = null;
    if (glanceReady() && !forceGlance) say("The webcam can see your eyes again: choosing with the eye tracker", 3000);
  }
}
// Pickable cubes left to right on screen.
const pickable = () => overlay.targets.filter((t) => overlay.canPick(t)).sort((a, b) => overlay.screenCenter(a)[0] - overlay.screenCenter(b)[0]);
function setGazed(id, now = performance.now()) {
  if (id === gazed) return;
  gazed = id;
  gazedSince = now;
  overlay.setGazed(id);
  updatePrompt();
}
function setPlaceGazed(id, now = performance.now()) {
  if (id === placeGazed) return;
  placeGazed = id;
  placeGazedSince = now;
  overlay.setPlaceGazed(id);
  updatePrompt();
}
// Place mode with glances: the suggested spots (and the basket), left to right on screen.
const placeChoices = () => (place ? place.suggested.map((id) => place.spots.find((s) => s.id === id)).filter(Boolean)
  .sort((a, b) => overlay.screenOf(...a.center)[0] - overlay.screenOf(...b.center)[0]) : []);
const spotName = (spot) => (spot.kind === "basket" ? "in the basket" : "here");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function say(text, ms = 2500) {
  promptOverride = { text, until: performance.now() + ms };
  updatePrompt();
}

function updatePrompt() {
  let text = null;
  if (promptOverride && performance.now() < promptOverride.until) text = promptOverride.text;
  else if (busy) text = null;
  else if (placeConfirm) text = `Putting it ${spotName(place.spots.find((s) => s.id === placeConfirm.id))} · ${cancelHint(placeConfirm)}`;
  else if (place?.sent) text = "Putting it down…";
  else if (place) {
    const spot = place.spots.find((s) => s.id === placeGazed);
    const mode = selectMode();
    if (mode === "glance") text = spot ? `Clench to put it ${spotName(spot)} · glance left/right to move` : "Glance left or right to choose where it goes";
    else if (webcamTrouble) text = `${TROUBLE[webcamTrouble]}. Set up the glances (K) to choose without the webcam.`;
    else if (gaze.calibrated && !gaze.face) text = "Can't see your face in the webcam";
    else if (!spot) text = "Look where to put it (a green dot or the basket), then clench";
    else text = spot.ok ? `Clench to put it ${spotName(spot)}` : `Can't put it there: ${spot.reason}`;
  } else if (confirm) text = `Picking ${confirm.id} · ${cancelHint(confirm)}`;
  else if (overlay.selected) text = `Picking ${overlay.selected}`;
  else if (armWaiting) {
    const mode = selectMode();
    if (mode === "glance") text = gazed ? `Clench to pick ${gazed} · glance left/right to move` : "Glance left or right to choose";
    else if (webcamTrouble) text = `${TROUBLE[webcamTrouble]}. Set up the glances (K) to choose without the webcam.`;
    else if (gaze.calibrated && !gaze.face) text = "Can't see your face in the webcam";
    else text = gazed ? `Clench to pick ${gazed}` : "Look at a cube, then clench to pick it";
  }
  promptLine.hidden = !text;
  if (text) promptLine.textContent = text;
}

function gazeTick(now) {
  const p = gazePoint();
  if (dot.dataset.on && p && !busy) {
    dot.hidden = false;
    const x = Math.max(8, Math.min(innerWidth - 8, p.x));
    const y = Math.max(8, Math.min(innerHeight - 8, p.y));
    dot.style.transform = `translate(${x}px, ${y}px)`;
    dot.classList.toggle("away", gaze.calibrated && gaze.away);
    dot.classList.toggle("talking", gaze.talking);
  } else dot.hidden = true;
  faceLostSince = gaze.face ? null : faceLostSince ?? performance.now();
  if (!busy) checkTracking(now); // not during calibration: head moves and changing light are expected then
  if (place) {
    placeTick(now, p);
    return;
  }
  const looking = !overlay.selected && !confirm && overlay.targets.length > 0;
  if (!looking) return;
  if (selectMode() === "glance") {
    // Glances move the highlight; start on the middle cube.
    const list = pickable();
    if (!list.some((t) => t.id === gazed)) setGazed(list.length ? list[Math.floor((list.length - 1) / 2)].id : null, now);
    return;
  }
  const lost = !p || (gaze.calibrated && gaze.away); // no face, or looking away from the screen
  if (lost) {
    awaySince ??= now;
    if (gazed && now - awaySince < HOLD_LOST_MS) return; // brief: keep the yellow cube
    if (gazed) setGazed(null, now);
    return;
  }
  awaySince = null;
  let best = null;
  let bestDistance = MAX_GAZE_DISTANCE * overlay.rect.width;
  if (p) {
    for (const target of overlay.targets) {
      if (!overlay.canPick(target)) continue;
      const [x, y] = overlay.screenCenter(target);
      const distance = Math.hypot(x - p.x, y - p.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = target.id;
      }
    }
    const current = gazed && overlay.targets.find((t) => t.id === gazed);
    if (current && best !== gazed && overlay.canPick(current)) {
      const [x, y] = overlay.screenCenter(current);
      if (bestDistance > SWITCH_RATIO * Math.hypot(x - p.x, y - p.y)) best = gazed; // not clearly closer: stay
    }
  }
  if (best !== candidate) {
    candidate = best;
    candidateSince = now;
  }
  if (candidate !== gazed && now - candidateSince >= DWELL_MS) setGazed(candidate, now);
}

// Place mode: which spot the person is looking at (nearest to the gaze, held for DWELL_MS), or with
// glances, one of the suggested spots.
function placeTick(now, p) {
  if (placeConfirm || place.sent) return;
  if (selectMode() === "glance") {
    const list = placeChoices();
    if (!list.some((s) => s.id === placeGazed)) setPlaceGazed(list.length ? list[Math.floor((list.length - 1) / 2)].id : null, now);
    return;
  }
  const lost = !p || (gaze.calibrated && gaze.away);
  if (lost) {
    awaySince ??= now;
    if (placeGazed && now - awaySince < HOLD_LOST_MS) return;
    if (placeGazed) setPlaceGazed(null, now);
    return;
  }
  awaySince = null;
  let best = null;
  let bestDistance = MAX_SPOT_DISTANCE * overlay.rect.width;
  for (const spot of place.spots) {
    const [x, y] = overlay.screenOf(...spot.center);
    const distance = Math.hypot(x - p.x, y - p.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = spot.id;
    }
  }
  const current = place.spots.find((s) => s.id === placeGazed);
  if (current && best !== placeGazed) {
    const [x, y] = overlay.screenOf(...current.center);
    if (bestDistance > SWITCH_RATIO * Math.hypot(x - p.x, y - p.y)) best = placeGazed; // not clearly closer: stay
  }
  if (best !== placeCandidate) {
    placeCandidate = best;
    placeCandidateSince = now;
  }
  if (placeCandidate !== placeGazed && now - placeCandidateSince >= DWELL_MS) setPlaceGazed(placeCandidate, now);
}

function cancelPlaceConfirm(message) {
  if (!placeConfirm) return;
  clearTimeout(placeConfirm.timer);
  placeConfirm = null;
  overlay.setPlaceSelected(null);
  if (message) say(message);
  updatePrompt();
}

function onPlaceClench(source) {
  if (place.sent) return;
  if (source === "eeg" && gaze.talking) {
    say("Talking: that clench was ignored");
    return;
  }
  if (gaze.calibrated && gaze.away && selectMode() === "eyes") {
    say("Look at the screen to choose where it goes");
    return;
  }
  const spot = place.spots.find((s) => s.id === placeGazed);
  if (!spot) {
    say("Look at a green dot or the basket first, then clench");
    return;
  }
  if (!spot.ok) {
    say(`Can't put it there: ${spot.reason}`);
    return;
  }
  if (performance.now() - placeGazedSince < STEADY_MS) {
    say(selectMode() === "glance" ? "Wait a moment after moving, then clench" : "Keep looking at the spot, then clench");
    return;
  }
  overlay.setPlaceSelected(spot.id);
  const placeWindow = CONFIRM_MS[source] ?? CONFIRM_MS.eeg;
  placeConfirm = {
    id: spot.id,
    source,
    until: performance.now() + placeWindow,
    timer: setTimeout(() => {
      placeConfirm = null;
      if (place) place.sent = true;
      channel?.postMessage({ type: "place-select", id: spot.id });
      updatePrompt();
    }, placeWindow),
  };
  updatePrompt();
}

function onGlance(direction) {
  waves.glance(direction);
  if (!busy && place && !place.sent && !placeConfirm && selectMode() === "glance") {
    const list = placeChoices();
    const i = list.findIndex((s) => s.id === placeGazed);
    const j = Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + (direction === "left" ? -1 : 1)));
    if (list[j]) setPlaceGazed(list[j].id);
    return;
  }
  if (busy || selectMode() !== "glance" || overlay.selected || confirm || !overlay.targets.length) return;
  const list = pickable();
  const i = list.findIndex((t) => t.id === gazed);
  const j = Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + (direction === "left" ? -1 : 1)));
  if (list[j]) setGazed(list[j].id);
}

function cancelConfirm(message) {
  if (!confirm) return;
  clearTimeout(confirm.timer);
  confirm = null;
  overlay.setSelected(null);
  if (message) say(message);
  updatePrompt();
}

function onClench(source) {
  waves.flash();
  jawFill.parentElement.classList.add("fired");
  setTimeout(() => jawFill.parentElement.classList.remove("fired"), 500);
  if (busy) return;
  if (placeConfirm) {
    cancelPlaceConfirm("Cancelled. Look where to put it and clench.");
    return;
  }
  if (place) {
    onPlaceClench(source);
    return;
  }
  if (confirm) {
    cancelConfirm("Cancelled. Look at a cube and clench to pick it.");
    return;
  }
  if (!armWaiting || overlay.selected || !overlay.targets.length) {
    say(`Clench detected (${source === "key" ? "space bar" : "headset"})`, 1200);
    return;
  }
  if (source === "eeg" && gaze.talking) {
    say("Talking: that clench was ignored");
    return;
  }
  if (gaze.calibrated && gaze.away && selectMode() === "eyes") {
    say("Look at the screen to pick");
    return;
  }
  if (!gazed) {
    say("Look at a cube first, then clench");
    return;
  }
  if (performance.now() - gazedSince < STEADY_MS) {
    say(selectMode() === "glance" ? "Wait a moment after moving, then clench" : "Keep looking at the cube, then clench");
    return;
  }
  const id = gazed;
  overlay.setSelected(id);
  // Where the tracker thought the eyes were just before the clench, for drift correction below.
  const target = overlay.targets.find((t) => t.id === id);
  const seen = selectMode() === "eyes" ? gaze.meanSince(performance.now() - 900) : null;
  const pickWindow = CONFIRM_MS[source] ?? CONFIRM_MS.eeg;
  confirm = {
    id,
    source,
    until: performance.now() + pickWindow,
    timer: setTimeout(() => {
      confirm = null;
      armWaiting = false;
      channel?.postMessage({ type: "gaze-select", id });
      // The pick stood (not cancelled), so the person was looking at that cube: pull the tracker
      // towards it. Head moves while watching the arm otherwise add up and the tracker drifts.
      if (seen && target) {
        const [x, y] = overlay.screenCenter(target);
        gaze.correct({ x, y }, seen);
      }
      updatePrompt();
    }, pickWindow),
  };
  updatePrompt();
}

const bci = createBci({
  keys: true,
  onClench,
  onGlance,
  onLive: ({ connected, live }) => {
    waves.push(live);
    if (!connected) {
      waves.setMessage("Headset not connected: run tools/ssvep_train.py. Space bar = clench.");
      jawFill.style.width = "0%";
      jawMark.hidden = true;
      jawStatus.textContent = "Jaw: no headset (space bar = clench)";
      return;
    }
    const c = live.clench;
    if (!c.ready) {
      jawFill.style.width = "0%";
      jawStatus.textContent = "Jaw: settling…";
      return;
    }
    // level: 1.0 = a pick (every clench channel past its threshold, or any one of them)
    jawFill.style.width = `${Math.min(100, (100 * c.level) / 1.6)}%`;
    jawMark.hidden = false;
    jawMark.style.left = `${100 / 1.6}%`;
    jawStatus.textContent = `Jaw: ${Math.round(100 * c.level)}% of a pick · ${c.used.join(c.agree ? " + " : " or ")}` +
      (c.calibrated?.ok ? "" : " · not checked");
  },
});

// No EEG during (and just after) an impedance check, and the detectors need a few seconds to settle.
async function waitForEeg(what) {
  for (let t = 0; t < 200; t += 1) {
    const live = bci.live;
    if (live && !live.imp.on && !live.imp.settling && live.clench.ready && (!live.eog.available || live.eog.ready)) return;
    promptOverride = { text: `${what}: waiting for the EEG…`, until: performance.now() + 500 };
    updatePrompt();
    await sleep(100);
  }
}

// One dot on the full-window layer for ms, with a shrinking ring (like the eye calibration).
async function showDot(x, y, ms, text) {
  const ctx = layer.getContext("2d");
  const ratio = Math.min(window.devicePixelRatio, 2);
  layer.width = Math.round(window.innerWidth * ratio);
  layer.height = Math.round(window.innerHeight * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const start = performance.now();
  for (let k = 0; k < 1; k = (performance.now() - start) / ms) {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.fillStyle = "rgba(10, 12, 16, 0.82)";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.fillStyle = "#f1f2f4";
    ctx.font = "600 18px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(text, window.innerWidth / 2, 40);
    ctx.strokeStyle = "#ff7eb6";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 6 + 26 * (1 - k), 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#ff7eb6";
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

// Eye-corner electrodes: follow a dot middle -> left edge -> middle -> right edge -> middle.
async function glanceCheck() {
  if (!bci.live?.eog?.available) return null;
  busy = true;
  let result = null;
  try {
    await waitForEeg("Eye check");
    layer.hidden = false;
    const y = window.innerHeight * 0.4;
    const at = { middle: window.innerWidth / 2, left: window.innerWidth * 0.04, right: window.innerWidth * 0.96 };
    await bci.calibrateGlance("start");
    for (const [phase, ms] of [["middle", 2500], ["left", 1500], ["middle", 1500], ["right", 1500], ["middle", 1500]]) {
      await bci.calibrateGlance("mark", phase);
      await showDot(at[phase], y, ms, "Eye check: follow the dot with your eyes only, keep your head still");
    }
    result = await bci.calibrateGlance("done");
    say(result.error ? `Eye check: ${result.error}` : `Eye check: ${result.verdict}`, 4000);
  } catch (error) {
    say(`Eye check failed: ${error.message}`, 4000);
  } finally {
    layer.hidden = true;
    busy = false;
  }
  return result;
}

// Relax 5 s, clench and hold 3 s: the trainer picks the channels and the threshold.
async function clenchCheck() {
  if (!bci.connected) {
    say("No headset: start tools/ssvep_train.py first. The space bar works as a clench meanwhile.", 4000);
    return null;
  }
  busy = true;
  const countdown = async (text, seconds) => {
    for (let s = seconds; s > 0; s -= 1) {
      promptOverride = { text: `${text} ${s}`, until: performance.now() + 1100 };
      updatePrompt();
      await sleep(1000);
    }
  };
  let result = null;
  try {
    await waitForEeg("Jaw check");
    await bci.calibrateClench("rest");
    await countdown("Jaw check: relax your jaw…", 5);
    await bci.calibrateClench("clench");
    await countdown("Now clench your teeth and HOLD…", 3);
    result = await bci.calibrateClench("done");
    if (result.error) say(`Jaw check: ${result.error}`, 6000);
    else say(result.verdict, 5000);
  } catch (error) {
    say(`Jaw check failed: ${error.message}`, 5000);
  } finally {
    busy = false;
  }
  return result;
}

const MOUSE_ONLY = new URLSearchParams(location.search).get("eyes") === "mouse"; // no webcam: the mouse is the gaze

// Whose eyes: ?user=name, else the last person used here. Their eye profile (face model + gaze
// mapping) is saved by sim/run.py in logs/users/<name>/gaze_profile.json, with a copy in this browser.
const personBox = $("person");
let person = (new URLSearchParams(location.search).get("user") || localStorage.getItem("reach-person") || "prakul").toLowerCase();
personBox.value = person;
const cleanName = (name) => name.toLowerCase().replace(/[^a-z0-9_-]/g, "");

async function loadProfile(name) {
  try {
    const response = await fetch(`profiles/${name}.json`, { cache: "no-store" });
    if (response.ok) return await response.json();
  } catch { /* fall back to this browser's copy */ }
  try {
    return JSON.parse(localStorage.getItem(`reach-eyes-${name}`) || "null");
  } catch {
    return null;
  }
}

async function saveProfile(name) {
  const profile = gaze.exportProfile();
  if (!profile) return "nothing to save";
  try {
    localStorage.setItem(`reach-eyes-${name}`, JSON.stringify(profile));
  } catch { /* private window: the file copy is the one that matters */ }
  try {
    const response = await fetch(`profiles/${name}.json`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) });
    const result = await response.json();
    return result.ok ? `saved to ${result.file}` : result.error;
  } catch (error) {
    return `saved in this browser only (${error.message})`;
  }
}

async function startWebcam() {
  if (gaze.running) return;
  eyesStatus.textContent = "Eyes: starting the webcam…";
  promptOverride = { text: "Starting the webcam…", until: performance.now() + 60000 };
  updatePrompt();
  await gaze.start(webcam);
  webcam.hidden = false;
  for (let t = 0; !gaze.face && t < 150; t += 1) {
    promptOverride = { text: "Look at the screen so the webcam can see your face", until: performance.now() + 500 };
    updatePrompt();
    await sleep(100);
  }
  promptOverride = null;
  updatePrompt();
}

// Uses the person's saved profile (one dot to line it up), or makes a new one (about 45 s) and saves it.
async function eyesForPerson({ fresh = false } = {}) {
  if (busy) return;
  if (MOUSE_ONLY) {
    eyesStatus.textContent = "Eyes: off (?eyes=mouse): the mouse stands in for your gaze";
    return;
  }
  busy = true;
  try {
    await startWebcam();
    layer.hidden = false;
    const saved = fresh ? null : await loadProfile(person);
    const loaded = saved ? gaze.importProfile(saved) : { ok: false, reason: "no saved profile" };
    if (loaded.ok) {
      const result = await gaze.recenter(layer, overlay.rect);
      if (result.ok) {
        eyesStatus.textContent = `Eyes: ${person}'s saved profile (from ${saved.saved?.slice(0, 10) ?? "earlier"}, ±${saved.errorPx} px, webcam ${gaze.camera?.w}×${gaze.camera?.h})`;
        return;
      }
    } else if (saved) {
      say(`${person}'s saved profile can't be used here: ${loaded.reason}. Making a new one.`, 4000);
      await sleep(1500);
    }
    const result = await gaze.calibrateProfile(layer, overlay.rect, person);
    if (!result.ok) {
      eyesStatus.textContent = `Eyes: calibration didn't work (${result.reason}). Press “New eye profile”.`;
      return;
    }
    const where = await saveProfile(person);
    eyesStatus.textContent = `Eyes: new profile for ${person} (±${result.errorPx} px, ${result.rounds} round${result.rounds === 1 ? "" : "s"}, webcam ${gaze.camera?.w}×${gaze.camera?.h}), ${where}`;
  } catch (error) {
    const reason = error.message === "cancelled" ? "calibration cancelled" : error.name === "NotAllowedError" ? "webcam blocked" : error.message;
    eyesStatus.textContent = `Eyes: ${reason}. The mouse stands in for your gaze.`;
    console.error(error);
  } finally {
    layer.hidden = true;
    busy = false;
    promptOverride = null;
    updatePrompt();
  }
}

const calibrateEyes = () => eyesForPerson({ fresh: true });

async function recenterEyes() {
  if (busy || !gaze.calibrated) return;
  busy = true;
  try {
    layer.hidden = false;
    const result = await gaze.recenter(layer, overlay.rect);
    say(result.ok ? `Re-centred (moved ${result.shiftPx} px)` : `Re-centre didn't work: ${result.reason}`);
  } catch (error) {
    if (error.message !== "cancelled") say(error.message);
  } finally {
    layer.hidden = true;
    busy = false;
  }
}

function broadcast() {
  channel?.postMessage({ type: "camera-status", ready, eyes: gaze.calibrated, headset: bci.connected,
    clench: Boolean(bci.live?.clench?.calibrated?.ok) });
}

// Everything the person needs, in order, as soon as the tab opens.
async function setup() {
  if (document.visibilityState !== "visible") {
    status.hidden = false;
    status.textContent = "Bring this tab to the front to start the eye tracker.";
    await new Promise((resolve) => document.addEventListener("visibilitychange", function on() {
      if (document.visibilityState === "visible") {
        document.removeEventListener("visibilitychange", on);
        resolve();
      }
    }));
    status.hidden = true;
  }
  await eyesForPerson();
  for (let t = 0; !bci.connected && t < 15; t += 1) await sleep(100); // first headset poll
  if (bci.live?.eog?.available && !bci.live.eog.calibrated?.ok) await glanceCheck();
  if (bci.connected && !bci.live?.clench?.calibrated?.ok) await clenchCheck();
  ready = true;
  broadcast();
  channel?.postMessage({ type: "gaze-start" }); // the sim tab starts picking
  say(armWaiting ? "Ready" : "Ready. Waiting for the sim tab…", 2500);
}

personBox.addEventListener("change", () => {
  const name = cleanName(personBox.value);
  if (!name || name === person) return;
  person = name;
  personBox.value = name;
  try {
    localStorage.setItem("reach-person", name);
  } catch { /* fine */ }
  eyesForPerson();
});
personBox.addEventListener("keydown", (event) => event.stopPropagation()); // typing a name isn't a command
$("recalibrate").addEventListener("click", (event) => {
  event.currentTarget.blur();
  calibrateEyes();
});
$("clench-check").addEventListener("click", (event) => {
  event.currentTarget.blur();
  clenchCheck();
});
window.addEventListener("keydown", async (event) => {
  if (event.metaKey || event.ctrlKey || busy) return;
  const key = event.key.toLowerCase();
  if (key === "escape") {
    if (placeConfirm) cancelPlaceConfirm("Cancelled");
    else if (confirm) cancelConfirm("Cancelled");
    else if (armWaiting || place) {
      channel?.postMessage({ type: "gaze-cancel" });
      say("Stopped");
    }
  } else if (key === "r") recenterEyes();
  else if (key === "e") calibrateEyes();
  else if (key === "d") dot.dataset.on = dot.dataset.on ? "" : "1"; // gaze dot, for checking the tracker
  else if (key === "g") {
    if (!glanceReady()) say("Glances aren't set up (needs the eye-corner electrodes and the eye check)");
    else {
      forceGlance = !forceGlance;
      say(selectMode() === "glance" ? "Choosing with glances" : "Choosing with the webcam eye tracker");
    }
  } else if (key === "k") glanceCheck();
  else if ((key === "+" || key === "=" || key === "-") && bci.connected) {
    const factor = key === "-" ? 1 / 1.15 : 1.15; // + = fewer false picks, - = easier to trigger
    const result = await bci.calibrateClench("scale", factor);
    if (result.ok) say(`Clench ${key === "-" ? "easier to trigger" : "harder to trigger"} (${Object.entries(result.thresholds).map(([n, t]) => `${n} ${t}×`).join(", ")})`, 2000);
  }
});
setInterval(() => {
  if (!busy && ready) {
    const mode = selectMode();
    const eogLine = bci.live?.eog?.available ? (glanceReady() ? " · glances ready (G)" : " · glances not checked (K)") : "";
    eyesStatus.textContent = (mode === "glance" ? (webcamTrouble && !forceGlance ? `${TROUBLE[webcamTrouble]}: choosing with glances (left/right edge)` : "Choosing with glances (left/right edge)")
      : mode === "eyes" ? (!gaze.face ? "Eyes: can't see a face in the webcam"
        : `${person}'s eye profile${gaze.away ? " · looking away" : ""}${gaze.talking ? " · talking" : ""}`)
        : "Eyes: off, the mouse stands in for your gaze") + eogLine;
  }
  updatePrompt();
}, 250);
setInterval(broadcast, 2000);

renderer.setAnimationLoop((now) => {
  gazeTick(now);
  stepZoom();
  if (!needsRender) return;
  needsRender = false;
  renderer.render(scene, tableCamera);
});

// ---------------------------------------------------------------- start
async function start() {
  const arm = await loadArm((fraction) => {
    loadingText.textContent = `Loading arm ${Math.round(fraction * 100)}%`;
  });
  scene.add(arm.root);

  channel = new BroadcastChannel(STATE_CHANNEL);
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
      const nextPlace = data.mode === "gaze" && data.place ? { ...data.place, sent: false } : null;
      if (!nextPlace) cancelPlaceConfirm();
      if (Boolean(nextPlace) !== Boolean(place) || nextPlace) {
        place = nextPlace;
        placeGazed = placeCandidate = null;
        overlay.setPlace(place);
      }
      overlay.setTargets(data.targets, data.selected, { mode: "gaze", reachable: data.reachable });
      armWaiting = data.mode === "gaze" && !data.selected && data.targets.length > 0;
      if (!armWaiting) cancelConfirm();
      if (!data.selected) {
        gazed = candidate = null;
        overlay.setGazed(null);
      }
      updateZoom();
      updatePrompt();
      if (data.note) say(data.note, 8000);
    } else if (data.type === "camera-ping") {
      broadcast();
    }
  };
  channel.postMessage({ type: "request-state" });

  window.sim = { scene, tableCamera, arm, requestRender, overlay, gaze, bci,
    // For checking from the console: what place mode and the webcam check currently think.
    state: () => ({ camera: gaze.camera, mode: selectMode(), webcamTrouble, place: Boolean(place), placeGazed, placeCandidate, quality: gaze.quality }) };
  requestRender();
  loading.hidden = true;
}

start()
  .then(setup)
  .catch((error) => {
    console.error(error);
    loadingText.textContent = `Could not load the arm: ${error.message}`;
  });
