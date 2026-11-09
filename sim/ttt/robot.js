import * as THREE from "three";
import { BOARD_TOP, TABLE_Z, X_PIECE, cellCenter, onBoard } from "./layout.js";
import { MAX_TILT } from "./reach.js";

// The arm's two jobs on your turn, using only what the table camera sees:
//   pick(the X you chose): hover over it, come straight down, close until two fingers touch it, lift it
//     and hold it up out of the camera's way while you choose a square.
//   drop(the square you chose): carry it over the square, lower it until its lowest corner is 1.5 mm
//     above the board, open just enough to let go, rise straight up, park; then look again and measure
//     how far from the square's centre it landed and how far from square it sits.
// The fingers close across the X's diagonal, into the notches between its arms. Left alone, an X would
// land turned by however much the arm's heading differs between the pick and the drop, so the wrist roll
// turns the line the fingers close along. The square isn't known at the pick, so the pick turns it by the
// middle of what the empty squares would need, and the drop turns it the rest of the way for the square
// you chose (keeping the fingers' tilt small at both ends). The drop is planned by predicting where the
// held X will sit, from the claw's pose at the pick and at the drop.

const D = THREE.MathUtils.radToDeg;
const R = THREE.MathUtils.degToRad;
const SQUARE = R(45); // an X reads as an "X" with its bars at 45° to the grid
const CLEAR = [0.045, 0.04, 0.035, 0.03]; // fingertips this far above the surface while near pieces
const HIGH = [0.1, 0.09, 0.08, 0.07]; // and this high coming in from the holding pose
const GRASP_TIP = 0.0018; // the lower fingertip this far above the surface when closing on a piece
const DROP_GAP = 0.0015; // the piece's underside this far above the board when let go
const OPEN_FOR_X = 0.026; // half the fingertip gap when the fingers reach an X's notches
const MAX_IK_ERROR = 0.003;
const CLOSE_STEP = 2; // percent per frame
const RELEASE_OPENING = 14; // open this many percent past where it gripped to let go

// Bar direction (mod 90°) wrapped to (-45°, 45°].
const wrapQuarter = (a) => Math.atan2(Math.sin(4 * a), Math.cos(4 * a)) / 4;

