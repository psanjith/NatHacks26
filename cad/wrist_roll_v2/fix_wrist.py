"""Fixes the fit problems in the team's rotating-wrist arm (finalll2222(1).STEP).

1. The SG90 servo overlapped the forearm (04) by 295 mm3: the forearm gets a pocket
   cut to the servo's shape plus clearance, with the servo left where it was placed.
2. The gripper base (05) overlapped the wrist roll part (10) by ~50 mm3: the wrist
   roll part (the new part) is trimmed so the two sit flush.
3. The wrist roll part touched the forearm with zero gap, so it would rub when it
   rotates: a running gap is cut into the wrist roll part.

Run:  python fix_wrist.py "../../finalll2222(1).STEP"
Writes fixed STEP/STL files next to this script; the input file is not changed.
"""
import sys
from pathlib import Path

import numpy as np
import cadquery as cq
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label, TDF_LabelSequence
from OCP.TDocStd import TDocStd_Document
from OCP.XCAFDoc import XCAFDoc_DocumentTool

STEP_IN = Path(sys.argv[1])
OUT = Path(__file__).resolve().parent
SERVO_CLEARANCE = 0.3   # mm around the servo in its pocket
RUNNING_GAP = 0.5       # mm target; at least ~0.3 mm everywhere after the cuts


def load(path):
    """Every part in global coordinates (mm), keyed by product name, with its parent."""
    doc = TDocStd_Document(TCollection_ExtendedString("doc"))
    reader = STEPCAFControl_Reader(); reader.SetNameMode(True)
    reader.ReadFile(str(path)); reader.Transfer(doc)
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

    def name_of(label):
        attr = TDataStd_Name()
        return attr.Get().ToExtString() if label.FindAttribute(TDataStd_Name.GetID_s(), attr) else ""

    inst = {}
    def scan(label):
        comps = TDF_LabelSequence(); tool.GetComponents_s(label, comps)
        for i in range(1, comps.Length() + 1):
            c = comps.Value(i); ref = TDF_Label(); tool.GetReferredShape_s(c, ref)
            inst[name_of(c)] = name_of(ref); scan(ref)
    roots = TDF_LabelSequence(); tool.GetFreeShapes(roots)
    for i in range(1, roots.Length() + 1): scan(roots.Value(i))

    parts = {}
    def walk(a, loc, parent):
        for ch in a.children:
            L = loc * ch.loc
            if ch.obj is not None:
                s = ch.obj.val() if isinstance(ch.obj, cq.Workplane) else ch.obj
                nm = inst.get(ch.name, ch.name).replace("默认", "").strip("_ ")
                key, n = nm, 2
                while key in parts: key, n = f"{nm} #{n}", n + 1
                parts[key] = dict(shape=s.moved(L), parent=parent)
            walk(ch, L, inst.get(ch.name, ch.name).replace("默认", "").strip("_ "))
    walk(cq.Assembly.importStep(str(path)), cq.Location(), "top")
    return parts


def dist(a, b):
    d = BRepExtrema_DistShapeShape(a.wrapped, b.wrapped); d.Perform(); return d.Value()


def overlap(a, b):
    try: return a.intersect(b).Volume()
    except Exception: return float("nan")


def grown(shape, margin):
    """The shape scaled about its centre so it is about `margin` larger on each side."""
    bb = shape.BoundingBox()
    smallest = min(bb.xlen, bb.ylen, bb.zlen)
    k = 1 + 2 * margin / smallest
    c = shape.Center()
    return shape.translate(-c).scale(k).translate(c)


parts = load(STEP_IN)
key = lambda prefix: next(k for k in parts if k.startswith(prefix))
servo_k = next(k for k in parts if "servo" in k.lower())
fore_k, roll_k, gbase_k = key("04_"), key("10_"), key("05_")
servo, fore, roll, gbase = (parts[k]["shape"] for k in (servo_k, fore_k, roll_k, gbase_k))

# Servo shaft axis: the r = 2.5 mm spline cylinder.
c = next(f._geomAdaptor().Cylinder() for f in servo.Faces()
         if f.geomType() == "CYLINDER" and abs(f._geomAdaptor().Cylinder().Radius() - 2.5) < 0.05)
o, d = c.Axis().Location(), c.Axis().Direction()
p0, axis = np.array([o.X(), o.Y(), o.Z()]), np.array([d.X(), d.Y(), d.Z()])
# Point the axis from the forearm towards the claw.
if (np.array(roll.Center().toTuple()) - np.array(fore.Center().toTuple())) @ axis < 0: axis = -axis

report = [f"input: {STEP_IN.name}"]
report.append(f"before: servo/forearm overlap {overlap(servo, fore):.0f} mm3, gripper base/wrist roll overlap "
              f"{overlap(gbase, roll):.0f} mm3, wrist roll/forearm gap {dist(roll, fore):.2f} mm")

