# PNJEX browser sim

A 3D table scene with the real PNJEX V6 arm model and a set of coloured cubes. It has no object detection, inverse kinematics, grasping or physics yet.

```bash
python3 sim/run.py
```

This serves the sim locally and opens it in a new Chrome tab. It needs only Python 3, and three.js is vendored in `vendor/`, so it works offline.

| File | What it does |
|---|---|
| `layout.js` | Table height, reach band and every object's position. Edit this to rearrange the table. |
| `objects.js` | Builds a cube for each object in `layout.js`. |
| `world.js` | Room, table and lights. |
| `camera.js` | The fixed table camera and its tripod. Edit `LENS` and `AIM` to move it. |
| `arm.js` | Builds the arm and exposes `setJoint` and `setClaw`. |
| `main.js` | Renderer, camera and control panel. |

The scene uses the arm's frame everywhere: x forward, y left, z up, in metres.

`arm/arm.json` and `arm/arm.bin` are generated from `PNJEX_V6.xml`. After changing the model, run `python3 tools/export_arm.py`.
