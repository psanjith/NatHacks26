import * as THREE from "three";
import { OPPONENT, TABLE, TABLE_Z } from "./layout.js";

// The opponent: a cartoon businessman (pill-shaped head, orange hair, googly eyes, red nose, teal suit,
// orange tie), built from simple shapes. He sits across the table from the arm on a tall office chair.
// His arms are two-bone IK chains, so he can lean over and put an O wherever he decides, and his face
// does a few expressions (brows, mouth, eyes that follow what's happening, blinking).
//
// Frames: `root` sits on the chair seat, facing the arm (its +x points at world -x, +y at world -y).
// `upper` (everything above the hips) pivots at the hips to lean forward and rise out of the chair.

const SKIN = "#f6c3a1";
const SUIT = "#17a7c8";
const HAIR = "#f47a1f";
const RED = "#e2382f";
const TIE = "#f59b1c";

const L_UPPER = 0.24; // shoulder to elbow
const L_FORE = 0.22; // elbow to wrist
const HAND = 0.045; // wrist to the middle of the palm
const SHOULDER = { x: 0.0, y: 0.178, z: 0.34 }; // in `upper`, mirrored for the left arm
const HIP_Z = 0.06;
const MAX_STRETCH = 1.5; // his arms stretch this much at most
const MAX_LEAN = 0.36; // radians: further and his chest meets the table's edge
const NECK_Z = 0.4;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, ...extra });

function capsule(radius, length, material) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 8, 20), material);
  mesh.castShadow = true;
  return mesh;
}

function sphere(radius, material, segments = 28) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, segments, Math.round(segments * 0.75)), material);
  mesh.castShadow = true;
  return mesh;
}

// Points a Y-axis capsule from a to b.
function span(mesh, a, b) {
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(Y_AXIS, b.clone().sub(a).normalize());
}

const ease = (k) => k * k * (3 - 2 * k);
const lerp = (a, b, k) => a + (b - a) * k;

