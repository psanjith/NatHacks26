"""Adds a claw-rotation (wrist roll) joint to the arm in finalll111111.STEP.

Two printed parts, built from the original gripper base so they fit the existing
forearm and gripper exactly:
  wrist_mount     - the original gripper base (same tab, slot and screw holes into the
                    forearm) with a cradle for one SG90 servo, shaft along the claw.
  claw_base_roll  - the original gripper base with its tab cut off and a hub on top
                    that screws to the servo horn. Gears, links and fingers carry over.
The claw sits past the end of the forearm so it can roll +/-90 degrees.

Run:  python build_wrist_roll.py ../../finalll111111.STEP
All lengths in mm. Local frame: a = claw axis (towards the fingertips),
t = across the claw, y = along the forearm (towards its end).
"""
import sys
from pathlib import Path
import numpy as np
import cadquery as cq

STEP_IN = Path(sys.argv[1] if len(sys.argv) > 1 else "../../finalll111111.STEP")
OUT = Path(__file__).resolve().parent

# --- Servo: Miuzei SG90 (MS18), 22.4 x 12.15 x 30 mm per the seller ----------
# Heights are from the bottom of the servo. Check the tab height and hole spacing
# on a real one before printing; the screw holes are slots to allow for spread.
SERVO = dict(body_t=22.4, body_y=12.15, body_a=22.7,  # body box: length, width, height
             tower_r=5.9, tower_top=26.0,             # round gear tower around the shaft
             spline_top=30.0,                         # top of the output spline
             tab_span=32.2, tab_thick=2.5, tab_bottom=15.9,  # mounting tabs
             hole_spacing=27.8, hole_slot=1.0,        # tab screw holes, slotted +/-0.5 mm
             shaft_offset=5.3)                        # shaft from the body centre, along its length
# Horn: the 32 mm two-arm horn that comes with it, recessed into the hub.
HORN = dict(length=32.0, width=6.5, thick=1.6, centre_r=3.6)
CLEAR = 0.4         # printing clearance around the servo body
WALL = 3.0
HUB_R, HUB_H = 18.0, 5.0

# --- Layout (found by analysing the original assembly) -----------------------
CUT = -6.0          # gripper base is split here along a: tab above, mechanism below
SHIFT = 52.0        # claw moves this far along a (clears the forearm end at a = 39.5)
AXIS_T = -9.5       # roll axis across the claw (keeps the servo cradle off the forearm)
AXIS_Y = 5.3        # roll axis along the forearm (centre of the claw)
CLAW_CENTRE_T = 1.3 # current claw centre line; the claw is re-centred on the axis

def load():
    assy = cq.Assembly.importStep(str(STEP_IN))
    shapes = {}
    def walk(a, loc):
        for ch in a.children:
            L = loc * ch.loc
            if ch.obj is not None:
                s = ch.obj.val() if isinstance(ch.obj, cq.Workplane) else ch.obj
                shapes[ch.name] = s.moved(L)
            walk(ch, L)
    walk(assy, cq.Location())
    return shapes

shapes = load()
NAMES = {"NAUO1": "01_base", "NAUO2": "02_shoulder", "NAUO3": "03_upper_arm", "NAUO4": "04_forearm",
         "NAUO6": "05_gripper_base", "NAUO7": "06_drive_gear_1", "NAUO8": "06_drive_gear_2",
         "NAUO9": "09_finger_1", "NAUO12": "09_finger_2", "NAUO10": "08_link_1", "NAUO11": "08_link_2"}
CLAW_PARTS = ["NAUO7", "NAUO8", "NAUO9", "NAUO10", "NAUO11", "NAUO12"]

# Local frame from the gripper geometry.
unit = lambda v: v / np.linalg.norm(v)
y_f = unit(np.array([0.099, 0.994, -0.054]))           # gripper plate normal
t0 = np.array([0.476, 0.0, 0.88]); t0 = unit(t0 - t0.dot(y_f) * y_f)
a_ax = unit(np.cross(t0, y_f))
origin = np.array(shapes["NAUO6"].Center().toTuple())
tip = np.mean([shapes[k].Center().toTuple() for k in ("NAUO9", "NAUO12")], axis=0)
if (tip - origin).dot(a_ax) < 0: a_ax = -a_ax
t_ax = np.cross(y_f, a_ax)
FRAME = cq.Plane(origin=tuple(origin), xDir=tuple(a_ax), normal=tuple(y_f))  # local x=a, y=t, z=y
TO_GLOBAL, TO_LOCAL = FRAME.rG, FRAME.fG
local = {k: s.transformShape(TO_LOCAL) for k, s in shapes.items()}

def box(a0, a1, t0_, t1, y0, y1):
    return cq.Solid.makeBox(a1 - a0, t1 - t0_, y1 - y0, pnt=cq.Vector(a0, t0_, y0))

def cyl_a(r, a0, a1, t, y):
    return cq.Solid.makeCylinder(r, a1 - a0, pnt=cq.Vector(a0, t, y), dir=cq.Vector(1, 0, 0))

