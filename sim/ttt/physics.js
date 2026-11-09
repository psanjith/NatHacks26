import * as THREE from "three";
import RAPIER from "../vendor/rapier/rapier.mjs";
import { GRID, GRID_SIZE, MOUNT_SIZE, TABLE, TABLE_Z } from "./layout.js";
import { pieceBoxes } from "./pieces.js";

// Rapier physics for the X and O pieces, with the arm as moving obstacles (as in the cube sim).
// A piece counts as held once two fingers touch it; it then moves with the claw until the claw opens.
// The opponent's hand isn't a physical body: a piece he holds simply follows his hand.

const STEP = 1 / 120;
const DENSITY = 1250; // kg/m³, printed PLA: an X weighs about 6 g
const FRICTION = 0.75;
const RESTITUTION = 0.05;
const MAX_HULL_POINTS = 20000;
const PEDESTAL = { radius: 0.061, height: 0.056 }; // the arm's round base on its mount
const TOUCH_DISTANCE = 0.001;
const REST_SPEED = 0.008;

export async function createPhysics({ arm, pieces }) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
  world.timestep = STEP;
  world.lengthUnit = 0.05;

  const scenery = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const box = (hx, hy, hz, x, y, z) =>
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(FRICTION), scenery);
  box((TABLE.maxX - TABLE.minX) / 2, TABLE.halfY, TABLE.thickness / 2, (TABLE.maxX + TABLE.minX) / 2, 0, TABLE_Z - TABLE.thickness / 2);
  box(MOUNT_SIZE / 2, MOUNT_SIZE / 2, -TABLE_Z / 2, 0, 0, TABLE_Z / 2);
  box(GRID_SIZE / 2, GRID_SIZE / 2, GRID.thickness / 2, GRID.x, GRID.y, TABLE_Z + GRID.thickness / 2);
  const upright = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(PEDESTAL.height / 2, PEDESTAL.radius).setTranslation(0, 0, PEDESTAL.height / 2).setRotation(upright),
    scenery,
  );

  // The arm: one convex shape per moving part.
  arm.root.updateMatrixWorld(true);
  const links = [];
  const fingerColliders = new Map();
  arm.root.traverse((group) => {
    if (!group.isGroup || group === arm.root) return;
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

  const turn = new THREE.Quaternion();
  const Z = new THREE.Vector3(0, 0, 1);
  const bodies = pieces.map((mesh) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
        .setRotation(mesh.quaternion).setCcdEnabled(true).setAngularDamping(0.4),
    );
    const colliders = pieceBoxes(mesh.userData.kind).map(({ half, at, angle }) => {
      turn.setFromAxisAngle(Z, angle);
      return world.createCollider(
        RAPIER.ColliderDesc.cuboid(...half).setTranslation(...at).setRotation(turn)
          .setDensity(DENSITY).setFriction(FRICTION).setRestitution(RESTITUTION),
        body,
      );
    });
    return { mesh, body, colliders, grip: null, free: null };
  });
  const entryFor = (mesh) => bodies.find((b) => b.mesh === mesh);

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
    for (const entry of bodies) {
      if (entry.grip) {
        held.multiplyMatrices(palm.matrixWorld, entry.grip).decompose(position, rotation, scale);
        entry.body.setNextKinematicTranslation(position);
        entry.body.setNextKinematicRotation(rotation);
      } else if (entry.free) {
        entry.body.setNextKinematicTranslation(entry.free.position);
        entry.body.setNextKinematicRotation(entry.free.quaternion);
      }
    }
  }

  function updateMeshes() {
    let moved = false;
    for (const { mesh, body, grip, free } of bodies) {
      if (body.isSleeping() && !grip && !free) continue;
      const t = body.translation();
      const r = body.rotation();
      mesh.position.set(t.x, t.y, t.z);
      mesh.quaternion.set(r.x, r.y, r.z, r.w);
      moved = true;
    }
    return moved;
  }

  let pending = 0;
  function advance(seconds) {
    pending += Math.min(seconds, 0.1);
    if (pending < STEP) return false;
    followArm();
    while (pending >= STEP) {
      world.step();
      pending -= STEP;
    }
    return updateMeshes();
  }

  function touching(entry, colliders) {
    let touch = false;
    for (const collider of colliders) {
      for (const own of entry.colliders) {
        world.contactPair(collider, own, (manifold) => {
          for (let i = 0; i < manifold.numContacts(); i += 1) if (manifold.contactDist(i) <= TOUCH_DISTANCE) touch = true;
        });
      }
    }
    return touch;
  }

  const makeKinematic = (entry) => entry.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  function makeDynamic(entry) {
    entry.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  return {
    advance,
    // The piece (mesh) two or more fingers are touching, if any.
    pieceBetweenFingers() {
      for (const entry of bodies) {
        if (entry.grip || entry.free) continue;
        let count = 0;
        for (const colliders of fingerColliders.values()) if (touching(entry, colliders)) count += 1;
        if (count >= 2) return entry.mesh;
      }
      return null;
    },
    // The claw holds it: it moves with the palm from now on.
    hold(mesh) {
      const entry = entryFor(mesh);
      arm.root.updateMatrixWorld(true);
      mesh.updateMatrixWorld(true);
      entry.grip = palm.matrixWorld.clone().invert().multiply(mesh.matrixWorld.clone());
      makeKinematic(entry);
    },
    // Someone else holds it (the opponent): it goes wherever follow() puts it.
    holdFree(mesh) {
      const entry = entryFor(mesh);
      entry.free = { position: mesh.position.clone(), quaternion: mesh.quaternion.clone() };
      makeKinematic(entry);
    },
    follow(mesh, worldPosition, quaternion = null) {
      const entry = entryFor(mesh);
      if (!entry.free) return;
      entry.free.position.copy(worldPosition);
      if (quaternion) entry.free.quaternion.copy(quaternion);
    },
    release(mesh) {
      const entry = entryFor(mesh);
      entry.grip = null;
      entry.free = null;
      makeDynamic(entry);
    },
    // Puts a piece at its mesh's pose, at rest (for resetting the game).
    place(mesh) {
      const entry = entryFor(mesh);
      entry.grip = null;
      entry.free = null;
      makeDynamic(entry);
      entry.body.setTranslation(mesh.position, true);
      entry.body.setRotation(mesh.quaternion, true);
    },
    isHeld: (mesh) => Boolean(entryFor(mesh)?.grip || entryFor(mesh)?.free),
    partsTouching(mesh) {
      const entry = entryFor(mesh);
      return links.filter(({ collider }) => touching(entry, [collider])).map(({ group }) => group.name);
    },
    isAtRest() {
      return bodies.every(({ body, grip, free }) => {
        if (grip || free || body.isSleeping()) return true;
        const v = body.linvel();
        const w = body.angvel();
        return Math.hypot(v.x, v.y, v.z) < REST_SPEED && Math.hypot(w.x, w.y, w.z) < REST_SPEED * 25;
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
      vertex.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrix);
      points.push(vertex.x, vertex.y, vertex.z);
    }
  }
  const count = points.length / 3;
  if (count <= MAX_HULL_POINTS) return new Float32Array(points);
  const stride = Math.ceil(count / MAX_HULL_POINTS);
  const thinned = [];
  for (let i = 0; i < count; i += stride) thinned.push(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
  return new Float32Array(thinned);
}
