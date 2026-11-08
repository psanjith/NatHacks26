#!/usr/bin/env python3
"""Pack the team's arm (finalll2222(1).STEP) for the browser sim.

Writes sim/arm/arm.json (body tree, joints, claw linkage table, mesh table) and sim/arm/arm.bin
(positions, normals, indices). Needs cadquery (pip install cadquery):

    python tools/export_arm.py

The STEP is a SolidWorks assembly with no joints, so they're found from the geometry: each joint
axis is a pin/hole cylinder shared by the two parts it connects (yaw: base + shoulder; shoulder:
shoulder + upper arm; elbow: upper arm + forearm; wrist roll: the SG90's spline). The claw is two
parallel four-bar linkages (drive gear, finger, link on each side); its pose is tabulated here for
claw 0 (open) .. 1 (closed) and arm.js interpolates.

The CAD file's pose isn't a usable home pose (upper arm pointing down, forearm folded up), so the
parts are first moved to: upper arm straight up, forearm and claw pointing forward, fingers closing
sideways. Joint angle 0 = that pose; each servo gets +-90 degrees from it. Axes in the arm frame:
x forward, y left, z up, metres, origin under the yaw axis at the bottom of the base.
Positive shoulder/elbow angles tip the arm forward/down; positive yaw turns it left.
"""
import json
import sys
from pathlib import Path

import numpy as np
import cadquery as cq
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label, TDF_LabelSequence
from OCP.TDocStd import TDocStd_Document
from OCP.XCAFDoc import XCAFDoc_DocumentTool

ROOT = Path(__file__).resolve().parent.parent
STEP = ROOT / "finalll2222(1).STEP"
OUT_DIR = ROOT / "sim" / "arm"
CREASE_DEG = 35.0         # faces meeting at a sharper angle keep a hard edge
TESSELLATE = (0.08, 0.25)  # mm, radians
SERVO = np.radians(90)     # each joint: +-90 degrees from home
CLAW_OPEN, CLAW_CLOSED = 50.0, -36.0   # drive gear angle (degrees from the CAD pose) for claw 0 and 1
CLAW_SAMPLES = 44

COLOURS = {  # rgba
    "01": [0.16, 0.17, 0.19, 1], "02": [0.90, 0.91, 0.93, 1], "03": [0.90, 0.91, 0.93, 1],
    "04": [0.90, 0.91, 0.93, 1], "10": [0.95, 0.55, 0.20, 1], "05": [0.90, 0.91, 0.93, 1],
    "06": [0.95, 0.55, 0.20, 1], "08": [0.30, 0.32, 0.36, 1], "09": [0.95, 0.55, 0.20, 1],
    "servo": [0.15, 0.35, 0.80, 1],
}


# ---------------------------------------------------------------- STEP
def load(path):
    """Every part in CAD coordinates (mm), keyed by product name (repeats get ' #2')."""
    doc = TDocStd_Document(TCollection_ExtendedString("doc"))
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.ReadFile(str(path))
    reader.Transfer(doc)
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

    def name_of(label):
        attr = TDataStd_Name()
        return attr.Get().ToExtString() if label.FindAttribute(TDataStd_Name.GetID_s(), attr) else ""

    inst = {}

    def scan(label):
        comps = TDF_LabelSequence()
        tool.GetComponents_s(label, comps)
        for i in range(1, comps.Length() + 1):
            c = comps.Value(i)
            ref = TDF_Label()
            tool.GetReferredShape_s(c, ref)
            inst[name_of(c)] = name_of(ref)
            scan(ref)

    roots = TDF_LabelSequence()
    tool.GetFreeShapes(roots)
    for i in range(1, roots.Length() + 1):
        scan(roots.Value(i))
    parts = {}

    def walk(a, loc):
        for ch in a.children:
            L = loc * ch.loc
            if ch.obj is not None:
                s = ch.obj.val() if isinstance(ch.obj, cq.Workplane) else ch.obj
                nm = inst.get(ch.name, ch.name).replace("默认", "").strip("_ ")
                key, n = nm, 2
                while key in parts:
                    key, n = f"{nm} #{n}", n + 1
                parts[key] = s.moved(L)
            walk(ch, L)

    walk(cq.Assembly.importStep(str(path)), cq.Location())
    return parts


def cylinders(shape):
    out = []
    for f in shape.Faces():
        if f.geomType() == "CYLINDER":
            c = f._geomAdaptor().Cylinder()
            o, d = c.Axis().Location(), c.Axis().Direction()
            out.append((c.Radius(), np.array([o.X(), o.Y(), o.Z()]), np.array([d.X(), d.Y(), d.Z()])))
    return out


