import * as THREE from "three";
import { RoomEnvironment } from "../vendor/RoomEnvironment.js";
import { loadArm } from "../arm.js";
import { createBusinessman } from "./businessman.js";
import { buildPieces } from "./pieces.js";
import { buildWorld } from "./world.js";

// The scene both tabs draw: the main sim (physics, arm, opponent, game) and the camera tab (the table
// camera's image, where the person chooses). The main sim sends snapshots; the camera tab mirrors them.

export const CHANNEL = "reach-ttt";
export const ARM_JOINTS = ["yaw_joint", "shoulder_joint", "elbow_joint", "roll_joint"];

export function createRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

export async function buildScene(renderer, { nextFrame, onProgress = () => {} }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#14171d");
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;
  scene.environmentRotation.x = Math.PI / 2;
  const { group: world, highlights, tableCamera } = buildWorld();
  const pieceSet = buildPieces();
  const bm = createBusinessman({ nextFrame });
  scene.add(world, pieceSet.group, bm.root);
  const arm = await loadArm(onProgress);
  scene.add(arm.root);
  return { scene, tableCamera, highlights, pieceSet, bm, arm };
}

// Everything that moves, as plain data: arm joints (radians) and claw, every piece's pose, the
// opponent's pose and face.
export function snapshot({ arm, pieceSet, bm }) {
  const r = (v) => Math.round(v * 1e5) / 1e5;
  return {
    t: performance.timeOrigin + performance.now(), // ms, the same clock in every tab
    joints: ARM_JOINTS.map((name) => r(arm.joints.get(name).value)),
    claw: r(arm.claw),
    pieces: [...pieceSet.xs, ...pieceSet.os].map((m) => [...m.position.toArray(), ...m.quaternion.toArray()].map(r)),
    bm: bm.exportState(),
  };
}

export function applySnapshot(s, { arm, pieceSet, bm }) {
  ARM_JOINTS.forEach((name, i) => arm.setJoint(name, s.joints[i]));
  arm.setClaw(s.claw);
  [...pieceSet.xs, ...pieceSet.os].forEach((m, i) => {
    const p = s.pieces[i];
    m.position.set(p[0], p[1], p[2]);
    m.quaternion.set(p[3], p[4], p[5], p[6]);
  });
  bm.importState(s.bm);
}

// The camera tab's copy of the scene, shown 0.15 s behind the sim (delayMs) and blended between the
// two snapshots either side of that moment, so motion stays smooth however unevenly the messages arrive
// (the sim tab pauses for up to ~0.13 s when it looks for pieces, which this hides).
export function createMirror(world, delayMs = 150) {
  const buffer = [];
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const lerp = (a, b, k) => a + (b - a) * k;
  const lerp3 = (a, b, k) => a.map((v, i) => lerp(v, b[i], k));
  function blend(a, b, k) {
    const bm = { ...b.bm };
    for (const [key, v] of Object.entries(a.bm)) if (typeof v === "number" && typeof b.bm[key] === "number") bm[key] = lerp(v, b.bm[key], k);
    bm.hands = Object.fromEntries(Object.entries(b.bm.hands).map(([name, h]) => {
      const from = a.bm.hands[name];
      return [name, from ? { pos: lerp3(from.pos, h.pos, k), grip: lerp(from.grip, h.grip, k) } : h];
    }));
    bm.look = a.bm.look && b.bm.look ? lerp3(a.bm.look, b.bm.look, k) : b.bm.look;
    return {
      joints: a.joints.map((v, i) => lerp(v, b.joints[i], k)),
      claw: lerp(a.claw, b.claw, k),
      pieces: a.pieces.map((p, i) => {
        const q = b.pieces[i];
        qa.set(p[3], p[4], p[5], p[6]).slerp(qb.set(q[3], q[4], q[5], q[6]), k);
        return [...lerp3(p.slice(0, 3), q.slice(0, 3), k), qa.x, qa.y, qa.z, qa.w];
      }),
      bm,
    };
  }
  return {
    reset() {
      buffer.length = 0;
    },
    push(s) {
      if (!Number.isFinite(s.t)) s = { ...s, t: performance.timeOrigin + performance.now() };
      const last = buffer[buffer.length - 1];
      if (last && s.t <= last.t) {
        if (s.t > last.t - 2000) return; // late or repeated
        buffer.length = 0; // the sim restarted
      }
      buffer.push(s);
    },
    // Poses the scene for this moment; false if nothing has arrived yet.
    apply() {
      if (!buffer.length) return false;
      const at = performance.timeOrigin + performance.now() - delayMs;
      while (buffer.length > 2 && buffer[1].t <= at) buffer.shift();
      const [a, b] = buffer;
      if (!b || at <= a.t) applySnapshot(at <= a.t || !b ? a : b, world);
      else {
        const k = (at - a.t) / (b.t - a.t);
        applySnapshot(at >= b.t || !Number.isFinite(k) ? b : blend(a, b, k), world);
      }
      return true;
    },
  };
}
