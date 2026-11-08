import * as THREE from "three";
import { calibrate, pixelToPlane, worldToPixel } from "./calibrate.js";
import { HEIGHT, WIDTH, captureFrame, convexHull, detectObjects } from "./detect.js";
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
const RELEASE_ABOVE_RIM = [0.05, 0.045, 0.04, 0.035]; // grip point; keeps the fingertips above cubes already in the basket
const RETREAT_ABOVE_RIM = [0.08, 0.07, 0.06, 0.05]; // rise straight up before swinging away, so the claw doesn't drag through the basket
const RELEASE_OPENING = 20; // after dropping, open the claw only this many percent past where it gripped
const CLOSE_STEP = 2; // claw closes by this many percent per frame, until it grips
const MAX_IK_ERROR = 0.005; // reject moves the arm can't reach within 5 mm
// Drop spots in the basket's corners (offsets from its centre), filled in turn by
// how many cubes the camera already sees in the basket, so cubes don't land on
// each other and tumble out.
const BASKET_SPOTS = [[0.035, -0.035], [-0.035, -0.035], [0.035, 0.035], [0, 0]]; // the corner nearest the base is out of reach at this height
// Real cube positions (from physics) are used only to report results, never to plan.

export function createPickAndPlace({
  kinematics, physics, renderer, scene, camera, objects,
  moveArm, park, nextFrame, waitForRest, publishTargets, setClaw, setStatus,
}) {
  const degrees = (angles) => angles.map((a) => THREE.MathUtils.radToDeg(a));
  let calibration = null;

  const inBasket = (x, y, margin = 0) =>
    Math.abs(x - BASKET.x) < BASKET.size / 2 + margin && Math.abs(y - BASKET.y) < BASKET.size / 2 + margin;

  // The basket's outline in the camera image, from its known position.
  function basketInImage() {
    const corners = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const z of [TABLE_Z, TABLE_Z + BASKET.height]) {
      corners.push(worldToPixel(calibration, BASKET.x + sx * BASKET.size / 2, BASKET.y + sy * BASKET.size / 2, z));
    }
    return convexHull(corners);
  }

  function insidePolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function calibrateCamera() {
    calibration = calibrate(captureFrame(renderer, scene, camera), camera.fov);
    return calibration;
  }

  // Joint angles for each stop, or null if the arm can't reach one of them.
  function plan(point, drop) {
    const rimZ = TABLE_Z + BASKET.height;
    const stops = [
      ["hover", point.x, point.y, HOVER.map((h) => point.z + h)],
      ["grasp", point.x, point.y, [point.z + GRASP_RAISE]],
      ["lift", point.x, point.y, LIFT.map((h) => point.z + h)],
      ["release", drop.x, drop.y, RELEASE_ABOVE_RIM.map((h) => rimZ + h)],
      ["retreat", drop.x, drop.y, RETREAT_ABOVE_RIM.map((h) => rimZ + h)],
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

  // Closes the claw a little at a time until two fingers touch a cube (it is then
  // held) or the claw is fully shut (a miss).
  async function closeClaw() {
    for (let percent = 0; percent <= 100; percent += CLOSE_STEP) {
      setClaw(percent);
      await nextFrame();
      const cube = physics.cubeBetweenFingers();
      if (cube) {
        physics.hold(cube);
        return { cube, percent };
      }
    }
    return { cube: null, percent: 100 };
  }

  // choose (optional): picks the cube instead of chance, e.g. from recorded EEG.
  // It gets { onTable, reachable } and returns { target (or null to wait), line }.
  async function pickRandom(choose = null) {
    setStatus("Parking the arm");
    await park();
    setStatus("Waiting for the cubes to settle");
    await waitForRest();

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
    // Whether a detection is in the basket is judged in the image: cubes in it can
    // sit higher than the table (tilted, or on each other), which would throw
    // off their table position.
    const basketOutline = basketInImage();
    const alreadyIn = targets.filter((t) => insidePolygon(t.center[0] * WIDTH, t.center[1] * HEIGHT, basketOutline));
    const onTable = targets.filter((t) => !alreadyIn.includes(t));
    const [dx, dy] = BASKET_SPOTS[alreadyIn.length % BASKET_SPOTS.length];
    const drop = { x: BASKET.x + dx, y: BASKET.y + dy };
    const reachable = onTable.map((t) => ({ ...t, moves: plan(t.table, drop) })).filter((t) => t.moves);
    publishTargets(onTable, null);
    if (!reachable.length) {
      const reason = onTable.length ? `${onTable.length} cube(s) seen, none reachable` : "no cubes left outside the basket";
      setStatus(onTable.length ? `Can't reach any of the ${onTable.length} cubes` : "No cubes left on the table. Scatter them again.");
      return { ok: false, reason, seen: targets.length };
    }

    let choice;
    let prefix = "";
    let decision = null;
    if (choose) {
      decision = choose({ onTable, reachable });
      if (!decision.target) {
        setStatus(decision.line);
        return { ok: false, reason: "decoder did not pick", decision, seen: targets.length };
      }
      choice = decision.target;
      prefix = `${decision.line} `;
    } else {
      choice = reachable[Math.floor(Math.random() * reachable.length)];
    }
    const truth = trueCubeNear(choice.table.x, choice.table.y);
    publishTargets(onTable, choice.id);
    setStatus(`${prefix}Picking cube ${choice.id} of ${onTable.length}`);

    await moveArm(null, 0);
    await moveArm(choice.moves.hover);
    await moveArm(choice.moves.grasp);
    const { cube: held, percent: gripped } = await closeClaw();
    await moveArm(choice.moves.lift);
    if (held) {
      await moveArm(choice.moves.release);
      // Open just enough to let go (wide open, the fingers would sweep the basket),
      // and before letting the cube drop, so the fingers are clear of it.
      await moveArm(null, Math.max(0, gripped - RELEASE_OPENING));
      physics.release(held);
      await waitForRest(1500);
      await moveArm(choice.moves.retreat);
    }
    await moveArm(null, 0);
    await waitForRest(2500);
    await park();
    publishTargets([], null);

    const landed = held && inBasket(held.position.x, held.position.y) && held.position.z < TABLE_Z + BASKET.height + CUBE_SIZE;
    const errorMm = Math.round(truth.distance * 1000);
    const name = (held ?? truth.cube).name.replace("cube_", "");
    const accuracy = errorMm < 1 ? "under 1 mm" : `${errorMm} mm`;
    const result = { ok: Boolean(landed), target: truth.cube.name, held: held?.name ?? null, landed: Boolean(landed), errorMm, seen: targets.length, decision };
    setStatus(prefix + (landed
      ? `Put ${name} in the basket (camera located it to ${accuracy})`
      : held
        ? `Dropped ${name} outside the basket`
        : `Missed ${name}: the claw closed without gripping it (located ${accuracy} off)`));
    return result;
  }

  return { pickRandom, calibrateCamera, get calibration() { return calibration; } };
}