def shared_axis(a, b):
    """An axis line (point, unit direction) that cylinders of both parts lie on."""
    for _, pa, da in cylinders(a):
        for _, pb, db in cylinders(b):
            if abs(da @ db) > 0.999 and np.linalg.norm(np.cross(pb - pa, da)) < 0.3:
                return pa, da / np.linalg.norm(da)
    raise ValueError("no shared axis")


# ---------------------------------------------------------------- geometry helpers
def rot(axis, angle):
    axis = axis / np.linalg.norm(axis)
    k = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(angle) * k + (1 - np.cos(angle)) * k @ k


class Pose:
    """A rigid transform x -> R x + t."""
    def __init__(self, R=np.eye(3), t=np.zeros(3)):
        self.R, self.t = R, t

    def __call__(self, x):
        return x @ self.R.T + self.t

    def dir(self, d):
        return self.R @ d

    def then(self, other):
        return Pose(other.R @ self.R, other.R @ self.t + other.t)


def about(point, axis, angle):
    R = rot(axis, angle)
    return Pose(R, point - R @ point)


def signed_angle(a, b, axis):
    return np.arctan2(np.cross(a, b) @ axis, a @ b)


def creased_mesh(verts, faces):
    """(positions, normals, indices) with smooth normals below the crease angle."""
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
    key = np.column_stack([corner_vertex, packed.astype(np.int64)])
    unique, inverse = np.unique(key, axis=0, return_inverse=True)
    return verts[unique[:, 0]].astype(np.float32), unique[:, 1:].astype(np.int16), inverse.reshape(-1)


# ---------------------------------------------------------------- claw four-bar
def claw_table(A, B, C, D, n, gear_sign):
    """Each side: gear turns about A (by gear_sign * theta), finger pinned to it at B, link from C
    (on the claw base) to the finger at D. Returns rows of (theta, gear, finger rel. to gear, link)."""
    rows = []
    prev = D

    def circles(c0, r0, c1, r1, near):
        e = c1 - c0
        d = np.linalg.norm(e)
        a = (r0 ** 2 - r1 ** 2 + d ** 2) / (2 * d)
        h = np.sqrt(max(r0 ** 2 - a ** 2, 0))
        m = c0 + a * e / d
        perp = np.cross(n, e / d)
        return min((m + h * perp, m - h * perp), key=lambda s: np.linalg.norm(s - near))

    for amount in np.linspace(0, 1, CLAW_SAMPLES):
        theta = np.radians(CLAW_OPEN + (CLAW_CLOSED - CLAW_OPEN) * amount) * gear_sign
        Bn = A + rot(n, theta) @ (B - A)
        Dn = circles(C, np.linalg.norm(D - C), Bn, np.linalg.norm(D - B), prev)
        prev = Dn
        finger = signed_angle(D - B, Dn - Bn, n)
        link = signed_angle(D - C, Dn - C, n)
        rows.append((theta, finger - theta, link))
    return np.array(rows)