export function createBusinessman({ nextFrame }) {
  const M = {
    skin: mat(SKIN, { roughness: 0.45 }),
    suit: mat(SUIT, { roughness: 0.55 }),
    hair: mat(HAIR, { roughness: 0.35 }),
    red: mat(RED, { roughness: 0.25 }),
    white: mat("#fbfbf8", { roughness: 0.3 }),
    black: mat("#111", { roughness: 0.15 }),
    tie: mat(TIE, { roughness: 0.4 }),
    mouth: mat("#5a1414", { roughness: 0.6 }),
    chair: mat("#202329", { roughness: 0.6 }),
    chrome: mat("#9aa1ab", { metalness: 0.9, roughness: 0.25 }),
    case: mat("#f08a24", { roughness: 0.35 }),
  };

  const root = new THREE.Group();
  root.name = "businessman";
  const seatZ = TABLE_Z - OPPONENT.seatBelowTable;
  const floorZ = TABLE_Z - TABLE.height;
  root.position.set(OPPONENT.x, OPPONENT.y, seatZ);
  root.rotation.z = Math.PI;
  root.scale.setScalar(OPPONENT.scale); // everything below is in his model's units
  const floor = (floorZ - seatZ) / OPPONENT.scale; // floor height in root's frame

  // ---------------------------------------------------------------- chair, legs, briefcase
  const chair = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.46, 0.06), M.chair);
  seat.position.set(-0.02, 0, -0.03);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.46), M.chair);
  back.position.set(-0.27, 0, 0.25);
  back.rotation.y = -0.12;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, -floor - 0.1, 16), M.chrome);
  post.rotation.x = Math.PI / 2;
  post.position.set(-0.02, 0, (floor + 0.08 - 0.06) / 2);
  chair.add(seat, back, post);
  for (let k = 0; k < 5; k += 1) {
    const a = (k / 5) * Math.PI * 2;
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.03, 0.02), M.chrome);
    leg.position.set(-0.02 + 0.14 * Math.cos(a), 0.14 * Math.sin(a), floor + 0.07);
    leg.rotation.z = a;
    const wheel = sphere(0.025, M.chair, 12);
    wheel.position.set(-0.02 + 0.27 * Math.cos(a), 0.27 * Math.sin(a), floor + 0.025);
    chair.add(leg, wheel);
  }
  chair.traverse((m) => { if (m.isMesh) m.castShadow = true; });
  root.add(chair);

  for (const side of [-1, 1]) {
    const hip = new THREE.Vector3(0.02, side * 0.085, 0.07);
    const knee = new THREE.Vector3(0.34, side * 0.09, 0.07);
    const ankle = new THREE.Vector3(0.36, side * 0.09, floor + 0.07);
    const thigh = capsule(0.062, 0.3, M.suit);
    span(thigh, hip, knee);
    const shin = capsule(0.05, knee.z - ankle.z - 0.05, M.suit);
    span(shin, knee, ankle);
    const shoe = capsule(0.042, 0.08, M.suit);
    shoe.rotation.z = Math.PI / 2;
    shoe.position.set(0.4, side * 0.09, floor + 0.035);
    shoe.scale.set(1, 1.25, 0.8);
    root.add(thigh, shin, shoe);
  }

  const briefcase = new THREE.Group();
  const caseBody = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.36, 0.27), M.case);
  caseBody.castShadow = true;
  const caseHandle = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.009, 10, 20, Math.PI), M.chrome);
  caseHandle.rotation.x = Math.PI / 2;
  caseHandle.rotation.y = Math.PI / 2;
  caseHandle.position.z = 0.135;
  briefcase.add(caseBody, caseHandle);
  briefcase.position.set(0.08, 0.36, floor + 0.135);
  briefcase.rotation.z = 0.25;
  root.add(briefcase);

  // ---------------------------------------------------------------- upper body
  const upper = new THREE.Group();
  upper.position.set(0, 0, HIP_Z);
  root.add(upper);

  // The jacket: a capsule stood upright (its axis along z), squashed front to back and widened sideways.
  const torso = capsule(0.15, 0.13, M.suit);
  torso.quaternion.setFromUnitVectors(Y_AXIS, new THREE.Vector3(0, 0, 1));
  torso.position.set(0, 0, 0.2);
  upper.add(torso);

  // Shirt front, lapels and tie.
  const shirtFront = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, 0.17), M.white);
  shirtFront.position.set(0.118, 0, 0.32);
  upper.add(shirtFront);
  for (const side of [-1, 1]) {
    const lapel = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.07, 0.2), M.suit);
    lapel.position.set(0.122, side * 0.052, 0.31);
    lapel.rotation.x = side * 0.42;
    lapel.castShadow = true;
    upper.add(lapel);
  }
  const knot = sphere(0.016, M.tie, 16);
  knot.position.set(0.133, 0, 0.385);
  knot.scale.set(0.7, 1, 0.9);
  // The tie's blade: a four-sided cone, point down, flattened against the shirt.
  // Its own x (wide) goes across the chest, its axis (y, the point) down, its thin z outwards.
  const blade = new THREE.Mesh(new THREE.ConeGeometry(0.024, 0.14, 4), M.tie);
  blade.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0)));
  blade.scale.set(1, 1, 0.35);
  blade.position.set(0.132, 0, 0.305);
  upper.add(knot, blade);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.096, 0.022, 12, 32), M.white);
  collar.position.set(0, 0, NECK_Z - 0.01);
  upper.add(collar);

  // Head: one tall pill with the neck. `head` pivots at the neck to look around.
  const head = new THREE.Group();
  head.position.set(0, 0, NECK_Z);
  upper.add(head);
  const pill = capsule(0.095, 0.25, M.skin);
  pill.quaternion.setFromUnitVectors(Y_AXIS, new THREE.Vector3(0, 0, 1));
  pill.position.set(0, 0, 0.17);
  head.add(pill);
  const FACE_Z = 0.26; // eye height above the neck
  for (const side of [-1, 1]) {
    const ear = sphere(0.024, M.skin, 16);
    ear.scale.set(0.6, 0.5, 1);
    ear.position.set(-0.005, side * 0.093, FACE_Z - 0.02);
    head.add(ear);
  }
  // Hair: a cap over the dome, a big swoop at the front, tufts over the ears.
  const cap = sphere(0.104, M.hair, 32);
  cap.scale.set(1.06, 1.04, 0.62);
  cap.position.set(-0.006, 0, 0.405);
  const swoop = sphere(0.07, M.hair, 24);
  swoop.scale.set(1.25, 1.1, 0.55);
  swoop.position.set(0.05, -0.035, 0.425);
  swoop.rotation.set(0.2, -0.35, -0.3);
  const curl = sphere(0.04, M.hair, 20);
  curl.scale.set(1.2, 0.9, 0.6);
  curl.position.set(0.09, 0.05, 0.4);
  curl.rotation.set(-0.3, -0.4, 0.4);
  head.add(cap, swoop, curl);
  for (const side of [-1, 1]) {
    const tuft = sphere(0.04, M.hair, 16);
    tuft.scale.set(1.1, 0.6, 1.2);
    tuft.position.set(-0.02, side * 0.088, 0.33);
    head.add(tuft);
  }
  // Eyes (googly), brows, nose, lips.
  const eyes = [];
  for (const side of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(0.078, side * 0.042, FACE_Z);
    const white = sphere(0.032, M.white, 24);
    const pupil = sphere(0.016, M.black, 18);
    pupil.position.set(0.024, 0, 0);
    pupil.scale.set(0.6, 1, 1);
    const glint = sphere(0.0045, M.white, 8);
    glint.position.set(0.034, -0.006, 0.007);
    eye.add(white, pupil, glint);
    head.add(eye);
    const brow = capsule(0.0065, 0.03, M.hair); // lies along y, across the face
    brow.position.set(0.088, side * 0.044, FACE_Z + 0.052);
    head.add(brow);
    eyes.push({ group: eye, pupil, glint, brow, side });
  }
  const nose = sphere(0.019, M.red, 20);
  nose.position.set(0.1, 0, FACE_Z - 0.035);
  nose.scale.set(1, 1, 1.05);
  head.add(nose);
  const mouth = new THREE.Group();
  mouth.position.set(0.088, 0, FACE_Z - 0.078);
  const inside = sphere(0.022, M.mouth, 16);
  inside.scale.set(0.4, 1.2, 0.3);
  mouth.add(inside);
  // Lips: two curved tubes (rebuilt when the expression changes) with round corners.
  const lips = { upper: new THREE.Mesh(new THREE.BufferGeometry(), M.red), lower: new THREE.Mesh(new THREE.BufferGeometry(), M.red) };
  const corners = [-1, 1].map(() => sphere(0.0108, M.red, 14));
  mouth.add(lips.upper, lips.lower, ...corners);
  head.add(mouth);
  const LIP_HALF_WIDTH = 0.029;
  let lipShape = "";
  function shapeLips(smile, open) {
    const key = `${smile.toFixed(2)} ${open.toFixed(2)}`;
    if (key === lipShape) return;
    lipShape = key;
    for (const [name, mesh] of Object.entries(lips)) {
      const lower = name === "lower";
      const z0 = lower ? -0.0075 - 0.022 * open : 0.0055 + 0.004 * open;
      const bend = smile * 0.011 * (lower ? 1 : 0.75); // > 0: the corners go up
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(-0.003, -LIP_HALF_WIDTH, z0 + bend + (lower ? 0.006 : -0.004) * (1 - open)),
        new THREE.Vector3(0.007, 0, z0 - bend),
        new THREE.Vector3(-0.003, LIP_HALF_WIDTH, z0 + bend + (lower ? 0.006 : -0.004) * (1 - open)),
      );
      mesh.geometry.dispose();
      mesh.geometry = new THREE.TubeGeometry(curve, 24, lower ? 0.0118 : 0.0102, 12, false);
    }
    const cornerZ = 0.0015 + 0.011 * smile * 0.9 - 0.008 * open;
    corners.forEach((c, i) => c.position.set(-0.003, (i ? 1 : -1) * LIP_HALF_WIDTH, cornerZ));
  }

  // Arms: meshes in `upper`, posed every frame from IK.
  function buildArm(side) {
    const upperArm = capsule(0.042, L_UPPER - 0.03, M.suit);
    const fore = capsule(0.038, L_FORE - 0.03, M.suit);
    const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.01, 10, 24), M.white);
    const hand = new THREE.Group();
    const palm = sphere(0.04, M.skin, 20);
    palm.scale.set(1.15, 0.95, 0.72);
    const thumb = capsule(0.013, 0.025, M.skin);
    thumb.position.set(0.012, side * -0.035, 0.008);
    thumb.rotation.set(0.5 * side, 0, 0.9 * side);
    hand.add(palm, thumb);
    upper.add(upperArm, fore, cuff, hand);
    return { side, upperArm, fore, cuff, hand, palm, thumb, shoulder: new THREE.Vector3(SHOULDER.x, side * SHOULDER.y, SHOULDER.z) };
  }
  const arms = { right: buildArm(-1), left: buildArm(1) };

  // ---------------------------------------------------------------- pose state
  // Everything the animations change; update() turns it into mesh transforms.
  const restHand = (side) => new THREE.Vector3(0.3, side * 0.15, 0.0); // in root's frame; z set from the table below
  const tableZ = (TABLE_Z - seatZ) / OPPONENT.scale; // the table top in root's frame
  const state = {
    lean: 0.08, rise: 0, headTurn: 0, headTilt: 0,
    hands: {
      right: { pos: restHand(-1).setZ(tableZ + 0.04), grip: 0 },
      left: { pos: restHand(1).setZ(tableZ + 0.04), grip: 0 },
    },
    look: null, // world point the eyes follow, or null (straight ahead)
    brows: 0, // -1 angry, 0 neutral, 1 raised
    smile: 0.3, // -1 frown .. 1 big smile
    open: 0, // mouth open 0..1
    blink: 0,
    breathe: 0,
    bounce: 0,
  };
  const rest = { right: restHand(-1).setZ(tableZ + 0.04), left: restHand(1).setZ(tableZ + 0.04) };

  const world = (v) => root.localToWorld(v.clone());
  const local = (v) => root.worldToLocal(v.clone());

  // Two-bone IK in `upper`'s frame: elbow position for a shoulder, a wrist target and a pole direction.
  // A cartoon arm stretches (rubber-hose style, up to MAX_STRETCH) rather than fall short.
  function solveArm(S, T, pole) {
    const toT = T.clone().sub(S);
    let d = toT.length();
    const stretch = Math.min(MAX_STRETCH, Math.max(1, d / (0.97 * (L_UPPER + L_FORE))));
    const a = L_UPPER * stretch;
    const b = L_FORE * stretch;
    const max = a + b - 0.002;
    if (d > max) {
      toT.multiplyScalar(max / d);
      d = max;
    }
    d = Math.max(d, Math.abs(a - b) + 0.01);
    const u = toT.clone().normalize();
    const v = pole.clone().addScaledVector(u, -pole.dot(u)).normalize();
    const cosA = (a * a + d * d - b * b) / (2 * a * d);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const E = S.clone().addScaledVector(u, a * cosA).addScaledVector(v, a * sinA);
    return { E, W: S.clone().addScaledVector(u, d), stretch };
  }

  const basis = new THREE.Matrix4();
  function poseArm(arm, target, grip) {
    // target: where the middle of the palm should be, in root's frame.
    const p = upper.worldToLocal(root.localToWorld(target.clone()));
    const S = arm.shoulder;
    // Aim the wrist a hand's length back from the palm, along the reach.
    const reachDir = p.clone().sub(S).normalize();
    const wristGoal = p.clone().addScaledVector(reachDir, -HAND);
    const pole = new THREE.Vector3(-0.35, arm.side * 0.9, -0.7).normalize();
    const { E, W, stretch } = solveArm(S, wristGoal, pole);
    span(arm.upperArm, S, E);
    span(arm.fore, E, W);
    arm.upperArm.scale.set(1, stretch, 1);
    arm.fore.scale.set(1, stretch, 1);
    const f = W.clone().sub(E).normalize();
    arm.cuff.position.copy(W).addScaledVector(f, -0.012);
    arm.cuff.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f);
    // Hand: forward along the forearm, back of the hand up.
    const up = new THREE.Vector3(0, 0, 1);
    const z = up.clone().addScaledVector(f, -up.dot(f));
    if (z.lengthSq() < 1e-6) z.set(-1, 0, 0);
    z.normalize();
    const y = z.clone().cross(f);
    basis.makeBasis(f, y, z);
    arm.hand.quaternion.setFromRotationMatrix(basis);
    arm.hand.position.copy(W).addScaledVector(f, HAND * 0.85);
    const squeeze = 1 - 0.25 * grip;
    arm.palm.scale.set(1.15 * (1 - 0.1 * grip), 0.95 * squeeze, 0.72 * (1 + 0.2 * grip));
    arm.thumb.rotation.z = (0.9 - 0.6 * grip) * arm.side * -1;
  }

  // Where a held piece sits: just under the palm, in world coordinates.
  function gripPoint(which = "right") {
    root.updateMatrixWorld(true);
    const hand = arms[which].hand;
    const p = new THREE.Vector3(0, 0, -0.03);
    return hand.localToWorld(p);
  }

  let lastLook = new THREE.Vector3();
  function update(dt, t) {
    state.breathe = Math.sin(t * 1.6);
    upper.position.z = HIP_Z + state.rise + 0.004 * state.breathe + state.bounce;
    upper.rotation.set(0, state.lean, 0);
    torso.scale.set(0.82 + 0.006 * state.breathe, 1, 1.15);
    // Head: turn towards what he's looking at, a little.
    let turn = state.headTurn;
    let tilt = state.headTilt;
    root.updateMatrixWorld(true);
    if (state.look) {
      const p = head.worldToLocal(state.look.clone());
      lastLook.copy(p);
      turn += THREE.MathUtils.clamp(Math.atan2(p.y, p.x) * 0.45, -0.45, 0.45);
      tilt += THREE.MathUtils.clamp(-Math.atan2(p.z - FACE_Z, Math.hypot(p.x, p.y)) * 0.4, -0.35, 0.5);
    }
    head.rotation.set(0, tilt, turn, "ZYX");
    head.updateMatrixWorld(true);
    // Pupils follow the look target.
    for (const e of eyes) {
      let dy = 0;
      let dz = 0;
      if (state.look) {
        const p = e.group.worldToLocal(state.look.clone());
        const dir = p.normalize();
        dy = THREE.MathUtils.clamp(dir.y * 0.02, -0.012, 0.012);
        dz = THREE.MathUtils.clamp(dir.z * 0.02, -0.012, 0.012);
      }
      e.pupil.position.set(0.024 - Math.abs(dy) * 0.3, dy, dz);
      e.glint.position.set(0.034, dy - 0.006, dz + 0.007);
      const open = 1 - state.blink;
      e.group.scale.set(1, 1, Math.max(0.08, open));
      // Brows: raised = up and a little arched; angry = inner ends down (outer ends up).
      e.brow.position.set(0.088, e.side * 0.044, FACE_Z + 0.05 + 0.012 * Math.max(0, state.brows));
      e.brow.rotation.set(state.brows < 0 ? e.side * 0.5 * -state.brows : -e.side * 0.15 * state.brows, 0, 0);
    }
    shapeLips(state.smile, state.open);
    inside.scale.set(0.4, 1.2, 0.2 + 1.6 * state.open);
    inside.position.z = -0.008 * state.open;
    poseArm(arms.right, state.hands.right.pos, state.hands.right.grip);
    poseArm(arms.left, state.hands.left.pos, state.hands.left.grip);
    if (carry) carry(gripPoint(carryHand));
  }

  // ---------------------------------------------------------------- animation helpers
  let clock = 0;
  async function tween(ms, step) {
    const start = performance.now();
    for (;;) {
      const k = Math.min(1, (performance.now() - start) / ms);
      step(ease(k), k);
      if (k >= 1) return;
      await nextFrame();
    }
  }
  const wait = (ms) => tween(ms, () => {});
  function blendTo(target, ms) {
    const from = { ...state };
    return tween(ms, (k) => {
      for (const [key, value] of Object.entries(target)) state[key] = lerp(from[key], value, k);
    });
  }

  // Moves one hand along an arc to a root-frame point (lifts `arc` metres in the middle).
  async function moveHand(which, to, ms, { arc = 0.05, lean = null, rise = null } = {}) {
    const h = state.hands[which];
    const from = h.pos.clone();
    const leanFrom = state.lean;
    const riseFrom = state.rise;
    await tween(ms, (k) => {
      h.pos.lerpVectors(from, to, k);
      h.pos.z += arc * Math.sin(Math.PI * k);
      if (lean !== null) state.lean = lerp(leanFrom, lean, k);
      if (rise !== null) state.rise = lerp(riseFrom, rise, k);
    });
  }

  // How far to lean (and rise) to reach a root-frame point: the further, the more, up to where his
  // chest would meet the table's edge; the arm stretches for the rest.
  function leanFor(target) {
    const reachOut = Math.hypot(target.x, target.y + SHOULDER.y);
    const lean = THREE.MathUtils.clamp((reachOut - 0.32) * 0.9, 0.05, MAX_LEAN);
    return { lean, rise: 0.02 * lean / MAX_LEAN };
  }

  let carry = null; // called every frame with the grip point while holding a piece
  let carryHand = "right";
  let blinkAt = 2;
  let lineHandler = () => {};

  function idle(dt, t) {
    clock += dt;
    // Blink every few seconds.
    if (clock > blinkAt) {
      const k = clock - blinkAt;
      state.blink = k < 0.08 ? k / 0.08 : k < 0.16 ? 1 - (k - 0.08) / 0.08 : 0;
      if (k > 0.16) {
        state.blink = 0;
        blinkAt = clock + 2 + Math.random() * 3.5;
      }
    }
    update(dt, t);
  }

  // ---------------------------------------------------------------- what he does
  const say = (text, ms = 2800) => lineHandler(text, ms);

  async function think(ms, lookAtCells = []) {
    // Hand on chin, brows up, eyes wandering over the board.
    const leftFrom = state.hands.left.pos.clone();
    const chinTarget = upper.localToWorld(new THREE.Vector3(0.16, 0.0, NECK_Z + 0.16));
    const chinRoot = root.worldToLocal(chinTarget);
    await Promise.all([moveHand("left", chinRoot, 500, { arc: 0.02 }), blendTo({ brows: 0.8, smile: 0, headTilt: 0.12 }, 400)]);
    const until = performance.now() + ms;
    let i = 0;
    while (performance.now() < until) {
      if (lookAtCells.length) state.look = lookAtCells[i % lookAtCells.length].clone();
      i += 1;
      await wait(Math.min(450, until - performance.now()));
    }
    await Promise.all([moveHand("left", leftFrom, 450, { arc: 0.02 }), blendTo({ brows: 0, headTilt: 0 }, 300)]);
  }

  // Picks up `piece` (a mesh, lying flat) and puts it down centred on world point `cell`.
  // hold/release/follow come from the physics: hold(piece) makes it follow carry() poses.
  // The hand target (root frame) that puts the grip point, where a held piece's centre sits, on a
  // world point, with his body leaned as given. Solved by aiming, posing and correcting a few times.
  function palmFor(which, world, lean, rise) {
    const saved = [state.lean, state.rise, upper.position.z];
    upper.position.z = HIP_Z + rise;
    upper.rotation.set(0, lean, 0);
    root.updateMatrixWorld(true);
    const want = local(world);
    const guess = want.clone();
    for (let i = 0; i < 8; i += 1) {
      poseArm(arms[which], guess, 1);
      const miss = want.clone().sub(local(gripPoint(which)));
      guess.add(miss);
      if (miss.length() < 2e-4) break;
    }
    upper.position.z = saved[2];
    upper.rotation.set(0, saved[0], 0);
    root.updateMatrixWorld(true);
    return guess;
  }

  // Picks up `piece` (a mesh, lying flat) and puts it down with its centre on world point `cell`
  // (2.5 mm above where it will rest). hold/release/follow come from the physics: while held, the
  // piece goes wherever follow() puts it, which is his grip point.
  async function placePiece(piece, cell, { hold, release, follow }) {
    const pieceWorld = piece.position.clone();
    const dropWorld = new THREE.Vector3(cell.x, cell.y, cell.z + 0.0025);
    const pickRoot = local(pieceWorld);
    const cellRoot = local(dropWorld);
    const above = (p, h) => p.clone().setZ(p.z + h);
    state.look = pieceWorld.clone();
    const reachTray = leanFor(pickRoot);
    const grab = palmFor("right", pieceWorld, reachTray.lean, reachTray.rise);
    await moveHand("right", above(grab, 0.07), 650, { arc: 0.04, lean: reachTray.lean, rise: reachTray.rise });
    await moveHand("right", grab, 260, { arc: 0 });
    await tween(160, (k) => (state.hands.right.grip = k));
    hold(piece);
    carryHand = "right";
    carry = (p) => follow(piece, p);
    state.look = dropWorld.clone();
    await moveHand("right", above(grab, 0.08), 280, { arc: 0 });
    const reachCell = leanFor(cellRoot);
    const drop = palmFor("right", dropWorld, reachCell.lean, reachCell.rise);
    await moveHand("right", above(drop, 0.07), 900, { arc: 0.05, lean: reachCell.lean, rise: reachCell.rise });
    await moveHand("right", drop, 380, { arc: 0 });
    carry = null;
    release(piece);
    await tween(160, (k) => (state.hands.right.grip = 1 - k));
    await moveHand("right", above(cellRoot, 0.06), 260, { arc: 0 });
    await Promise.all([
      moveHand("right", rest.right.clone(), 750, { arc: 0.04, lean: 0.08, rise: 0 }),
      blendTo({ smile: 0.8 }, 400),
    ]);
  }

  async function react(kind) {
    if (kind === "won") {
      say(pick(["Crushed it. Bonus secured.", "And that's how you close a deal.", "Put that in the quarterly report!"]), 3500);
      await Promise.all([blendTo({ smile: 1, open: 0.7, brows: 1 }, 300),
        moveHand("right", new THREE.Vector3(0.12, -0.25, tableZ + 0.7), 450, { arc: 0 }),
        moveHand("left", new THREE.Vector3(0.12, 0.25, tableZ + 0.7), 450, { arc: 0 })]);
      for (let i = 0; i < 3; i += 1) await tween(320, (k) => (state.bounce = 0.04 * Math.sin(Math.PI * k)));
      await Promise.all([moveHand("right", rest.right.clone(), 600), moveHand("left", rest.left.clone(), 600), blendTo({ open: 0, smile: 0.7, brows: 0 }, 500)]);
    } else if (kind === "lost") {
      say(pick(["I'd like to speak to your manager.", "Let's take this offline.", "This is a hostile takeover!", "My lawyers will hear about this."]), 3800);
      await Promise.all([blendTo({ smile: -1, open: 0.35, brows: -1, lean: -0.05, headTilt: 0.35 }, 450),
        moveHand("left", root.worldToLocal(upper.localToWorld(new THREE.Vector3(0.16, 0.0, NECK_Z + 0.3))), 500, { arc: 0.02 })]);
      await wait(1600);
      await Promise.all([moveHand("left", rest.left.clone(), 600), blendTo({ smile: -0.2, open: 0, brows: -0.3, lean: 0.08, headTilt: 0 }, 600)]);
    } else {
      say(pick(["Let's call it a win-win.", "A tie. Very... synergistic.", "We'll circle back on this."]), 3200);
      await Promise.all([blendTo({ smile: 0.2, brows: 1 }, 300),
        moveHand("right", new THREE.Vector3(0.25, -0.32, tableZ + 0.2), 450, { arc: 0 }),
        moveHand("left", new THREE.Vector3(0.25, 0.32, tableZ + 0.2), 450, { arc: 0 })]);
      await wait(900);
      await Promise.all([moveHand("right", rest.right.clone(), 500), moveHand("left", rest.left.clone(), 500), blendTo({ brows: 0, smile: 0.3 }, 400)]);
    }
  }

  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  // His pose and face as plain data, so another tab can show him exactly as he is here.
  const SCALARS = ["lean", "rise", "headTurn", "headTilt", "brows", "smile", "open", "blink", "bounce"];
  function exportState() {
    const out = {};
    for (const key of SCALARS) out[key] = Math.round(state[key] * 1e4) / 1e4;
    out.hands = Object.fromEntries(Object.entries(state.hands).map(([k, h]) => [k, { pos: h.pos.toArray(), grip: h.grip }]));
    out.look = state.look ? state.look.toArray() : null;
    return out;
  }
  function importState(data) {
    for (const key of SCALARS) state[key] = data[key];
    for (const [k, h] of Object.entries(data.hands)) {
      state.hands[k].pos.fromArray(h.pos);
      state.hands[k].grip = h.grip;
    }
    state.look = data.look ? new THREE.Vector3().fromArray(data.look) : null;
  }

  return {
    root,
    update: idle,
    apply: update, // poses him from `state` without his own blinking (for a mirror)
    exportState,
    importState,
    think,
    placePiece,
    react,
    say,
    pick,
    setMood: (mood, ms = 300) => blendTo(mood, ms),
    lookAt: (point) => (state.look = point ? point.clone() : null),
    onLine: (fn) => (lineHandler = fn),
    headTop: () => upper.localToWorld(new THREE.Vector3(0, 0, NECK_Z + 0.5)),
    // A point beside his face: side 1 is his left (the arm's right), -1 his right.
    mouthSide: (side = 1) => head.localToWorld(new THREE.Vector3(0.05, side * 0.11, FACE_Z - 0.05)),
    state,
  };
}