# --- Servo placement (local) ---------------------------------------------------
top_face = CUT + SHIFT                      # claw base cut face after the move
hub_a0 = top_face - HUB_H                   # hub face towards the servo; the horn is recessed in it
horn_a0 = hub_a0                            # horn plate: the spline's top face sits flush with its top
body_bot = horn_a0 + HORN["thick"] - SERVO["spline_top"]
body_top = body_bot + SERVO["body_a"]
body_t = AXIS_T - SERVO["shaft_offset"]     # body centre: shaft offset away from the forearm
tab_a0 = body_bot + SERVO["tab_bottom"]; tab_a1 = tab_a0 + SERVO["tab_thick"]
bt, by = SERVO["body_t"] / 2, SERVO["body_y"] / 2

servo = (box(body_bot, body_top, body_t - bt, body_t + bt, AXIS_Y - by, AXIS_Y + by)
         .fuse(box(tab_a0, tab_a1, body_t - SERVO["tab_span"] / 2, body_t + SERVO["tab_span"] / 2, AXIS_Y - by, AXIS_Y + by))
         .fuse(cyl_a(SERVO["tower_r"], body_top, body_bot + SERVO["tower_top"], AXIS_T, AXIS_Y))
         .fuse(cyl_a(2.4, body_bot + SERVO["tower_top"], body_bot + SERVO["spline_top"], AXIS_T, AXIS_Y)))
def horn_shape(grow=0.0, depth=None):
    h = HORN["thick"] if depth is None else depth
    arms = box(horn_a0, horn_a0 + h, AXIS_T - HORN["length"] / 2 - grow, AXIS_T + HORN["length"] / 2 + grow,
               AXIS_Y - HORN["width"] / 2 - grow, AXIS_Y + HORN["width"] / 2 + grow)
    return arms.fuse(cyl_a(HORN["centre_r"] + grow, horn_a0, horn_a0 + h, AXIS_T, AXIS_Y))
horn = horn_shape()

# --- Part 1: wrist mount ---------------------------------------------------------
gb = local["NAUO6"]
cradle_t0 = body_t - SERVO["tab_span"] / 2 - 1.5
cradle_t1 = body_t + SERVO["tab_span"] / 2 + 1.5
cradle = box(body_bot - WALL, tab_a0, cradle_t0, cradle_t1, AXIS_Y - by - WALL - CLEAR, AXIS_Y + by + WALL + CLEAR)
mount = gb.fuse(cradle).clean()
open_top = body_bot + SERVO["spline_top"] + 1      # servo drops in from the claw side
pocket = box(body_bot - CLEAR, open_top, body_t - bt - CLEAR, body_t + bt + CLEAR, AXIS_Y - by - CLEAR, AXIS_Y + by + CLEAR)
tab_slot = box(tab_a0, open_top, body_t - SERVO["tab_span"] / 2 - CLEAR, body_t + SERVO["tab_span"] / 2 + CLEAR, AXIS_Y - by - CLEAR, AXIS_Y + by + CLEAR)
horn_room = cyl_a(HORN["length"] / 2 + 2.5, body_bot + SERVO["tower_top"], top_face + 1, AXIS_T, AXIS_Y)  # horn sweep
screw_holes = [cyl_a(0.9, tab_a0 - 8, tab_a0 + 0.1, body_t + s * SERVO["hole_spacing"] / 2 + d, AXIS_Y)
               for s in (-1, 1) for d in np.linspace(-SERVO["hole_slot"] / 2, SERVO["hole_slot"] / 2, 5)]
cable = box(body_bot - CLEAR, body_bot + 5, cradle_t0 - 1, body_t - bt, AXIS_Y - 3, AXIS_Y + 3)  # cable exit, far end
mount = mount.cut(pocket).cut(tab_slot).cut(horn_room).cut(cable)
for h in screw_holes: mount = mount.cut(h)
mount = mount.clean()

# --- Part 2: rotating claw base ---------------------------------------------------
move = cq.Location(cq.Vector(SHIFT, AXIS_T - CLAW_CENTRE_T, 0))
lower = gb.cut(box(-200, CUT, -200, 200, -200, 200)).moved(move)
hub = cyl_a(HUB_R, hub_a0, top_face + 3, AXIS_T, AXIS_Y)        # overlaps 3 mm into the base
claw_base = lower.fuse(hub).clean()
claw_base = claw_base.cut(horn_shape(grow=0.3, depth=HORN["thick"] + 0.2))       # horn sits in a recess
claw_base = claw_base.cut(cyl_a(2.8, hub_a0 - 1, top_face, AXIS_T, AXIS_Y))      # centre screw access
for r in (6.0, 8.5, 11.0, 13.5):                    # pilot holes under the horn's arm holes; use the ones that line up
    for s in (-1, 1):
        claw_base = claw_base.cut(cyl_a(0.7, hub_a0 - 1, hub_a0 + 4.5, AXIS_T + s * r, AXIS_Y))
