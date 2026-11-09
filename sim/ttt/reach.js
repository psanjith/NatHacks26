import { solveLinear } from "../linalg.js";
import { createKinematics } from "../kinematics.js";

// Inverse kinematics for flat pieces. The arm has no wrist pitch, so where the grip point goes fixes
// the yaw, shoulder and elbow, and only the wrist roll is left free. kinematics.js spends it on keeping
// the fingers level. Here it can instead turn the line the fingers close along, seen from above, to a
// chosen direction: that's how an X gets squared to the grid. The price is that the fingers tilt (one
// fingertip lower than the other), so the turn is limited and the grip point is raised to keep the
// lower fingertip off the table.

const PAD_BACK = 0.012; // fingertips are this far past the grip point (kinematics.js measures the grip there)
export const MAX_TILT = 0.22; // sine of the fingers' tilt from level we accept (about 13°)

const wrapHalfTurn = (a) => Math.atan2(Math.sin(2 * a), Math.cos(2 * a)) / 2; // to (-90°, 90°]: the claw is symmetric

export function createReach(arm) {
  const kin = createKinematics(arm);
  const { forward, chain } = kin;
  const clamp = (angles) => angles.map((v, i) => Math.min(chain[i].range[1], Math.max(chain[i].range[0], v)));

  // Damped least squares on [position, closing direction (or level fingers), a nudge towards steep].
  function descend(target, start, yaw, iterations, downWeight) {
    const s = yaw === null ? 0 : Math.sin(yaw);
    const c = yaw === null ? 0 : Math.cos(yaw);
    const residual = (angles) => {
      const { position, axis, across } = forward(angles);
      const turn = yaw === null ? 0.05 * across.z : 0.4 * (across.x * s - across.y * c);
      return [position.x - target.x, position.y - target.y, position.z - target.z, turn, downWeight * (axis.z + 1)];
    };
    const cost = (r) => r.reduce((sum, v) => sum + v * v, 0);
    let angles = clamp(start);
    let r = residual(angles);
    let cst = cost(r);
    let damping = 1e-3;
    for (let it = 0; it < iterations && cst > 1e-16; it += 1) {
      const J = angles.map((_, j) => {
        const nudged = angles.slice();
        nudged[j] += 1e-6;
        return residual(nudged).map((v, k) => (v - r[k]) / 1e-6);
      });
      const A = J.map((a, i) => J.map((b, j) => a.reduce((sum, v, k) => sum + v * b[k], 0) + (i === j ? damping : 0)));
      const g = J.map((a) => -a.reduce((sum, v, k) => sum + v * r[k], 0));
      const step = solveLinear(A, g);
      if (!step) break;
      const next = clamp(angles.map((v, j) => v + step[j]));
      const rNext = residual(next);
      const cNext = cost(rNext);
      if (cNext < cst) {
        angles = next; r = rNext; cst = cNext;
        damping = Math.max(1e-9, damping / 3);
      } else {
        damping *= 5;
        if (damping > 1e3) break;
      }
    }
    return angles;
  }

  function describe(angles, target) {
    const { position, axis, across } = forward(angles);
    return {
      angles,
      error: position.distanceTo(target),
      tilt: Math.abs(across.z),
      down: -axis.z,
      closeYaw: Math.atan2(across.y, across.x),
      axis,
      across,
      position,
    };
  }

  // Joint angles (radians) putting the grip point on target. yaw: the direction (radians, from +x
  // towards +y) the fingers should close along, seen from above; null keeps them level.
  function solve(target, { yaw = null, seeds = [] } = {}) {
    const heading = Math.atan2(target.y, target.x);
    const starts = [...seeds, [heading, 0.6, 0.3, 0.2], [heading, 0.3, -0.2, 0.2], [heading, 0.9, 0.6, 0.2], [heading, 0.6, 0.3, 1.0], [heading, 0.6, 0.3, -0.6]];
    let best = null;
    for (const start of starts) {
      const rough = descend(target, start, yaw, 120, 0.02);
      const angles = descend(target, rough, yaw, 80, 0.001);
      const result = describe(angles, target);
      const yawMiss = yaw === null ? 0 : Math.abs(wrapHalfTurn(result.closeYaw - yaw));
      result.yawMiss = yawMiss;
      const score = (x) => x.error + 0.02 * x.yawMiss + 0.005 * x.tilt;
      if (!best || score(result) < score(best)) best = result;
    }
    return best;
  }

  // Joint angles with the lower fingertip at tipZ over (x, y): the grip point rises with how steeply
  // the claw points down and how far the fingers tilt. halfOpening: half the fingertip gap.
  function solveTips(x, y, tipZ, { yaw = null, halfOpening = 0.02, seeds = [] } = {}) {
    let z = tipZ + PAD_BACK * 0.8;
    let result = null;
    for (let i = 0; i < 4; i += 1) {
      const target = { x, y, z };
      result = solve(target, { yaw, seeds: result ? [result.angles, ...seeds] : seeds });
      const next = tipZ - PAD_BACK * result.axis.z + halfOpening * result.tilt;
      if (Math.abs(next - z) < 2e-4) break;
      z = next;
    }
    result.tipZ = result.position.z + PAD_BACK * result.axis.z - halfOpening * result.tilt;
    return result;
  }

  // The fingers' natural closing direction at a spot (level fingers), radians.
  const naturalYaw = (x, y, z, seeds = []) => solve({ x, y, z }, { seeds }).closeYaw;

  return { solve, solveTips, naturalYaw, forward, kin, wrapHalfTurn };
}
