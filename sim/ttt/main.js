import * as THREE from "three";
import { OrbitControls } from "../vendor/OrbitControls.js";
import { BOARD_TOP, GRID, O_PIECE, cellCenter } from "./layout.js";
import { resetPieces } from "./pieces.js";
import { createPhysics } from "./physics.js";
import { createReach } from "./reach.js";
import { createRobot } from "./robot.js";
import { LINES_PLAYED, LINES_THINKING, empties, opponentMove, winner } from "./rules.js";
import { ARM_JOINTS, CHANNEL, buildScene, createRenderer, snapshot } from "./scene.js";
import { createVision } from "./vision.js";

// The main sim: physics, the arm, the opponent and the game. Nothing is chosen here: every choice
// (which X, which square) is made in the camera tab (ttt-camera.html), on the table camera's image,
// with the eyes and the headset's OK. This tab asks for a choice and waits for the answer.
//
// Your turn: the camera finds your spare X pieces -> you choose one -> the arm picks it up and holds it
// -> you choose a square -> the arm puts it there. His turn: he thinks out loud, leans over and puts an
// O down himself. He plays badly on purpose (rules.js).

const PARK = [90, -60, 125, 0]; // swung to its left and tucked down: clear of the board, the X supply and the camera
const HOLD = [90, -10, -20, 0]; // high on its left, holding your X while you choose a square
const CALIBRATION_POSE = HOLD; // high: every mount sticker in the table camera's view
const ARM_SPEED = 80; // degrees per second
const STATE_EVERY_MS = 33; // how often the camera tab gets the scene's state
const VIEWS = {
  player: { position: [-0.3, -0.32, 0.64], target: [0.34, 0.02, 0.15] },
  board: { position: [0.0, 0.0, 0.5], target: [0.25, 0, 0.0] },
  wide: { position: [0.22, -1.1, 0.55], target: [0.3, 0, 0.1] },
};
const params = new URLSearchParams(location.search);

const $ = (id) => document.getElementById(id);
const loading = $("loading");
const loadingText = $("loading-text");
const taskStatus = $("task-status");
const cameraLine = $("camera-line");
const promptLine = $("prompt");
const bubble = $("bubble");
const toastLine = $("toast");
const cameraView = $("camera-view");
const panel = document.querySelector(".panel");

// ---------------------------------------------------------------- scene and timing
const renderer = createRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
$("viewport").append(renderer.domElement);

// In a background tab (the camera tab in front, say) the browser pauses animation frames and slows
// timers to once a second, so a small worker supplies ~60 ticks a second instead (as in the cube sim).
const ticker = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 16);"], { type: "text/javascript" })));
const tickWaiters = [];
const nextFrame = () => new Promise((resolve) => (document.hidden ? tickWaiters.push(resolve) : requestAnimationFrame(resolve)));

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.01, 30);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.2;
controls.maxDistance = 2.6;
controls.maxPolarAngle = Math.PI * 0.53;
function setView(name) {
  camera.position.fromArray(VIEWS[name].position);
  controls.target.fromArray(VIEWS[name].target);
  controls.update();
}
setView("player");
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let scene = null;
let world = null; // { scene, tableCamera, highlights, pieceSet, bm, arm }
let physics = null;
let robot = null;
let vision = null;

// ---------------------------------------------------------------- the camera tab
const channel = new BroadcastChannel(CHANNEL);
const cameraTab = { seen: -1e9, ready: false, eyes: false, headset: false, ok: false };
const cameraOpen = () => performance.now() - cameraTab.seen < 5000;
function showCameraLine() {
  if (!cameraOpen()) cameraLine.textContent = "Camera tab: not open. You choose there.";
  else if (!cameraTab.ready) cameraLine.textContent = "Camera tab: setting up (eyes, then the OK signal)…";
  else cameraLine.textContent = `Camera tab: ready · eyes ${cameraTab.eyes ? "calibrated" : "off (mouse)"} · ${cameraTab.headset ? `OK signal ${cameraTab.ok ? "checked" : "not checked"}` : "no headset (space bar = OK)"}`;
}
setInterval(showCameraLine, 2000);
const openCameraTab = () => window.open(`ttt-camera.html${location.search}`, "reach-ttt-camera");

