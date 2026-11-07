import * as THREE from "three";
import { calibrate, pixelToPlane } from "./calibrate.js";
import { HEIGHT, WIDTH, captureFrame, detectObjects } from "./detect.js";
import { BASKET, CUBE_SIZE, TABLE_Z } from "./layout.js";

// Pick and place, using only what the table camera sees:
// park -> calibrate from the board stickers -> detect cubes -> locate each on the
// table -> plan the moves (inverse kinematics) -> pick a random reachable cube ->
// hover, descend, close, lift, move over the basket, release -> park.

// Heights in metres. The arm's reach shrinks with height near its base, so each
// stop uses the highest of its options the arm can reach.
const HOVER = [0.08, 0.07, 0.06, 0.05]; // above the cube's centre before descending
const GRASP_RAISE = 0.008; // grip point slightly above the cube's centre
const LIFT = [0.08, 0.07, 0.06, 0.05]; // lowest keeps a carried cube clear of 4 cm cubes
const RELEASE_ABOVE_RIM = [0.06, 0.05, 0.04, 0.03]; // grip point; the cube hangs ~2 cm below it
const GRIP_CLAW = 60; // percent closed when holding a cube
const MAX_IK_ERROR = 0.005; // reject moves the arm can't reach within 5 mm
const BASKET_SLOTS = [[-0.022, -0.022], [0.022, -0.022], [-0.022, 0.022], [0.022, 0.022]];

// The sim has no physics, so a cube counts as gripped when the closing claw's
// grip point is this close to the cube's real centre. Real positions are used
// only for this check and for reporting accuracy, never for planning.
const GRIP_TOLERANCE = { horizontal: 0.02, vertical: 0.03 };

export function createPickAndPlace({
  arm, kinematics, renderer, scene, camera, objects,
  moveArm, park, animate, worldChanged, publishTargets, setStatus,
}) {
  const palm = arm.root.getObjectByName("wrist_palm");
  const degrees = (angles) => angles.map((a) => THREE.MathUtils.radToDeg(a));
  let calibration = null;

  const inBasket = (x, y, margin = 0) =>
    Math.abs(x - BASKET.x) < BASKET.size / 2 + margin && Math.abs(y - BASKET.y) < BASKET.size / 2 + margin;

  function calibrateCamera() {
    calibration = calibrate(captureFrame(renderer, scene, camera), camera.fov);
    return calibration;
  }

  // Joint angles for each stop, or null if the arm can't reach one of them.
  function plan(point) {
    const rimZ = TABLE_Z + BASKET.height;
    const stops = [
      ["hover", point.x, point.y, HOVER.map((h) => point.z + h)],
      ["grasp", point.x, point.y, [point.z + GRASP_RAISE]],
      ["lift", point.x, point.y, LIFT.map((h) => point.z + h)],
      ["release", BASKET.x, BASKET.y, RELEASE_ABOVE_RIM.map((h) => rimZ + h)],
    ];
    const moves = {};
    let previous = null;
    for (const [name, x, y, heights] of stops) {
      let reached = null;
      for (const z of heights) {
        const solution = kinematics.solve(new THREE.Vector3(x, y, z), { seeds: previous ? [previous] : [] });
        if (solution && solution.error <= MAX_IK_ERROR) {
          reached = solution;
          break;
        }
      }
      if (!reached) return null;
      moves[name] = degrees(reached.angles);
      previous = reached.angles;
    }
    return moves;
  }

  function trueCubeNear(x, y) {
    let best = null;
    for (const cube of objects.children) {
      const d = Math.hypot(cube.position.x - x, cube.position.y - y);
      if (!best || d < best.distance) best = { cube, distance: d };
    }
    return best;
  }

  function cubeInClaw() {
    arm.root.updateMatrixWorld(true);
    const grip = kinematics.gripPoint();
    const near = trueCubeNear(grip.x, grip.y);
    if (!near) return null;
    const vertical = Math.abs(near.cube.position.z - grip.z);
    return near.distance <= GRIP_TOLERANCE.horizontal && vertical <= GRIP_TOLERANCE.vertical ? near.cube : null;
  }

  async function dropIntoBasket(cube) {
    const taken = objects.children.filter((c) => inBasket(c.position.x, c.position.y)).length;
    objects.attach(cube);
    const [dx, dy] = BASKET_SLOTS[taken % BASKET_SLOTS.length];
    const fromPosition = cube.position.clone();
    const fromRotation = cube.quaternion.clone();
    const toPosition = new THREE.Vector3(BASKET.x + dx, BASKET.y + dy, TABLE_Z + BASKET.wall + CUBE_SIZE / 2);
    const toRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.random() * Math.PI / 2);
    await animate(350, (k) => {
      cube.position.lerpVectors(fromPosition, toPosition, k * k); // falls, speeding up
      cube.quaternion.slerpQuaternions(fromRotation, toRotation, k);
      worldChanged();
    });
  }

  async function pickRandom() {
    setStatus("Parking the arm");
    await park();

    if (!calibration?.ok) {
      setStatus("Calibrating from the board stickers");
      calibrateCamera();
      if (!calibration.ok) {
        setStatus(`Calibration failed: ${calibration.reason}`);
        return { ok: false, reason: `calibration: ${calibration.reason}` };
      }
    }

    setStatus("Detecting cubes");
    const targets = detectObjects(renderer, scene, camera, objects).map((target) => ({
      ...target,
      table: pixelToPlane(calibration, target.center[0] * WIDTH, target.center[1] * HEIGHT, TABLE_Z + CUBE_SIZE / 2),
    }));
    const onTable = targets.filter((t) => !inBasket(t.table.x, t.table.y, 0.01));
    const reachable = onTable.map((t) => ({ ...t, moves: plan(t.table) })).filter((t) => t.moves);
    publishTargets(onTable, null);
    if (!reachable.length) {
      const reason = onTable.length ? `${onTable.length} cube(s) seen, none reachable` : "no cubes left outside the basket";
      setStatus(onTable.length ? `Can't reach any of the ${onTable.length} cubes` : "No cubes left on the table. Scatter them again.");
      return { ok: false, reason, seen: targets.length };
    }

    const choice = reachable[Math.floor(Math.random() * reachable.length)];
    const truth = trueCubeNear(choice.table.x, choice.table.y);
    publishTargets(onTable, choice.id);
    setStatus(`Picking cube ${choice.id} of ${onTable.length}`);

    await moveArm(null, 0);
    await moveArm(choice.moves.hover);
    await moveArm(choice.moves.grasp);
    await moveArm(null, GRIP_CLAW);
    const held = cubeInClaw();
    if (held) palm.attach(held);
    await moveArm(choice.moves.lift);
    await moveArm(choice.moves.release);
    await moveArm(null, 0);
    if (held) await dropIntoBasket(held);
    await park();
    publishTargets([], null);

    const errorMm = Math.round(truth.distance * 1000);
    const result = { ok: Boolean(held), cube: truth.cube.name, held: held?.name ?? null, errorMm, seen: targets.length };
    const name = truth.cube.name.replace("cube_", "");
    const accuracy = errorMm < 1 ? "under 1 mm" : `${errorMm} mm`;
    setStatus(held
      ? `Put ${name} in the basket (camera located it to ${accuracy})`
      : `Missed ${name}: camera located it ${accuracy} off`);
    return result;
  }

  return { pickRandom, calibrateCamera, get calibration() { return calibration; } };
}
