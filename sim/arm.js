import * as THREE from "three";

// The team's arm (finalll2222(1).STEP, packed by tools/export_arm.py): yaw, shoulder, elbow and
// wrist roll, then a parallel claw (two gear-driven four-bar linkages). Claw 0 is open and 1 is
// closed; every claw joint follows the linkage table in arm.json, interpolated.

function surfaceFor(rgba) {
  const [r, g, b] = rgba;
  const isMetalFastener = Math.abs(r - 0.56) < 0.01 && Math.abs(b - 0.64) < 0.01;
  const isBrass = r > 0.6 && b < 0.3;
  if (isMetalFastener) return { metalness: 0.75, roughness: 0.38 };
  if (isBrass) return { metalness: 0.6, roughness: 0.42 };
  return { metalness: 0, roughness: 0.58 };
}

async function fetchWithProgress(url, totalBytes, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(totalBytes);
  const reader = response.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes.set(value, received);
    received += value.length;
    onProgress(received / totalBytes);
  }
  if (received !== totalBytes) throw new Error(`${url}: got ${received} of ${totalBytes} bytes`);
  return bytes.buffer;
}

function buildGeometries(meshes, buffer) {
  const geometries = new Map();
  for (const [name, info] of Object.entries(meshes)) {
    const geometry = new THREE.BufferGeometry();
    const IndexArray = info.indexBytes === 2 ? Uint16Array : Uint32Array;
    geometry.setAttribute("position", new THREE.BufferAttribute(
      new Float32Array(buffer, info.position, info.vertices * 3), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(
      new Int16Array(buffer, info.normal, info.vertices * 3), 3, true));
    geometry.setIndex(new THREE.BufferAttribute(new IndexArray(buffer, info.index, info.indices), 1));
    geometries.set(name, geometry);
  }
  return geometries;
}

export async function loadArm(onProgress = () => {}) {
  const response = await fetch("arm/arm.json");
  if (!response.ok) throw new Error(`arm/arm.json: HTTP ${response.status}`);
  const model = await response.json();
  const buffer = await fetchWithProgress("arm/arm.bin", model.binBytes, onProgress);
  const geometries = buildGeometries(model.meshes, buffer);

  const materials = new Map();
  const materialFor = (rgba) => {
    const key = rgba.join(",");
    if (!materials.has(key)) {
      const color = new THREE.Color().setRGB(rgba[0], rgba[1], rgba[2], THREE.SRGBColorSpace);
      materials.set(key, new THREE.MeshStandardMaterial({ color, ...surfaceFor(rgba) }));
    }
    return materials.get(key);
  };

  const joints = new Map();

  function buildBody(body) {
    const group = new THREE.Group();
    group.name = body.name;
    group.position.fromArray(body.pos);
    if (body.joint) {
      joints.set(body.joint.name, {
        group,
        axis: new THREE.Vector3().fromArray(body.joint.axis).normalize(),
        range: body.joint.range,
        value: 0,
      });
    }
    for (const geom of body.geoms) {
      const part = new THREE.Mesh(geometries.get(geom.mesh), materialFor(geom.rgba));
      part.position.fromArray(geom.pos);
      part.quaternion.fromArray(geom.quat);
      part.castShadow = true;
      part.receiveShadow = true;
      group.add(part);
    }
    body.children.forEach((child) => group.add(buildBody(child)));
    return group;
  }

  const root = buildBody(model.root);
  root.name = "arm";

  function setJoint(name, radians) {
    const joint = joints.get(name);
    if (!joint) throw new Error(`Unknown joint: ${name}`);
    joint.value = THREE.MathUtils.clamp(radians, joint.range[0], joint.range[1]);
    joint.group.quaternion.setFromAxisAngle(joint.axis, joint.value);
    return joint.value;
  }

  let claw = 0;
  function setClaw(amount) {
    claw = THREE.MathUtils.clamp(amount, 0, 1);
    const x = claw * (model.claw.samples - 1);
    const i = Math.min(Math.floor(x), model.claw.samples - 2);
    const f = x - i;
    for (const [name, table] of Object.entries(model.claw.joints)) setJoint(name, table[i] * (1 - f) + table[i + 1] * f);
  }
  setClaw(0);

  return { root, joints, setJoint, setClaw, get claw() { return claw; } };
}
