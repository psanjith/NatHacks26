import * as THREE from "three";
import RAPIER from "./vendor/rapier/rapier.mjs";
import { BASKET, BOARD_SIZE, CUBE_SIZE, TABLE_Z } from "./layout.js";
import { TABLE } from "./world.js";

// Rigid-body physics (Rapier) for the cubes, with the arm as moving obstacles.
// The arm's parts follow its joints exactly (they're kinematic: they push cubes
// but cubes can't push them). A cube counts as held once two or more fingers
// touch it; it then moves with the claw until the claw opens. Real grip by
// friction alone is too unreliable in a game-style engine to be worth faking.

const STEP = 1 / 120; // seconds per physics step
const CUBE_DENSITY = 600; // kg/m³, about pine: a 4 cm cube weighs ~38 g
const FRICTION = 0.7;
const RESTITUTION = 0.1;
const MAX_HULL_POINTS = 20000;
const PEDESTAL = { radius: 0.075, height: 0.062 }; // the round base on the board
const TOUCH_DISTANCE = 0.001; // a finger within 1 mm of a cube touches it
const REST_SPEED = 0.01; // m/s: below this a cube counts as settled

export async function createPhysics({ arm, objects }) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
  world.timestep = STEP;
  world.lengthUnit = 0.1; // things here are centimetres across

  // Scenery that never moves.
  const scenery = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const box = (hx, hy, hz, x, y, z) =>
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(FRICTION), scenery);
  box((TABLE.maxX - TABLE.minX) / 2, TABLE.halfY, TABLE.thickness / 2, (TABLE.maxX + TABLE.minX) / 2, 0, TABLE_Z - TABLE.thickness / 2);
  box(BOARD_SIZE / 2, BOARD_SIZE / 2, -TABLE_Z / 2, 0, 0, TABLE_Z / 2);
  const upright = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2); // Rapier cylinders run along y
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(PEDESTAL.height / 2, PEDESTAL.radius).setTranslation(0, 0, PEDESTAL.height / 2).setRotation(upright),
    scenery,
  );
  const { size, height, wall } = BASKET;
  box(size / 2, size / 2, wall / 2, BASKET.x, BASKET.y, TABLE_Z + wall / 2);
  box(size / 2, wall / 2, height / 2, BASKET.x, BASKET.y + (size - wall) / 2, TABLE_Z + height / 2);
  box(size / 2, wall / 2, height / 2, BASKET.x, BASKET.y - (size - wall) / 2, TABLE_Z + height / 2);
  box(wall / 2, size / 2, height / 2, BASKET.x + (size - wall) / 2, BASKET.y, TABLE_Z + height / 2);
  box(wall / 2, size / 2, height / 2, BASKET.x - (size - wall) / 2, BASKET.y, TABLE_Z + height / 2);

  // The arm: one convex shape per moving part, from that part's own meshes.
  arm.root.updateMatrixWorld(true);
  const links = [];
  const fingerColliders = new Map(); // finger number -> its two colliders
  arm.root.traverse((group) => {
    if (!group.isGroup || group === arm.root) return; // the base is the board and pedestal above
    const meshes = group.children.filter((child) => child.isMesh);
    if (!meshes.length) return;
    const shape = RAPIER.ColliderDesc.convexHull(hullPoints(meshes));
    if (!shape) return;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    const collider = world.createCollider(shape.setFriction(FRICTION), body);
    links.push({ group, body, collider });
    const finger = /^finger_(\d)_/.exec(group.name);
    if (finger) {
      if (!fingerColliders.has(finger[1])) fingerColliders.set(finger[1], []);
      fingerColliders.get(finger[1]).push(collider);
    }
  });
  const palm = arm.root.getObjectByName("wrist_palm");

  // The cubes.
  const half = CUBE_SIZE / 2;
  const cubes = objects.children.map((mesh) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
        .setRotation(mesh.quaternion).setCcdEnabled(true),
    );
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(half, half, half).setDensity(CUBE_DENSITY).setFriction(FRICTION).setRestitution(RESTITUTION),
      body,
    );
    return { mesh, body, collider, grip: null };
  });

  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const held = new THREE.Matrix4();

  function followArm() {
    arm.root.updateMatrixWorld(true);
    for (const { group, body } of links) {
      group.matrixWorld.decompose(position, rotation, scale);
      body.setNextKinematicTranslation(position);
      body.setNextKinematicRotation(rotation);
    }
    for (const cube of cubes) {
      if (!cube.grip) continue;
      held.multiplyMatrices(palm.matrixWorld, cube.grip).decompose(position, rotation, scale);
      cube.body.setNextKinematicTranslation(position);
      cube.body.setNextKinematicRotation(rotation);
    }
  }

  // Copies body poses onto the meshes. Returns true if anything moved.
  function updateMeshes() {
    let moved = false;
    for (const { mesh, body, grip } of cubes) {
      if (body.isSleeping() && !grip) continue;
      const t = body.translation();
      const r = body.rotation();
      mesh.position.set(t.x, t.y, t.z);
      mesh.quaternion.set(r.x, r.y, r.z, r.w);
      moved = true;
    }
    return moved;
  }

  let pending = 0;
  // Runs the simulation forward by real elapsed time. Returns true if a cube moved.
  function advance(seconds) {
    pending += Math.min(seconds, 0.1); // don't try to catch up after a long pause
    if (pending < STEP) return false;
    followArm();
    while (pending >= STEP) {
      world.step();
      pending -= STEP;
    }
    return updateMeshes();
  }

  const cubeFor = (mesh) => cubes.find((cube) => cube.mesh === mesh);

  function fingersTouching(cube) {
    let count = 0;
    for (const colliders of fingerColliders.values()) {
      let touching = false;
      for (const collider of colliders) {
        world.contactPair(collider, cube.collider, (manifold) => {
          for (let i = 0; i < manifold.numContacts(); i += 1) {
            if (manifold.contactDist(i) <= TOUCH_DISTANCE) touching = true;
          }
        });
      }
      if (touching) count += 1;
    }
    return count;
  }

  return {
    advance,
    // The cube (mesh) that two or more fingers are touching, if any.
    cubeBetweenFingers() {
      const cube = cubes.find((c) => !c.grip && fingersTouching(c) >= 2);
      return cube?.mesh ?? null;
    },
    hold(mesh) {
      const cube = cubeFor(mesh);
      arm.root.updateMatrixWorld(true);
      cube.grip = palm.matrixWorld.clone().invert().multiply(mesh.matrixWorld.clone());
      cube.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    },
    release(mesh) {
      const cube = cubeFor(mesh);
      cube.grip = null;
      cube.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      cube.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      cube.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    },
    // Puts a cube at a pose (from its mesh) at rest, as if dropped there.
    place(mesh) {
      const cube = cubeFor(mesh);
      cube.grip = null;
      cube.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      cube.body.setTranslation(mesh.position, true);
      cube.body.setRotation(mesh.quaternion, true);
      cube.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      cube.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    },
    // For debugging: names of the arm parts touching a cube right now.
    partsTouching(mesh) {
      const cube = cubeFor(mesh);
      return links.filter(({ collider }) => {
        let touching = false;
        world.contactPair(collider, cube.collider, (manifold) => {
          for (let i = 0; i < manifold.numContacts(); i += 1) if (manifold.contactDist(i) <= TOUCH_DISTANCE) touching = true;
        });
        return touching;
      }).map(({ group }) => group.name);
    },
    isAtRest() {
      return cubes.every(({ body, grip }) => {
        if (grip || body.isSleeping()) return true;
        const v = body.linvel();
        const w = body.angvel();
        return Math.hypot(v.x, v.y, v.z) < REST_SPEED && Math.hypot(w.x, w.y, w.z) < REST_SPEED * 20;
      });
    },
  };
}

function hullPoints(meshes) {
  const points = [];
  const vertex = new THREE.Vector3();
  for (const mesh of meshes) {
    mesh.updateMatrix();
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i += 1) {
      vertex.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrix); // into the part's frame
      points.push(vertex.x, vertex.y, vertex.z);
    }
  }
  const count = points.length / 3;
  if (count <= MAX_HULL_POINTS) return new Float32Array(points);
  const stride = Math.ceil(count / MAX_HULL_POINTS); // thin evenly; the hull barely changes
  const thinned = [];
  for (let i = 0; i < count; i += stride) thinned.push(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
  return new Float32Array(thinned);
}