# 1. Servo pocket in the forearm.
fore_fixed = fore.cut(grown(servo, SERVO_CLEARANCE)).clean()

# 2. Wrist roll part trimmed where the gripper base sits.
roll_fixed = roll.cut(gbase).clean()

# 3. Running gap: the wrist roll part touches the forearm with zero clearance at its
#    thrust face, its centre pin and its hub. Remove the layer of it that lies within
#    RUNNING_GAP of the forearm, by cutting with copies of the forearm shifted that far
#    along the axis and in eight directions across it (an offset, built from shifts).
u = np.cross(axis, [1, 0, 0] if abs(axis[0]) < 0.9 else [0, 1, 0]); u /= np.linalg.norm(u)
w = np.cross(axis, u)
across = [np.cos(t) * u + np.sin(t) * w for t in np.radians(np.arange(0, 360, 45))]
shifts = [axis] + across + [(axis + c) / np.sqrt(2) for c in across]   # diagonals clear the corners
for s in shifts:
    roll_fixed = roll_fixed.cut(fore_fixed.translate(cq.Vector(*(s * RUNNING_GAP))))
roll_fixed = roll_fixed.clean()

report.append(f"after:  servo/forearm overlap {overlap(servo, fore_fixed):.1f} mm3, gripper base/wrist roll overlap "
              f"{overlap(gbase, roll_fixed):.1f} mm3, wrist roll/forearm gap {dist(roll_fixed, fore_fixed):.2f} mm, "
              f"servo/forearm gap {dist(servo, fore_fixed):.2f} mm")
report.append(f"forearm: {len(fore_fixed.Solids())} solid(s), {fore.Volume() - fore_fixed.Volume():.0f} mm3 removed")
report.append(f"wrist roll part: {len(roll_fixed.Solids())} solid(s), {roll.Volume() - roll_fixed.Volume():.0f} mm3 removed")
report.append(f"wrist roll part still reaches the servo: gap {dist(roll_fixed, servo):.2f} mm")

# Full interference check on the fixed assembly.
fixed = {k: v["shape"] for k, v in parts.items()}
fixed[fore_k], fixed[roll_k] = fore_fixed, roll_fixed
names = list(fixed)
clashes = []
for i, a in enumerate(names):
    for b in names[i + 1:]:
        v = overlap(fixed[a], fixed[b]) if dist(fixed[a], fixed[b]) < 0.05 else 0
        if v > 1: clashes.append(f"{a} + {b}: {v:.0f} mm3")
report.append("interferences left: " + ("; ".join(clashes) if clashes else "none"))

# Roll sweep with the fixed parts.
claw_keys = [k for k, v in parts.items() if v["parent"] == "Assem9"]
moving = [fixed[roll_k]] + [fixed[k] for k in claw_keys]
static = {k: s for k, s in fixed.items() if k != roll_k and k not in claw_keys}
start, end = cq.Vector(*p0), cq.Vector(*(p0 + axis))
for deg in range(-90, 91, 15):
    rot = [s.rotate(start, end, deg) for s in moving]
    hits = [f"{k[:24]} {sum(overlap(r, s) for r in rot):.0f} mm3" for k, s in static.items()
            if sum(overlap(r, s) for r in rot) > 1]
    report.append(f"roll {deg:+4d} deg: " + ("; ".join(hits) if hits else "clear"))

# Claw centre line from the two drive gears (mirror images about it).
gears = [np.array(fixed[k].Center().toTuple()) for k in claw_keys if "gear" in k]
mid = np.mean(gears, axis=0)
off = (mid - p0) - ((mid - p0) @ axis) * axis
report.append(f"claw centre line (between the drive gears) is {np.linalg.norm(off):.1f} mm off the servo axis")

print("\n".join(report))
(OUT / "checks.txt").write_text("\n".join(report) + "\n")

# Export: the two changed parts, and the whole arm with them swapped in.
for k, s, stem in ((fore_k, fore_fixed, "04_forearm_rotating_wrist_fixed"), (roll_k, roll_fixed, "10_wrist_roll_fixed")):
    cq.exporters.export(s, str(OUT / f"{stem}.step"))
    cq.exporters.export(s, str(OUT / f"{stem}.stl"), tolerance=0.02, angularTolerance=0.1)
full = cq.Assembly(name="finalll2222_fixed")
gripper = cq.Assembly(name="Assem9")
for k, s in fixed.items():
    (gripper if k in claw_keys else full).add(s, name=k.replace(" ", "_").replace("#", "n"))
full.add(gripper, name="Assem9")
full.save(str(OUT / "finalll2222_fixed.step"))
print("wrote", ", ".join(sorted(p.name for p in OUT.iterdir() if p.suffix in (".step", ".stl"))))