def main():
    step = Path(sys.argv[1]) if len(sys.argv) > 1 else STEP
    parts = load(step)
    key = lambda prefix: next(k for k in parts if k.startswith(prefix))
    base, shoulder, upper, fore = (parts[key(p)] for p in ("01_", "02_", "03_", "04_"))
    roll_part, claw_base = parts[key("10_")], parts[key("05_")]
    servo = parts[next(k for k in parts if "servo" in k.lower())]

    # CAD (mm, y down... the base's height runs along -y) -> arm frame (m): x fwd, y left, z up.
    M = np.array([[0, 0, 1], [-1, 0, 0], [0, -1, 0]], float)
    p_yaw, d_yaw = shared_axis(base, shoulder)
    bb = base.BoundingBox()
    origin_cad = p_yaw + d_yaw * ((bb.ymax - p_yaw[1]) / d_yaw[1])        # yaw axis at the base's bottom face
    to_arm = Pose(M * 0.001, -(M * 0.001) @ origin_cad)
    # turn about z so the shoulder axis is +y: yaw 0 then points the arm along +x
    p_sh, d_sh = shared_axis(shoulder, upper)
    d = to_arm.dir(d_sh)
    d = d if d[1] > 0 else -d
    to_arm = to_arm.then(about(np.zeros(3), np.array([0, 0, 1.0]), -np.arctan2(-d[0], d[1])))

    def axis_line(a, b, toward=None):
        p, dv = shared_axis(a, b)
        p, dv = to_arm(p), to_arm.dir(dv)
        if toward is not None and dv @ toward < 0:
            dv = -dv
        return p, dv

    S, _ = axis_line(shoulder, upper)
    E, _ = axis_line(upper, fore)
    sp = next(c for c in cylinders(servo) if abs(c[0] - 2.5) < 0.05)   # SG90 spline: the roll axis
    Rp, Rd = to_arm(sp[1]), to_arm.dir(sp[2])
    claw_mid = to_arm(np.array(claw_base.Center().toTuple()))
    if (claw_mid - Rp) @ Rd < 0:
        Rd = -Rd
    Rp = Rp + Rd * ((claw_mid - Rp) @ Rd - 0.035)                       # a point on the roll axis inside the wrist
    y = np.array([0, 1.0, 0])

    # Claw pivots (arm frame), all parallel to the gear axis n.
    gears = sorted((k for k in parts if k.startswith("06_")))
    fingers = sorted((k for k in parts if k.startswith("09_")))
    links = sorted((k for k in parts if k.startswith("08_")))
    sides = []
    for g in gears:
        A, n = axis_line(claw_base, parts[g])
        f = next(f for f in fingers if _shares(parts[g], parts[f]))
        l = next(l for l in links if _shares(parts[f], parts[l]))
        B, _ = axis_line(parts[g], parts[f])
        C, _ = axis_line(claw_base, parts[l])
        Dp, _ = axis_line(parts[f], parts[l])
        # same plane: move each pivot along n to the plane through A
        B, C, Dp = (q - n * ((q - A) @ n) for q in (B, C, Dp))
        sides.append(dict(gear=g, finger=f, link=l, A=A, B=B, C=C, D=Dp, n=n))
    n = sides[0]["n"]
    for s in sides[1:]:
        if s["n"] @ n < 0:
            s["n"] = -s["n"]

    # ---- home pose: upper arm up, forearm/claw forward, fingers closing sideways
    up_dir = E - S
    th_s = signed_angle(np.array([up_dir[0], 0, up_dir[2]]), np.array([0, 0, 1.0]), y)
    P_upper = about(S, y, th_s)
    E_h = P_upper(E)
    Rd_1 = P_upper.dir(Rd)
    th_e = signed_angle(np.array([Rd_1[0], 0, Rd_1[2]]), np.array([1.0, 0, 0]), y)
    P_fore = P_upper.then(about(E_h, y, th_e))
    Rp_h, Rd_h = P_fore(Rp), P_fore.dir(Rd)
    c = P_fore.dir(sides[1]["B"] - sides[0]["B"])                        # across the claw, finger to finger
    c_perp = c - (c @ Rd_h) * Rd_h
    target = np.cross(np.array([0, 0, 1.0]), Rd_h)                       # horizontal, across the claw axis
    th_r = signed_angle(c_perp, target, Rd_h)
    P_wrist = P_fore.then(about(Rp_h, Rd_h, th_r))

    poses = {"base": Pose(), "turntable": Pose(), "upper_arm": P_upper, "forearm": P_fore, "wrist_palm": P_wrist}
    owner = {key("01_"): "base", key("02_"): "turntable", key("03_"): "upper_arm", key("04_"): "forearm",
             next(k for k in parts if "servo" in k.lower()): "forearm", key("10_"): "wrist_palm", key("05_"): "wrist_palm"}
    for i, s in enumerate(sides, 1):
        owner[s["gear"]], owner[s["finger"]], owner[s["link"]] = f"claw_gear_{i}", f"finger_{i}_tip", f"claw_link_{i}"
        for b in (f"claw_gear_{i}", f"finger_{i}_tip", f"claw_link_{i}"):
            poses[b] = P_wrist

    # body origins (home pose, arm frame) and joint axes
    n_h = P_wrist.dir(n)
    bodies = {
        "base": dict(parent=None, origin=np.zeros(3)),
        "turntable": dict(parent="base", origin=np.array([0, 0, bb.ylen * 0.001]),
                          joint=("yaw_joint", [0, 0, 1], [-SERVO, SERVO])),
        "upper_arm": dict(parent="turntable", origin=S, joint=("shoulder_joint", y, [-SERVO, SERVO])),
        "forearm": dict(parent="upper_arm", origin=E_h, joint=("elbow_joint", y, [-SERVO, SERVO])),
        "wrist_palm": dict(parent="forearm", origin=Rp_h, joint=("roll_joint", Rd_h, [-SERVO, SERVO])),
    }
    def build_claw(first_sign):
        out, tabs = {}, {}
        for i, s in enumerate(sides, 1):
            A, B, C, Dp = (P_wrist(q) for q in (s["A"], s["B"], s["C"], s["D"]))
            tab = claw_table(A, B, C, Dp, n_h, first_sign if i == 1 else -first_sign)   # the gears mesh: opposite turns
            out[f"claw_gear_{i}"] = dict(parent="wrist_palm", origin=A, joint=(f"claw_gear_{i}_joint", n_h, None))
            out[f"finger_{i}_tip"] = dict(parent=f"claw_gear_{i}", origin=B, joint=(f"finger_{i}_joint", n_h, None))
            out[f"claw_link_{i}"] = dict(parent="wrist_palm", origin=C, joint=(f"claw_link_{i}_joint", n_h, None))
            for j, name in enumerate((f"claw_gear_{i}_joint", f"finger_{i}_joint", f"claw_link_{i}_joint")):
                tabs[name] = tab[:, j].round(5).tolist()
        # finger-pin gap at claw 0 and claw 1 (the fingers stay parallel, so this tracks the opening)
        gap = []
        for k in (0, CLAW_SAMPLES - 1):
            pins = [out[f"claw_gear_{i}"]["origin"] + rot(n_h, tabs[f"claw_gear_{i}_joint"][k]) @
                    (out[f"finger_{i}_tip"]["origin"] - out[f"claw_gear_{i}"]["origin"]) for i in (1, 2)]
            gap.append(np.linalg.norm(pins[0] - pins[1]))
        return out, tabs, gap

    claw_bodies, tables, gap = build_claw(1)
    if gap[0] < gap[1]:          # that way closes: the gears turn the other way to open
        claw_bodies, tables, gap = build_claw(-1)
    bodies.update(claw_bodies)

    # ---- meshes
    blob = bytearray()
    meshes, geoms = {}, {b: [] for b in bodies}
    triangles = 0

    def append(array):
        while len(blob) % 4:
            blob.append(0)
        offset = len(blob)
        blob.extend(array.tobytes())
        return offset

    for name, shape in parts.items():
        body = owner[name]
        v, f = shape.tessellate(*TESSELLATE)
        verts = poses[body](to_arm(np.array([p.toTuple() for p in v]))) - bodies[body]["origin"]
        positions, normals, indices = creased_mesh(verts, np.array(f, np.int64))
        index_type = np.uint16 if len(positions) < 65536 else np.uint32
        mesh = name.replace(" #", "_").replace(" ", "_")
        meshes[mesh] = {"vertices": len(positions), "indices": len(indices), "indexBytes": np.dtype(index_type).itemsize,
                        "position": append(positions), "normal": append(normals), "index": append(indices.astype(index_type))}
        colour = COLOURS["servo" if "servo" in name.lower() else name[:2]]
        geoms[body].append({"mesh": mesh, "pos": [0, 0, 0], "quat": [0, 0, 0, 1], "rgba": colour})
        triangles += len(f)

    def tree(name):
        b = bodies[name]
        parent_origin = bodies[b["parent"]]["origin"] if b["parent"] else np.zeros(3)
        out = {"name": name, "pos": (b["origin"] - parent_origin).round(6).tolist(), "geoms": geoms[name], "children": []}
        if "joint" in b:
            jn, ax, rng = b["joint"]
            if rng is None:
                rng = [min(tables[jn]) - 1e-3, max(tables[jn]) + 1e-3]
            out["joint"] = {"name": jn, "axis": np.round(np.asarray(ax, float), 6).tolist(), "range": [float(r) for r in rng]}
        out["children"] = [tree(c) for c, v in bodies.items() if v["parent"] == name]
        return out

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "arm.bin").write_bytes(blob)
    (OUT_DIR / "arm.json").write_text(json.dumps({
        "source": step.name, "root": tree("base"), "meshes": meshes, "binBytes": len(blob),
        "claw": {"samples": CLAW_SAMPLES, "joints": tables},
        "keyframes": {"home": [0, 0, 0, 0]},
    }, separators=(",", ":")))
    L1 = np.linalg.norm(E_h - S)
    print(f"{len(meshes)} meshes, {triangles} triangles, {len(blob) / 1e6:.1f} MB -> {OUT_DIR}")
    print(f"shoulder {np.round(S * 1000, 1)} mm, elbow {np.round(E_h * 1000, 1)} mm (upper arm {L1 * 1000:.0f} mm), "
          f"roll axis through {np.round(Rp_h * 1000, 1)} mm; home moves: shoulder {np.degrees(th_s):.1f}, "
          f"elbow {np.degrees(th_e):.1f}, roll {np.degrees(th_r):.1f} deg; claw finger-pin gap {gap[0]*1000:.0f} -> {gap[1]*1000:.0f} mm")


def _shares(a, b):
    try:
        shared_axis(a, b)
        return True
    except ValueError:
        return False


if __name__ == "__main__":
    main()