// A choice the camera tab is being asked for: { kind: "pick" | "place" | "again", token, payload, resolve }.
let asking = null;
let askToken = 0;
function sendAsk() {
  const payload = asking?.payload ?? {};
  channel.postMessage({ type: "ask", kind: asking?.kind ?? null, token: asking?.token ?? 0, targets: payload.targets, cells: payload.cells });
}
function ask(kind, payload = {}) {
  return new Promise((resolve) => {
    asking = { kind, token: (askToken += 1), payload, resolve };
    sendAsk();
    if (!cameraOpen()) toast("Open the camera tab to choose (the button on the right)", 6000);
  });
}
function cancelAsk() {
  const pending = asking;
  asking = null;
  sendAsk();
  clearFocus();
  pending?.resolve(null);
}

const gameMessage = () => ({ type: "game", board: game.board, scores: game.scores, turn: hud.turn.textContent, who: game.who });
channel.onmessage = ({ data }) => {
  if (data.type === "request-state" && world) {
    channel.postMessage({ type: "state", ...snapshot(world) });
    channel.postMessage(gameMessage());
    sendAsk();
  } else if (data.type === "choose" && asking && data.token === asking.token) {
    const pending = asking;
    asking = null;
    sendAsk();
    clearFocus();
    pending.resolve(data.id);
  } else if (data.type === "focus") {
    showFocus(data);
  } else if (data.type === "camera-status") {
    Object.assign(cameraTab, data, { seen: performance.now() });
    showCameraLine();
    if (data.ready && world && !game.started && params.get("autostart") !== "0") startGame();
  }
};

// What the person is looking at in the camera tab, shown here too: the X lights up, or the square glows.
// He looks at it as well.
let focus = null; // { kind, id, state, mesh, where }
const TINT = { gaze: "#ffb000", confirm: "#2fd26a" };
function clearFocus() {
  if (focus?.mesh) focus.mesh.material.emissive.set("#000000");
  if (focus?.kind === "place") world.highlights.set(focus.id, null);
  focus = null;
}
function showFocus({ kind, id, state }) {
  if (!asking || kind !== asking.kind) return;
  clearFocus();
  if (id === null || id === undefined || !state) return;
  if (kind === "pick") {
    const option = asking.payload.options?.[Number(String(id).slice(1))];
    if (!option) return;
    const mesh = nearestX(option.piece.x, option.piece.y);
    mesh.material.emissive.set(TINT[state]);
    mesh.material.emissiveIntensity = 0.55;
    focus = { kind, id, state, mesh, where: mesh.position.clone() };
  } else if (kind === "place") {
    world.highlights.set(id, state);
    focus = { kind, id, state, where: cellWorld(id) };
  }
}
// The X mesh nearest a point, for showing the camera tab's focus here (the arm never uses this).
const nearestX = (x, y) => world.pieceSet.xs.reduce((a, b) => (Math.hypot(a.position.x - x, a.position.y - y) <= Math.hypot(b.position.x - x, b.position.y - y) ? a : b));

// ---------------------------------------------------------------- HUD, speech bubble, toast
const hud = { you: document.querySelector(".hud .you"), him: document.querySelector(".hud .him"), turn: $("turn") };
function setTurn(who, text) {
  game.who = who;
  hud.you.classList.toggle("active", who === "you" || who === "arm");
  hud.him.classList.toggle("active", who === "him");
  hud.turn.textContent = text;
  channel.postMessage(gameMessage());
}
let line = null;
function say(text, ms) {
  line = { text, until: performance.now() + ms };
  bubble.textContent = text;
  channel.postMessage({ type: "line", text, ms });
}
let toastTimer = null;
function toast(text, ms = 5000) {
  toastLine.textContent = text;
  toastLine.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastLine.hidden = true), ms);
  channel.postMessage({ type: "toast", text, ms });
}
const projected = new THREE.Vector3();
function placeBubble(now) {
  if (!line || now > line.until) {
    bubble.hidden = true;
    return;
  }
  projected.copy(world.bm.mouthSide(1)).project(camera);
  if (projected.z > 1) {
    bubble.hidden = true;
    return;
  }
  bubble.hidden = false;
  const width = bubble.offsetWidth;
  const room = panel.getBoundingClientRect().left - 12;
  let x = (projected.x + 1) * innerWidth / 2 + 14;
  let y = (1 - projected.y) * innerHeight / 2;
  const flip = x + width > room;
  if (flip) {
    projected.copy(world.bm.mouthSide(-1)).project(camera);
    x = (projected.x + 1) * innerWidth / 2 - 14 - width;
    y = (1 - projected.y) * innerHeight / 2;
  }
  bubble.classList.toggle("left", flip);
  x = Math.min(room - width, Math.max(16, x));
  y = Math.min(innerHeight - 60, Math.max(150, y));
  bubble.style.transform = `translate(${x}px, ${y}px) translate(0, -50%)`;
}

