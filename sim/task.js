import * as THREE from "three";
import { calibrate, pixelToPlane, worldToPixel } from "./calibrate.js";
import { HEIGHT, WIDTH, captureFrame, convexHull, detectObjects } from "./detect.js";
import { BASKET, BOARD_SIZE, CUBE_SIZE, TABLE_Z } from "./layout.js";
import { TABLE } from "./world.js";

// Pick and place, using only what the table camera sees:
// park -> calibrate from the board stickers -> detect cubes -> locate each on the
// table -> plan the moves (inverse kinematics) -> the person picks a reachable cube ->
// hover, descend, close, lift -> (place anywhere) park while holding it, the person
// looks at a spot on the table and clenches -> lower it there and let go; otherwise
// move over the basket and release -> park.

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

// Place anywhere: candidate spots on a polar grid around the arm. Each passes or fails a
// few checks, judged only from what the camera saw: reachable, free, on the table (off the
// arm's base board), and inside the camera's view.
const PLACE_GRID = { radii: [0.17, 0.2, 0.23, 0.26], yawMin: -85, yawMax: 85, yawStep: 10 };
const PLACE_CLEARANCE = 0.008; // the cube's bottom is this far above the table when it's let go
const PLACE_FREE = 0.06; // centre to centre: a 4 cm cube plus room for the fingers and some error
const BOARD_MARGIN = 0.01; // the whole cube must be off the arm's base board (a 12.7 mm step), with this to spare
const BASKET_MARGIN = 0.03; // and this far from the basket's walls
const TABLE_MARGIN = 0.05; // and this far from the table's edge
const IMAGE_MARGIN = 0.04; // the whole cube must be inside the image, this far from its edges
const PLACE_TOLERANCE = 0.025; // landed within this of the chosen spot counts as placed there
const SUGGESTED_SPOTS = 4; // table spots offered when choosing with glances (plus the basket)

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

  // ---------------------------------------------------------------- place anywhere
  // Joint angles to put a held cube down at (x, y): "above" it, then "lower" (the cube just
  // clear of the table). Cached: it depends only on the spot, not on what's on the table.
  const reachCache = new Map();
  function placeMoves(x, y, seed) {
    const key = `${x.toFixed(4)},${y.toFixed(4)}`;
    if (reachCache.has(key)) return reachCache.get(key);
    const centreZ = TABLE_Z + CUBE_SIZE / 2;
    const stops = [["above", HOVER.map((h) => centreZ + h)], ["lower", [centreZ + GRASP_RAISE + PLACE_CLEARANCE]]];
    const moves = {};
    let previous = seed;
    let result = null;
    for (const [name, heights] of stops) {
      let reached = null;
      for (const z of heights) {
        const target = new THREE.Vector3(x, y, z);
        // A neighbouring spot's answer is usually right next to this one: try it alone first.
        let solution = previous ? kinematics.solve(target, { seeds: [previous], onlySeeds: true }) : null;
        if (!solution || solution.error > MAX_IK_ERROR) solution = kinematics.solve(target, { seeds: previous ? [previous] : [] });
        if (solution && solution.error <= MAX_IK_ERROR) {
          reached = solution;
          break;
        }
      }
      if (!reached) break;
      moves[name] = degrees(reached.angles);
      previous = reached.angles;
    }
    if (moves.above && moves.lower) result = { moves, seed: previous };
    reachCache.set(key, result);
    return result;
  }

  // Outline of a cube standing at (x, y), in image coordinates (0-1).
  function cubeOutline(x, y) {
    const corners = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const z of [TABLE_Z, TABLE_Z + CUBE_SIZE]) {
      corners.push(worldToPixel(calibration, x + sx * CUBE_SIZE / 2, y + sy * CUBE_SIZE / 2, z));
    }
    return convexHull(corners).map(([u, v]) => [u / WIDTH, v / HEIGHT]);
  }

  // The cheap checks, in order. Returns why a spot can't be used, or null if it can.
  function spotProblem(x, y, hull, others) {
    const base = BOARD_SIZE / 2 + BOARD_MARGIN + CUBE_SIZE / 2;
    if (Math.abs(x) < base && Math.abs(y) < base) return "on the arm's base";
    if (x < TABLE.minX + TABLE_MARGIN || x > TABLE.maxX - TABLE_MARGIN || Math.abs(y) > TABLE.halfY - TABLE_MARGIN) return "off the table";
    if (inBasket(x, y, BASKET_MARGIN + CUBE_SIZE / 2)) return "the basket is in the way";
    if (hull.some(([u, v]) => u < IMAGE_MARGIN || u > 1 - IMAGE_MARGIN || v < IMAGE_MARGIN || v > 1 - IMAGE_MARGIN)) return "outside the camera's view";
    const near = others.find((o) => Math.hypot(o.table.x - x, o.table.y - y) < PLACE_FREE);
    if (near) return `too close to ${near.id}`;
    return null;
  }

  // Every candidate spot with its verdict, plus the basket. others: the cubes the camera saw
  // on the table (not the one being carried).
  function placeSpots(others, drop) {
    const spots = [];
    let seed = null;
    for (const r of PLACE_GRID.radii) {
      for (let yaw = PLACE_GRID.yawMin; yaw <= PLACE_GRID.yawMax; yaw += PLACE_GRID.yawStep) {
        const a = THREE.MathUtils.degToRad(yaw);
        const x = r * Math.cos(a);
        const y = r * Math.sin(a);
        const hull = cubeOutline(x, y);
        let reason = spotProblem(x, y, hull, others);
        let moves = null;
        if (!reason) {
          const reach = placeMoves(x, y, seed);
          if (reach) {
            moves = reach.moves;
            seed = reach.seed;
          } else reason = "out of the arm's reach";
        }
        spots.push({ id: `spot_${spots.length}`, kind: "table", x, y, yaw, hull, ok: !reason, reason, moves });
      }
    }
    spots.push({ id: "basket", kind: "basket", x: drop.x, y: drop.y, hull: basketInImage().map(([u, v]) => [u / WIDTH, v / HEIGHT]), ok: true, reason: null });
    return spots;
  }

  // A few table spots spread across the view, for choosing with glances (one glance = one spot).
  function suggestSpots(spots) {
    const ok = spots.filter((s) => s.ok && s.kind === "table").sort((a, b) => a.yaw - b.yaw || a.x - b.x);
    if (ok.length <= SUGGESTED_SPOTS) return ok.map((s) => s.id);
    const picked = new Set();
    for (let k = 0; k < SUGGESTED_SPOTS; k += 1) picked.add(ok[Math.round((k * (ok.length - 1)) / (SUGGESTED_SPOTS - 1))].id);
    return [...picked];
  }

  // What the camera tab needs to draw a spot (no joint angles).
  function spotForCamera({ id, kind, hull, ok, reason }) {
    const us = hull.map((p) => p[0]);
    const vs = hull.map((p) => p[1]);
    const center = [us.reduce((a, b) => a + b, 0) / us.length, vs.reduce((a, b) => a + b, 0) / vs.length];
    return { id, kind, hull, ok, reason, center, box: [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)] };
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

  // choose picks the cube (eyes + clench): it gets { onTable, reachable } and resolves to
  // { target (or null: don't pick), line }.
  // choosePlace (optional) picks where to put it: it gets { spots, suggested } once the cube is
  // held, and resolves to { spot (or null: the basket), line }. Without it: the basket.
  async function pickCube(choose, { choosePlace = null } = {}) {
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

    const decision = await choose({ onTable, reachable }); // waits for the person
    if (!decision.target) {
      setStatus(decision.line);
      return { ok: false, reason: "nothing picked", decision, seen: targets.length };
    }
    const choice = decision.target;
    const prefix = `${decision.line} `;
    const truth = trueCubeNear(choice.table.x, choice.table.y);
    publishTargets(onTable, choice.id);
    setStatus(`${prefix}Picking cube ${choice.id} of ${onTable.length}`);

    await moveArm(null, 0);
    await moveArm(choice.moves.hover);
    await moveArm(choice.moves.grasp);
    const { cube: held, percent: gripped } = await closeClaw();
    await moveArm(choice.moves.lift);
    let spot = null; // where the person chose to put it (null: the basket)
    if (held && choosePlace) {
      const heldName = held.name.replace("cube_", "");
      setStatus(`${prefix}Holding ${heldName}: working out where it can go`);
      await park(); // holding it, out of the camera's way
      await nextFrame();
      const others = onTable.filter((t) => t !== choice);
      const spots = placeSpots(others, drop);
      const suggested = suggestSpots(spots);
      const okCount = spots.filter((s) => s.ok && s.kind === "table").length;
      publishTargets([], null, { place: { spots: spots.map(spotForCamera), suggested: [...suggested, "basket"] } });
      setStatus(`${prefix}Holding ${heldName}: look where to put it (${okCount} spots on the table, or the basket)`);
      const placement = await choosePlace({ spots, suggested });
      spot = placement?.spot?.kind === "table" ? placement.spot : null;
      publishTargets([], null);
    }
    if (held && spot) {
      await moveArm(spot.moves.above);
      await moveArm(spot.moves.lower);
      await moveArm(null, Math.max(0, gripped - RELEASE_OPENING)); // let go just above the table
      physics.release(held);
      await waitForRest(1500);
      await moveArm(spot.moves.above); // straight up before swinging away
    } else if (held) {
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

    const errorMm = Math.round(truth.distance * 1000);
    const name = (held ?? truth.cube).name.replace("cube_", "");
    const accuracy = errorMm < 1 ? "under 1 mm" : `${errorMm} mm`;
    let landed;
    let line;
    if (held && spot) {
      const offMm = Math.round(Math.hypot(held.position.x - spot.x, held.position.y - spot.y) * 1000);
      landed = offMm <= PLACE_TOLERANCE * 1000 && held.position.z < TABLE_Z + CUBE_SIZE;
      line = landed ? `Put ${name} where you chose (${offMm} mm from the spot)` : `Put ${name} down ${offMm} mm from where you chose`;
    } else {
      landed = held && inBasket(held.position.x, held.position.y) && held.position.z < TABLE_Z + BASKET.height + CUBE_SIZE;
      line = landed
        ? `Put ${name} in the basket (camera located it to ${accuracy})`
        : held
          ? `Dropped ${name} outside the basket`
          : `Missed ${name}: the claw closed without gripping it (located ${accuracy} off)`;
    }
    const result = { ok: Boolean(landed), target: truth.cube.name, held: held?.name ?? null, landed: Boolean(landed),
      placedAt: held ? (spot ? "table" : "basket") : null, errorMm, seen: targets.length, decision };
    setStatus(prefix + line);
    return result;
  }

  return { pickCube, calibrateCamera, get calibration() { return calibration; } };
}
