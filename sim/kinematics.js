import * as THREE from "three";
import { solveLinear } from "./linalg.js";

// Forward and inverse kinematics for the arm's four main joints, built from the
// same joint chain the renderer uses (arm.json), so they always agree.
// The claw points along the forearm (there's no wrist pitch), so how steeply it comes down follows
// from where the shoulder and elbow put it; the wrist roll turns the fingers so they close
// sideways (horizontally) on the cube.
export const ARM_JOINT_NAMES = ["yaw_joint", "shoulder_joint", "elbow_joint", "roll_joint"];

const MEASURE_CLAW = 0.5; // grip point is measured with the claw half closed
const PAD_BACK = 0.012; // grip point: this far back from the fingertips, mid-pad

export function createKinematics(arm) {
  const chain = ARM_JOINT_NAMES.map((name) => {
    const joint = arm.joints.get(name);
    return { name, offset: joint.group.position.clone(), axis: joint.axis.clone(), range: joint.range };
  });
  const palm = arm.root.getObjectByName("wrist_palm");
  const { grip, closing } = measureClaw(arm, palm); // in the palm's frame
  const pointing = grip.clone().normalize(); // palm origin towards the grip point
  const turn = new THREE.Quaternion();

  function forward(angles) {
    const position = grip.clone();
    const axis = pointing.clone();
    const across = closing.clone();
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      turn.setFromAxisAngle(chain[i].axis, angles[i]);
      position.applyQuaternion(turn).add(chain[i].offset);
      axis.applyQuaternion(turn);
      across.applyQuaternion(turn);
    }
    return { position, axis, across };
  }

  const current = () => chain.map(({ name }) => arm.joints.get(name).value);
  const clamp = (angles) => angles.map((v, i) => Math.min(chain[i].range[1], Math.max(chain[i].range[0], v)));

  // Damped least squares on [position error, fingers closing horizontally, how far the claw is
  // from pointing straight down]. Position counts most; level fingers next; steepness is a nudge.
  function descend(target, start, downWeight, iterations) {
    const residual = (angles) => {
      const { position, axis, across } = forward(angles);
      return [position.x - target.x, position.y - target.y, position.z - target.z, 0.05 * across.z, downWeight * (axis.z + 1)];
    };
    const cost = (r) => r.reduce((sum, v) => sum + v * v, 0);
    let angles = clamp(start);
    let r = residual(angles);
    let c = cost(r);
    let damping = 1e-3;
    for (let it = 0; it < iterations && c > 1e-14; it += 1) {
      const J = angles.map((_, j) => {
        const nudged = angles.slice();
        nudged[j] += 1e-6;
        return residual(nudged).map((v, k) => (v - r[k]) / 1e-6);
      }); // J[j][k] = d r_k / d angle_j
      const A = J.map((a, i) => J.map((b, j) => a.reduce((s, v, k) => s + v * b[k], 0) + (i === j ? damping : 0)));
      const g = J.map((a) => -a.reduce((s, v, k) => s + v * r[k], 0));
      const step = solveLinear(A, g);
      if (!step) break;
      const next = clamp(angles.map((v, j) => v + step[j]));
      const rNext = residual(next);
      const cNext = cost(rNext);
      if (cNext < c) {
        angles = next; r = rNext; c = cNext;
        damping = Math.max(1e-9, damping / 3);
      } else {
        damping *= 5;
        if (damping > 1e3) break;
      }
    }
    return angles;
  }

  // Joint angles (radians) that put the grip point on target, or the closest found.
  // onlySeeds: try just the given seeds (fast, for checking many nearby points in a row).
  function solve(target, { seeds = [], onlySeeds = false } = {}) {
    const heading = Math.atan2(target.y, target.x);
    const starts = onlySeeds && seeds.length ? seeds : [
      ...seeds,
      [heading, 0.6, 0.3, 0],
      [heading, 0.3, -0.2, 0],
      [heading, 0.9, 0.6, 0],
      [heading, 0.6, 0.3, 1.2],
      [heading, 0.6, 0.3, -1.2],
    ];
    let best = null;
    for (const start of starts) {
      const rough = descend(target, start, 0.03, 120);
      const angles = descend(target, rough, 0.002, 60); // tighten position
      const { position, axis, across } = forward(angles);
      const result = { angles, error: position.distanceTo(target), downness: -axis.z, tilt: Math.abs(across.z) };
      const score = (x) => x.error + 0.01 * (1 - x.downness) + 0.005 * x.tilt;
      if (!best || score(result) < score(best)) best = result;
    }
    return best;
  }

  return { solve, forward, current, gripPoint: () => forward(current()).position, chain };
}

// The grip point is between the two finger pads, and "closing" is the direction from one fingertip
// to the other, both in the palm's frame.
function measureClaw(arm, palm) {
  const saved = [...arm.joints].map(([name, joint]) => [name, joint.value]);
  const savedClaw = arm.claw;
  arm.setClaw(MEASURE_CLAW);
  arm.root.updateMatrixWorld(true);
  const palmOrigin = new THREE.Vector3().setFromMatrixPosition(palm.matrixWorld);
  const tips = [];
  const vertex = new THREE.Vector3();
  arm.root.traverse((group) => {
    if (!/^finger_\d+_tip$/.test(group.name)) return;
    let tip = null;
    let farthest = -1;
    group.children.forEach((part) => {
      if (!part.isMesh) return;
      const positions = part.geometry.attributes.position;
      for (let i = 0; i < positions.count; i += 1) {
        vertex.fromBufferAttribute(positions, i).applyMatrix4(part.matrixWorld);
        const distance = vertex.distanceTo(palmOrigin);
        if (distance > farthest) { farthest = distance; tip = vertex.clone(); }
      }
    });
    tips.push(tip);
  });
  const centre = tips.reduce((sum, t) => sum.add(t), new THREE.Vector3()).multiplyScalar(1 / tips.length);
  const back = palmOrigin.clone().sub(centre).normalize().multiplyScalar(PAD_BACK);
  const gripWorld = centre.add(back);
  const acrossWorld = tips[1].clone().sub(tips[0]);
  saved.forEach(([name, value]) => arm.setJoint(name, value));
  arm.setClaw(savedClaw);
  arm.root.updateMatrixWorld(true);
  const grip = palm.worldToLocal(gripWorld.clone());
  const palmRotation = new THREE.Quaternion();
  palm.getWorldQuaternion(palmRotation);
  const closing = acrossWorld.applyQuaternion(palmRotation.invert()).normalize();
  return { grip, closing };
}
