#!/usr/bin/env python3
"""Pack PNJEX_V6.xml and its OBJ meshes for the browser sim.

Writes sim/arm/arm.json (body tree, joints, geoms, mesh table) and
sim/arm/arm.bin (positions, normals, indices). Each unique mesh is stored once;
geoms reference it. Re-run this whenever the MJCF or the meshes change:

    python3 tools/export_arm.py
"""
import json
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MJCF = ROOT / "PNJEX_V6.xml"
MESH_DIR = ROOT / "PNJEX_MuJoCo_Physics" / "assets"
OUT_DIR = ROOT / "sim" / "arm"
CREASE_DEG = 35.0  # faces meeting at a sharper angle keep a hard edge
HIDDEN_GROUPS = {"3", "4", "5"}  # MuJoCo hides these by default (spring envelopes)


def read_obj(path):
    verts, faces = [], []
    with open(path) as f:
        for line in f:
            if line.startswith("v "):
                verts.append(line.split()[1:4])
            elif line.startswith("f "):
                faces.append([p.split("/")[0] for p in line.split()[1:4]])
    return np.array(verts, np.float64), np.array(faces, np.int64) - 1


def creased_mesh(verts, faces):
    """Return (positions, normals, indices) with smooth normals below the crease angle."""
    # Weld coincident vertices so smoothing works across duplicated seams.
    _, weld = np.unique(np.round(verts * 1e7).astype(np.int64), axis=0, return_inverse=True)
    weld = weld.reshape(-1)

    tri = verts[faces]
    area_normal = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    length = np.linalg.norm(area_normal, axis=1, keepdims=True)
    unit = np.divide(area_normal, length, out=np.zeros_like(area_normal), where=length > 0)

    corner_vertex = faces.reshape(-1)
    corner_face = np.repeat(np.arange(len(faces)), 3)
    order = np.argsort(weld[corner_vertex], kind="stable")
    group = weld[corner_vertex][order]
    face_of = corner_face[order]

    # Each corner sums the area-weighted normals of neighbours within the crease angle.
    acc = area_normal[face_of].copy()
    cos_limit = np.cos(np.radians(CREASE_DEG))
    active = np.arange(len(group))
    k = 1
    while True:
        active = active[active + k < len(group)]
        active = active[group[active] == group[active + k]]
        if active.size == 0:
            break
        a, b = active, active + k
        near = np.einsum("ij,ij->i", unit[face_of[a]], unit[face_of[b]]) > cos_limit
        acc[a[near]] += area_normal[face_of[b[near]]]
        acc[b[near]] += area_normal[face_of[a[near]]]
        k += 1

    normals = np.zeros_like(acc)
    normals[order] = acc
    length = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = np.divide(normals, length, out=np.zeros_like(normals), where=length > 0)
    packed = np.round(normals * 32767).astype(np.int16)

    # Corners sharing a vertex and a normal become one GPU vertex.
    key = np.column_stack([corner_vertex, packed.astype(np.int64)])
    unique, inverse = np.unique(key, axis=0, return_inverse=True)
    positions = verts[unique[:, 0]].astype(np.float32)
    return positions, unique[:, 1:].astype(np.int16), inverse.reshape(-1)


def floats(text):
    return [float(x) for x in text.split()]


def parse_body(element, used):
    pos = floats(element.get("pos", "0 0 0"))
    if element.get("quat") or element.get("euler"):
        raise ValueError(f"body {element.get('name')} is rotated; arm.js assumes it is not")
    body = {"name": element.get("name"), "pos": pos, "geoms": [], "children": []}

    joint = element.find("joint")
    if joint is not None:
        if floats(joint.get("pos", "0 0 0")) != [0, 0, 0]:
            raise ValueError(f"joint {joint.get('name')} is offset; arm.js assumes it is not")
        body["joint"] = {
            "name": joint.get("name"),
            "axis": floats(joint.get("axis")),
            "range": floats(joint.get("range")),
        }

    for geom in element.findall("geom"):
        if geom.get("type") != "mesh" or geom.get("group") in HIDDEN_GROUPS:
            continue
        w, x, y, z = floats(geom.get("quat", "1 0 0 0"))  # MuJoCo is w,x,y,z
        used.add(geom.get("mesh"))
        body["geoms"].append({
            "mesh": geom.get("mesh"),
            "pos": floats(geom.get("pos", "0 0 0")),
            "quat": [x, y, z, w],  # three.js is x,y,z,w
            "rgba": floats(geom.get("rgba", "0.7 0.7 0.7 1")),
        })

    body["children"] = [parse_body(child, used) for child in element.findall("body")]
    return body


def main():
    root = ET.parse(MJCF).getroot()
    files = {m.get("name"): m.get("file") for m in root.find("asset").findall("mesh")}
    used = set()
    tree = parse_body(root.find("worldbody").find("body"), used)

    blob = bytearray()
    meshes = {}
    triangles = 0

    def append(array):
        while len(blob) % 4:
            blob.append(0)
        offset = len(blob)
        blob.extend(array.tobytes())
        return offset

    for name in sorted(used):
        verts, faces = read_obj(MESH_DIR / files[name])
        positions, normals, indices = creased_mesh(verts, faces)
        index_type = np.uint16 if len(positions) < 65536 else np.uint32
        meshes[name] = {
            "vertices": len(positions),
            "indices": len(indices),
            "indexBytes": np.dtype(index_type).itemsize,
            "position": append(positions),
            "normal": append(normals),
            "index": append(indices.astype(index_type)),
        }
        triangles += len(faces)

    keyframes = {
        key.get("name"): floats(key.get("qpos")) for key in root.find("keyframe").findall("key")
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "arm.bin").write_bytes(blob)
    (OUT_DIR / "arm.json").write_text(json.dumps(
        {"root": tree, "meshes": meshes, "keyframes": keyframes, "binBytes": len(blob)},
        separators=(",", ":"),
    ))
    print(f"{len(meshes)} meshes, {triangles} triangles, {len(blob) / 1e6:.1f} MB -> {OUT_DIR}")


if __name__ == "__main__":
    main()