// ---------------------------------------------------------------- arm
const pose = [0, 0, 0, 0, 0]; // yaw, shoulder, elbow, roll (degrees), claw (percent)
function applyPose() {
  ARM_JOINTS.forEach((name, i) => (pose[i] = THREE.MathUtils.radToDeg(world.arm.setJoint(name, THREE.MathUtils.degToRad(pose[i])))));
  world.arm.setClaw(pose[4] / 100);
}
async function animate(duration, step) {
  const start = performance.now();
  for (;;) {
    const k = Math.min(1, (performance.now() - start) / duration);
    step(k);
    if (k >= 1) return;
    await nextFrame();
  }
}
async function moveArm(angles, clawPercent = null) {
  const from = pose.slice();
  const to = pose.slice();
  if (angles) angles.forEach((value, i) => (to[i] = value));
  if (clawPercent !== null) to[4] = clawPercent;
  const span = Math.max(...to.slice(0, 4).map((value, i) => Math.abs(value - from[i])));
  const duration = Math.max((span / ARM_SPEED) * 1000, Math.abs(to[4] - from[4]) > 0.5 ? 350 : 0, 200);
  await animate(duration, (k) => {
    const e = k * k * (3 - 2 * k);
    to.forEach((value, i) => (pose[i] = from[i] + (value - from[i]) * e));
    applyPose();
  });
}
// Tucking in goes via the high holding pose (same side of the table), never straight from over the board.
const park = async () => {
  if (Math.abs(pose[0] - PARK[0]) > 1 || Math.abs(pose[1] - PARK[1]) > 1) await moveArm(HOLD);
  await moveArm(PARK);
};
async function waitForRest(timeoutMs = 4000) {
  const start = performance.now();
  let still = 0;
  while (still < 10 && performance.now() - start < timeoutMs) {
    await nextFrame();
    still = physics.isAtRest() ? still + 1 : 0;
  }
}

// ---------------------------------------------------------------- game
const game = { board: Array(9).fill(null), scores: { you: 0, him: 0, draw: 0 }, token: 0, moving: false, pendingNew: false, started: false, held: null, who: null, log: [] };
let watchArm = false;
let nextO = 0;
const mistakeInput = $("mistake");
const mistake = () => Number(mistakeInput.value) / 100;
mistakeInput.addEventListener("input", () => ($("mistake-out").textContent = `${mistakeInput.value}%`));
const cellWorld = (cell, z = BOARD_TOP) => {
  const { x, y } = cellCenter(cell);
  return new THREE.Vector3(x, y, z);
};
const boardCentre = new THREE.Vector3(GRID.x, GRID.y, BOARD_TOP);

function showScores() {
  $("score-you").textContent = game.scores.you;
  $("score-him").textContent = game.scores.him;
  $("score-draw").textContent = game.scores.draw;
}

function checkBoard() {
  const seen = vision.detect();
  if (!seen.ok) return null;
  const read = vision.readBoard(seen.pieces);
  const agrees = read.every((v, i) => v === game.board[i]);
  game.lastRead = { read, agrees };
  if (!agrees) toast(`The camera reads the board differently: ${read.map((v) => v ?? "·").join("")} vs ${game.board.map((v) => v ?? "·").join("")}`, 6000);
  return agrees;
}

async function finish(result) {
  if (result.line) result.line.forEach((cell) => world.highlights.set(cell, "win"));
  watchArm = false;
  world.bm.lookAt(null);
  if (result.mark === "X") {
    game.scores.you += 1;
    showScores();
    setTurn("over", "You win!");
    await world.bm.react("lost");
  } else if (result.mark === "O") {
    game.scores.him += 1;
    showScores();
    setTurn("over", "Mr. Pemberton wins");
    await world.bm.react("won");
  } else {
    game.scores.draw += 1;
    showScores();
    setTurn("over", "Draw");
    await world.bm.react("draw");
  }
  promptLine.hidden = false;
  promptLine.textContent = "Send OK in the camera tab (or press New game) to play again";
  const again = await ask("again");
  if (again !== null) startGame();
}