export function createRobot({ reach, physics, vision, moveArm, park, hold, nextFrame, waitForRest, setClaw, setStatus = () => {} }) {
  const degrees = (angles) => angles.map((a) => D(a));

  // A pose with the lower fingertip at one of tipZs over (x, y). The tilt limit keeps the low fingertip off
  // the board near a piece; up in the air (maxTilt passed) the fingers can tilt further.
  function poseAt(x, y, tipZs, yaw, seeds, maxTilt = MAX_TILT + 0.02) {
    for (const tipZ of tipZs) {
      const result = reach.solveTips(x, y, tipZ, { yaw, halfOpening: OPEN_FOR_X, seeds });
      if (result.error <= MAX_IK_ERROR && result.tilt <= maxTilt) return result;
    }
    return null;
  }
  const IN_AIR_TILT = 0.5;

  // Natural (level-finger) drop pose over each cell, which doesn't depend on the piece: cached.
  const natural = new Map();
  function naturalDrop(cell) {
    if (!natural.has(cell)) {
      const t = cellCenter(cell);
      natural.set(cell, reach.solveTips(t.x, t.y, BOARD_TOP + DROP_GAP + GRASP_TIP, { halfOpening: OPEN_FOR_X }));
    }
    return natural.get(cell);
  }

  function clawFrame(result) {
    const x = result.axis.clone().normalize();
    const y = result.across.clone().addScaledVector(x, -result.across.dot(x)).normalize();
    return new THREE.Matrix4().makeBasis(x, y, x.clone().cross(y)).setPosition(result.position);
  }
  const corners = [];
  for (const [hx, hy] of [[X_PIECE.length / 2, X_PIECE.width / 2], [X_PIECE.width / 2, X_PIECE.length / 2]]) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push(new THREE.Vector3(sx * hx, sy * hy, sz * X_PIECE.height / 2));
  }
  // Where a piece held since `grasp` ends up with the claw at `drop`: bar direction, lowest corner, centre.
  function carried(piecePose, grasp, drop) {
    const pose = clawFrame(drop).multiply(clawFrame(grasp).invert()).multiply(piecePose);
    const bar = new THREE.Vector3(1, 0, 0).transformDirection(pose);
    const lowest = Math.min(...corners.map((c) => c.clone().applyMatrix4(pose).z));
    return { yaw: Math.atan2(bar.y, bar.x), lowest, centre: new THREE.Vector3().setFromMatrixPosition(pose) };
  }

  // ---------------------------------------------------------------- pick
  // A plan for picking `piece` (from the camera: x, y, yaw, surface), turned for the empty cells.
  function planPick(piece, cells) {
    const pickZ = piece.surface + GRASP_TIP;
    const atPick = reach.solveTips(piece.x, piece.y, pickZ, { halfOpening: OPEN_FOR_X });
    if (atPick.error > MAX_IK_ERROR) return null;
    // The turn each empty cell would need, with no turn at the pick...
    const needs = cells.map((cell) => wrapQuarter(SQUARE - (piece.yaw - atPick.closeYaw + naturalDrop(cell).closeYaw)));
    // ...and a pick turn that leaves the drop the middle of that range.
    let pre = needs.length ? (Math.max(...needs) + Math.min(...needs)) / 2 : 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const pickYaw = atPick.closeYaw - pre; // turning the closing line by -pre turns the landing by +pre
      const grasp = poseAt(piece.x, piece.y, [pickZ], pickYaw, [atPick.angles]);
      const hover = grasp && poseAt(piece.x, piece.y, CLEAR.map((h) => piece.surface + h), pickYaw, [grasp.angles], IN_AIR_TILT);
      const high = hover && poseAt(piece.x, piece.y, HIGH.map((h) => piece.surface + h), pickYaw, [hover.angles], IN_AIR_TILT);
      if (grasp && hover) {
        return {
          piece, grasp, pickYaw,
          piecePose: new THREE.Matrix4().makeRotationZ(piece.yaw).setPosition(piece.x, piece.y, piece.surface + X_PIECE.height / 2),
          moves: { high: high ? degrees(high.angles) : null, hover: degrees(hover.angles), grasp: degrees(grasp.angles) },
          preTurnDeg: D(pre), graspAngleDeg: D(wrapQuarter(piece.yaw - grasp.closeYaw)),
        };
      }
      pre *= 0.7;
    }
    return null;
  }

  async function closeClaw() {
    for (let percent = 0; percent <= 100; percent += CLOSE_STEP) {
      setClaw(percent);
      await nextFrame();
      const piece = physics.pieceBetweenFingers();
      if (piece) {
        physics.hold(piece);
        return { piece, percent };
      }
    }
    return { piece: null, percent: 100 };
  }

  // Picks the planned X up and holds it out of the way. Returns { ok, held } (held: what drop() needs).
  // Every move from one side of the table to the other goes up and over (the holding pose, then high
  // above the target), so the claw never sweeps low across the pieces.
  async function pick(plan) {
    setStatus("Arm: picking up your X");
    await hold();
    await moveArm(null, 0);
    if (plan.moves.high) await moveArm(plan.moves.high);
    await moveArm(plan.moves.hover);
    await moveArm(plan.moves.grasp);
    const { piece, percent } = await closeClaw();
    if (!piece) {
      await moveArm(plan.moves.hover, 0);
      if (plan.moves.high) await moveArm(plan.moves.high);
      await park();
      return { ok: false, line: "The claw closed on nothing" };
    }
    await moveArm(plan.moves.hover);
    if (plan.moves.high) await moveArm(plan.moves.high);
    await hold();
    setStatus("Arm: holding your X");
    return { ok: true, held: { plan, piece, percent } };
  }

  // ---------------------------------------------------------------- drop
  // A plan for putting the held X down centred and square on `cell`, or null if the arm can't.
  let why = null; // why the last planDrop() said no (for the console)
  function planDrop(held, cell) {
    const { plan } = held;
    const target = cellCenter(cell);
    const atDrop = naturalDrop(cell);
    why = "the square is out of reach";
    if (atDrop.error > MAX_IK_ERROR) return null;
    function attempt(dropYaw) {
      let aim = { x: target.x, y: target.y };
      let tipZ = BOARD_TOP + DROP_GAP + GRASP_TIP;
      let drop = null;
      let landed = null;
      for (let i = 0; i < 3; i += 1) {
        drop = poseAt(aim.x, aim.y, [tipZ], dropYaw, [atDrop.angles, plan.grasp.angles]);
        if (!drop) {
          why = `no drop pose at ${(tipZ * 1000).toFixed(1)} mm (aim ${(aim.x * 1000).toFixed(0)}, ${(aim.y * 1000).toFixed(0)}; lowest corner was ${landed ? (landed.lowest * 1000).toFixed(1) : "?"} mm)`;
          return null;
        }
        landed = carried(plan.piecePose, plan.grasp, drop);
        tipZ += BOARD_TOP + DROP_GAP - landed.lowest;
        aim = { x: aim.x + target.x - landed.centre.x, y: aim.y + target.y - landed.centre.y };
      }
      return { drop, landed, aim, dropYaw };
    }
    let best = attempt(atDrop.closeYaw);
    if (!best) return null;
    for (let i = 0; i < 4; i += 1) {
      const miss = wrapQuarter(best.landed.yaw - SQUARE);
      if (Math.abs(miss) < R(0.5)) break;
      let next = attempt(best.dropYaw - miss);
      // Too much tilt for the full turn: go part of the way.
      for (let k = 0; !next && k < 5; k += 1) next = attempt(best.dropYaw - miss * 0.6 ** (k + 1));
      if (!next) break;
      best = next;
    }
    const above = poseAt(best.aim.x, best.aim.y, CLEAR.map((h) => BOARD_TOP + h), best.dropYaw, [best.drop.angles], IN_AIR_TILT);
    why = "can't come in from above";
    if (!above) return null;
    why = null;
    const high = poseAt(best.aim.x, best.aim.y, HIGH.map((h) => BOARD_TOP + h), best.dropYaw, [above.angles], IN_AIR_TILT);
    return {
      cell, target,
      moves: { high: high ? degrees(high.angles) : null, above: degrees(above.angles), drop: degrees(best.drop.angles) },
      expectedOffSquareDeg: D(wrapQuarter(best.landed.yaw - SQUARE)), tilt: Math.max(plan.grasp.tilt, best.drop.tilt),
    };
  }

  // The cells (of those given) the held X can be put down on.
  const droppable = (held, cells) => cells.filter((cell) => planDrop(held, cell));

  async function drop(held, cell) {
    const planned = planDrop(held, cell);
    if (!planned) return { ok: false, line: "The arm can't reach that square" };
    const { piece, percent } = held;
    setStatus("Arm: putting your X down");
    if (planned.moves.high) await moveArm(planned.moves.high);
    await moveArm(planned.moves.above);
    await moveArm(planned.moves.drop);
    await moveArm(null, Math.max(0, percent - RELEASE_OPENING));
    physics.release(piece);
    await waitForRest(1200);
    await moveArm(planned.moves.above);
    await moveArm(null, 0);
    if (planned.moves.high) await moveArm(planned.moves.high);
    await park();
    await waitForRest(2000);
    const after = vision.detect();
    const target = planned.target;
    const mine = after.ok
      ? after.pieces.filter((p) => p.kind === "X").sort((a, b) => Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y))[0]
      : null;
    const offMm = mine ? Math.hypot(mine.x - target.x, mine.y - target.y) * 1000 : null;
    const offSquare = mine ? Math.abs(D(wrapQuarter(mine.yaw - SQUARE))) : null;
    const truthMm = Math.hypot(piece.position.x - target.x, piece.position.y - target.y) * 1000; // for the console only
    const flat = new THREE.Vector3(0, 0, 1).applyQuaternion(piece.quaternion).z;
    const ok = mine !== null && mine.cell === cell && offMm < 12;
    const line = ok
      ? `Placed: ${offMm.toFixed(1)} mm from the centre, ${offSquare.toFixed(0)}° off square (measured by the camera)`
      : `The X landed off its square${offMm !== null ? ` (${offMm.toFixed(0)} mm out)` : ""}`;
    return {
      ok, line, piece, offMm, offSquareDeg: offSquare, truthMm, flat,
      plan: { preTurnDeg: held.plan.preTurnDeg, expectedOffSquareDeg: planned.expectedOffSquareDeg, tilt: planned.tilt, graspAngleDeg: held.plan.graspAngleDeg },
      onTable: piece.position.z < TABLE_Z + X_PIECE.height,
    };
  }

  // Spare X pieces (off the board) the camera sees, each with a pick plan.
  function spares(seen, cells) {
    return seen.filter((p) => p.kind === "X" && !onBoard(p.x, p.y))
      .map((piece) => ({ piece, plan: planPick(piece, cells) }))
      .filter((o) => o.plan);
  }

  return { spares, planPick, pick, planDrop, droppable, drop, get why() { return why; } };
}