claw_parts = {k: local[k].moved(move) for k in CLAW_PARTS}

# --- Checks -----------------------------------------------------------------------
def overlap(s1, s2):
    try: return s1.intersect(s2).Volume()
    except Exception: return float("nan")
def solids(s): return len(s.Solids())
report = []
report.append(f"wrist mount: {solids(mount)} solid(s), {mount.Volume():.0f} mm3")
report.append(f"claw base:   {solids(claw_base)} solid(s), {claw_base.Volume():.0f} mm3")
fore = local["NAUO4"]
report.append(f"mount vs forearm overlap: {overlap(mount, fore):.2f} mm3 (original gripper base: {overlap(gb, fore):.2f})")
report.append(f"servo vs mount overlap:   {overlap(servo, mount):.2f} mm3")
report.append(f"servo vs forearm overlap: {overlap(servo, fore):.2f} mm3")
others = {k: local[k] for k in ("NAUO1", "NAUO2", "NAUO3", "NAUO4")}
moving = [claw_base] + list(claw_parts.values())
worst = 0.0
for deg in range(-90, 91, 15):
    rot = [s.rotate(cq.Vector(0, AXIS_T, AXIS_Y), cq.Vector(1, AXIS_T, AXIS_Y), deg) for s in moving]
    hits = []
    for name, other in [("forearm", fore), ("mount", mount), ("servo", servo)] + [(k, v) for k, v in others.items() if k != "NAUO4"]:
        v = sum(overlap(r, other) for r in rot)
        if v > 0.5: hits.append(f"{name} {v:.1f}")
        worst = max(worst, v)
    report.append(f"roll {deg:+4d} deg: " + (", ".join(hits) if hits else "clear"))
report.append(f"claw moved {SHIFT:.0f} mm along its axis and {AXIS_T - CLAW_CENTRE_T:+.1f} mm across")

# --- Rough load estimate (assumptions stated; not a structural analysis) -----------
PLA, FILL, SG90_G = 1.24, 0.5, 9.0     # g/cm3; printed mass / solid mass (walls + ~20% infill); servo grams
REACH_CM = 28.0                        # shoulder to wrist with the arm stretched out (upper arm + forearm)
grams = lambda s: s.Volume() / 1000 * PLA * FILL
claw_g = sum(grams(local[k]) for k in CLAW_PARTS) + SG90_G           # gears, links, fingers + gripper servo
before = (grams(gb) + claw_g) * REACH_CM
after = grams(mount) * REACH_CM + (SG90_G + 1.0) * (REACH_CM + 3) + (grams(claw_base) + claw_g) * (REACH_CM + SHIFT / 10)
report.append(f"added mass at the wrist: {grams(mount) + SG90_G + 1 + grams(claw_base) - grams(gb):.0f} g "
              f"(mount {grams(mount):.0f} g, servo {SG90_G:.0f} g, horn 1 g, new claw base {grams(claw_base):.0f} g "
              f"replacing the old gripper base {grams(gb):.0f} g)")
report.append(f"extra shoulder torque, arm stretched out: about {(after - before) / 1000:.2f} kg.cm "
              f"(SG90 stall torque 1.4-1.9 kg.cm; assumes {FILL:.0%} of solid PLA weight and {REACH_CM:.0f} cm reach)")
print("\n".join(report))
(OUT / "checks.txt").write_text("\n".join(report) + "\n")

# --- Export (back in the original assembly coordinates) ----------------------------
g = lambda s: s.transformShape(TO_GLOBAL)
cq.exporters.export(g(mount), str(OUT / "wrist_mount.step"))
cq.exporters.export(g(claw_base), str(OUT / "claw_base_roll.step"))
cq.exporters.export(g(mount), str(OUT / "wrist_mount.stl"), tolerance=0.02, angularTolerance=0.1)
cq.exporters.export(g(claw_base), str(OUT / "claw_base_roll.stl"), tolerance=0.02, angularTolerance=0.1)
full = cq.Assembly(name="arm_with_wrist_roll")
colors = {"01": "gray", "02": "blue", "03": "green", "04": "orange", "06": "purple", "08": "cyan", "09": "magenta"}
for k in ("NAUO1", "NAUO2", "NAUO3", "NAUO4"):
    full.add(shapes[k], name=NAMES[k], color=cq.Color(colors[NAMES[k][:2]]))
full.add(g(mount), name="10_wrist_mount", color=cq.Color("red"))
full.add(g(servo), name="11_roll_servo_SG90", color=cq.Color("black"))
full.add(g(horn), name="12_servo_horn", color=cq.Color("white"))
full.add(g(claw_base), name="13_claw_base_roll", color=cq.Color("red"))
for k, s in claw_parts.items():
    full.add(g(s), name=NAMES[k], color=cq.Color(colors[NAMES[k][:2]]))
full.save(str(OUT / "arm_with_wrist_roll.step"))
print("wrote", ", ".join(sorted(p.name for p in OUT.iterdir() if p.suffix in (".step", ".stl"))))