// Your move: choose an X, the arm picks it up, choose a square, the arm puts it there.
// Returns the cell played, or null if the game was stopped meanwhile.
async function yourMove(token) {
  for (;;) {
    setTurn("you", "Your move: choose an X");
    taskStatus.textContent = "Waiting for you to choose an X (camera tab)";
    await waitForRest(2000);
    const seen = vision.detect();
    const open = empties(game.board);
    const options = robot.spares(seen.pieces, open);
    if (!options.length) {
      toast("The camera sees no spare X the arm can reach", 6000);
      return null;
    }
    const targets = options.map((o, i) => ({ id: `x${i}`, center: o.piece.pixel, box: o.piece.box, mask: o.piece.mask }));
    const choice = await ask("pick", { targets, options });
    if (choice === null || token !== game.token) return null;
    const option = options[Number(String(choice).slice(1))];
    game.moving = true;
    setTurn("arm", "The arm is picking up your X");
    watchArm = true;
    const picked = await robot.pick(option.plan);
    watchArm = false;
    game.moving = false;
    if (!picked.ok) {
      toast(`${picked.line}. Choose again.`, 5000);
      continue;
    }
    game.held = picked.held;
    setTurn("you", "Your move: choose a square");
    taskStatus.textContent = "Waiting for you to choose a square (camera tab)";
    const cells = robot.droppable(picked.held, open);
    const cell = await ask("place", { cells });
    if (cell === null || token !== game.token) return null;
    game.moving = true;
    setTurn("arm", "The arm is playing your X");
    watchArm = true;
    const placed = await robot.drop(picked.held, cell);
    watchArm = false;
    game.moving = false;
    game.held = null;
    game.log.push({ by: "X", cell, ok: placed.ok, offMm: placed.offMm, offSquareDeg: placed.offSquareDeg, truthMm: placed.truthMm, flat: placed.flat, plan: placed.plan });
    toast(placed.line, 5500);
    if (!placed.ok) {
      const after = vision.detect();
      if (!(after.ok && vision.readBoard(after.pieces)[cell] === "X")) continue;
    }
    return cell;
  }
}

async function hisMove(token) {
  setTurn("him", "Mr. Pemberton is thinking");
  taskStatus.textContent = "His move";
  const { bm } = world;
  const move = opponentMove(game.board, { mistake: mistake() });
  const thinkMs = 1200 + Math.random() * 1000;
  say(bm.pick(LINES_THINKING), thinkMs + 1800);
  await bm.think(thinkMs, empties(game.board).map((c) => cellWorld(c)));
  if (token !== game.token) return null;
  game.moving = true;
  const piece = world.pieceSet.os[nextO];
  nextO += 1;
  await bm.placePiece(piece, cellWorld(move.cell, BOARD_TOP + O_PIECE.height / 2), {
    hold: (m) => physics.holdFree(m),
    release: (m) => physics.release(m),
    follow: (m, p) => physics.follow(m, p),
  });
  game.moving = false;
  game.log.push({ by: "O", ...move });
  say(bm.pick(LINES_PLAYED[move.kind]), 3200);
  bm.lookAt(boardCentre);
  await waitForRest(1500);
  return move.cell;
}

async function startGame() {
  if (game.moving) {
    game.pendingNew = true;
    toast("New game after this move", 2000);
    return;
  }
  game.started = true;
  const token = (game.token += 1);
  cancelAsk();
  world.highlights.clear();
  if (game.held) {
    physics.release(game.held.piece);
    game.held = null;
    await moveArm(null, 0);
  }
  await park();
  game.board = Array(9).fill(null);
  nextO = 0;
  resetPieces(world.pieceSet);
  [...world.pieceSet.xs, ...world.pieceSet.os].forEach((mesh) => physics.place(mesh));
  promptLine.hidden = true;
  await waitForRest(1500);
  if (token !== game.token) return;
  world.bm.setMood({ smile: 0.4, brows: 0, open: 0 });
  say(world.bm.pick(["Let's do lunch. After I win.", "I've got a 3 o'clock. Let's make this quick.", "Tic-tac-toe? I have an MBA in this."]), 3000);
  let turn = "X";
  for (;;) {
    if (token !== game.token) return;
    const result = winner(game.board);
    if (result) {
      await finish(result);
      return;
    }
    const cell = turn === "X" ? await yourMove(token) : await hisMove(token);
    if (cell === null || token !== game.token) return;
    game.board[cell] = turn;
    world.highlights.set(cell, null);
    channel.postMessage(gameMessage());
    checkBoard();
    if (game.pendingNew) {
      game.pendingNew = false;
      startGame();
      return;
    }
    turn = turn === "X" ? "O" : "X";
  }
}

