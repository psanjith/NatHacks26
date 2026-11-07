# PNJEX browser sim

A 3D table scene with the real PNJEX V6 arm model, four cubes, a basket and a table camera. "Pick random cube" picks a cube using only the camera image, then drops it in the basket. There is no physics: a cube counts as gripped when the claw closes within 2 cm of its centre.

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
| `scene.js` | Renderer and scene setup shared by both pages. |
| `main.js` | Main page: orbit view, control panel, and sends the arm pose to camera tabs. |
| `camera.html`, `camera-view.js` | Full-window table camera view in its own tab (the "Camera tab" button). It follows the arm live. |
| `detect.js` | Finds objects in the camera image by comparing it with an empty-table image. |
| `overlay.js` | Draws detection masks on the camera tab and flickers them for SSVEP. |
| `calibrate.js` | Works out the camera's position from the four board stickers, and turns pixels into table positions. |
| `kinematics.js` | Forward and inverse kinematics for the arm's four joints. |
| `task.js` | Pick and place: park, calibrate, detect, locate, plan, pick a random cube, drop it in the basket. |
| `linalg.js` | Small linear-equation solver used by the two above. |

The scene uses the arm's frame everywhere: x forward, y left, z up, in metres.

`arm/arm.json` and `arm/arm.bin` are generated from `PNJEX_V6.xml`. After changing the model, run `python3 tools/export_arm.py`.