// ---------------------------------------------------------------- loop
const palmPosition = new THREE.Vector3();
let last = performance.now();
let lastState = 0;
function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  physics.advance(dt);
  const { bm, arm } = world;
  if (watchArm) bm.lookAt(arm.root.getObjectByName("wrist_palm").getWorldPosition(palmPosition));
  else if (focus?.where) bm.lookAt(focus.where);
  bm.update(dt, now / 1000);
  world.highlights.pulse(now / 1000);
  if (now - lastState > STATE_EVERY_MS) {
    lastState = now;
    channel.postMessage({ type: "state", ...snapshot(world) });
  }
  return now;
}
ticker.onmessage = () => {
  if (physics && document.hidden) tick();
  tickWaiters.splice(0).forEach((resolve) => resolve());
};
function frame() {
  if (!physics) return;
  const now = tick();
  controls.update();
  placeBubble(now);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  renderer.render(scene, camera);
  if (!cameraView.hidden) {
    const { left, bottom, width, height } = cameraView.getBoundingClientRect();
    const fromBottom = window.innerHeight - bottom;
    renderer.setViewport(left, fromBottom, width, height);
    renderer.setScissor(left, fromBottom, width, height);
    renderer.setScissorTest(true);
    renderer.render(scene, world.tableCamera);
    renderer.setScissorTest(false);
  }
}

// ---------------------------------------------------------------- controls
$("new-game").addEventListener("click", (event) => {
  event.currentTarget.blur();
  startGame();
});
$("open-camera").addEventListener("click", openCameraTab);
$("view-player").addEventListener("click", () => setView("player"));
$("view-board").addEventListener("click", () => setView("board"));
$("view-wide").addEventListener("click", () => setView("wide"));
window.addEventListener("keydown", (event) => {
  if (event.key === "c" || event.key === "C") cameraView.hidden = !cameraView.hidden;
});

async function start() {
  world = await buildScene(renderer, { nextFrame, onProgress: (f) => (loadingText.textContent = `Loading arm ${Math.round(f * 100)}%`) });
  scene = world.scene;
  // Each X gets its own material, so the one being looked at can light up.
  world.pieceSet.xs.forEach((mesh) => (mesh.material = mesh.material.clone()));
  applyPose();
  loadingText.textContent = "Starting physics";
  physics = await createPhysics({ arm: world.arm, pieces: [...world.pieceSet.xs, ...world.pieceSet.os] });
  const reach = createReach(world.arm);
  vision = createVision({ renderer, scene, camera: world.tableCamera, pieces: world.pieceSet.group, hide: [world.highlights.group], clearForCalibration: [world.bm.root] });
  robot = createRobot({
    reach, physics, vision, moveArm, park, nextFrame, waitForRest,
    hold: () => moveArm(HOLD),
    setClaw: (percent) => {
      pose[4] = percent;
      applyPose();
    },
    setStatus: (text) => (taskStatus.textContent = text),
  });
  window.ttt = { renderer, scene, camera, controls, world, physics, reach, robot, vision, game, moveArm, park, startGame, waitForRest, pose, setView, channel, get asking() { return asking; } };
  renderer.setAnimationLoop(frame);
  loading.hidden = true;
  setTurn("setup", "Setting up");
  await moveArm(CALIBRATION_POSE);
  await waitForRest(2000);
  const calibration = vision.calibrateCamera();
  taskStatus.textContent = calibration.ok
    ? `Table camera calibrated from ${calibration.points ?? 4} stickers (${(calibration.rmsPx ?? 0).toFixed(2)} px)`
    : `Camera calibration failed: ${calibration.reason}`;
  await park();
  channel.postMessage({ type: "camera-ping" });
  showCameraLine();
  // The game starts once the camera tab says it's set up (or straight away with ?autostart=1).
  if (params.get("autostart") === "1" || (cameraOpen() && cameraTab.ready)) startGame();
  else setTurn("setup", "Open the camera tab to play");
}

start().catch((error) => {
  console.error(error);
  loadingText.textContent = `Could not start: ${error.message}`;
});
