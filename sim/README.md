# PNJEX browser sim

A 3D table scene with the team's arm (`finalll2222(1).STEP`: yaw, shoulder, elbow, wrist roll and a gear-driven parallel claw), four cubes, a basket and a table camera. The person picks a cube by looking at it and clenching their jaw (eye tracker + EEG headset); the arm finds it using only the camera image and drops it in the basket. Cubes are simulated with Rapier physics: they drop, tumble, get pushed by the arm and fall into the basket. A cube counts as held once two fingers touch it.

```bash
python3 sim/run.py
```

This serves the sim locally and opens it in a new Chrome tab. It needs only Python 3. three.js and the Rapier physics engine are vendored in `vendor/`, so it works offline.

| File | What it does |
|---|---|
| `layout.js` | Table height, reach band and every object's position. Edit this to rearrange the table. |
| `objects.js` | Builds a cube for each object in `layout.js`. |
| `world.js` | Room, table and lights. |
| `camera.js` | The fixed table camera and its tripod. Edit `LENS` and `AIM` to move it. |
| `arm.js` | Builds the arm and exposes `setJoint` and `setClaw` (the claw follows the linkage table in `arm.json`). |
| `scene.js` | Renderer and scene setup shared by both pages. |
| `main.js` | Main page: orbit view, control panel, and sends the arm pose to camera tabs. |
| `camera.html`, `camera-view.js` | Full-window table camera view in its own tab (the "Camera tab" button). It follows the arm live. |
| `detect.js` | Finds objects in the camera image by comparing it with an empty-table image. |
| `overlay.js` | Draws detection masks on the camera tab and flickers them for SSVEP. |
| `gaze.js` | Webcam eye tracker: MediaPipe face landmarks (loaded from a CDN on first use) and a 9-dot calibration that maps them to screen position. |
| `bci.js` | The EEG headset via `tools/ssvep_train.py`: live waves, jaw-clench events (detector in `tools/clench.py`), impedance. Space bar = clench. |
| `waves.js` | The four live EEG channels on the camera tab, like the OpenBCI GUI's time series. |
| `calibrate.js` | Works out the camera's position from the four board stickers, and turns pixels into table positions. |
| `kinematics.js` | Forward and inverse kinematics for yaw, shoulder, elbow and wrist roll: grip point on target, fingers closing sideways, claw as steep as the arm allows. |
| `task.js` | Pick and place: park, calibrate, detect, locate, plan, wait for the person's pick, drop it in the basket. |
| `physics.js` | Rapier physics: table, board, basket, cubes, and the arm as moving collision shapes. |
| `linalg.js` | Small linear-equation solver used by the two above. |

The scene uses the arm's frame everywhere: x forward, y left, z up, in metres.

`arm/arm.json` and `arm/arm.bin` are generated from `finalll2222(1).STEP` by `tools/export_arm.py` (needs `pip install cadquery`). It finds the joint axes from the shared pins and holes, poses the arm at home (upper arm up, forearm forward, fingers closing sideways; each servo ±90° from there) and tabulates the claw linkage. Re-run it after changing the CAD.

## Picking with your eyes + a jaw clench

### Electrodes (`--montage face`)

| Ganglion | Where | What for |
|---|---|---|
| ch1 | Left outer eye corner, on the bone about 1 cm out from the corner | Glances (with ch2) |
| ch2 | Right outer eye corner, same spot on the right | Glances (with ch1) |
| ch3 | Jaw muscle (masseter): on the cheek, in front of the ear, below the cheekbone, where it bulges when you clench | Clench |
| ch4 | T7, above the left ear | Clench (must agree with ch3) |
| REF / ground | as before (ground on the forehead) | |

### Run it

1. Start the headset: `python tools/ssvep_train.py --native --user nav --montage face` (it streams the Ganglion and runs the clench and glance detectors). On the sim page, **Check electrodes** shows each electrode's impedance (good under 50 kΩ).
2. Press **Pick with eyes + clench**. The Camera tab opens and sets itself up: webcam and 9 dots to look at, the eye check (follow a dot to the left and right edges), then the jaw check (relax 5 s, clench and hold 3 s). Then picking starts by itself.
3. The view zooms in on the cubes. Choosing: with the webcam, the cube you look at turns yellow; without it (or if it loses your face, or after pressing **G**), glance at the left or right edge of the screen to move the yellow one cube. Clench for about a second to pick it (it turns green); clench again within 1.5 s to cancel. Esc stops.
4. The live EEG at the bottom shows each channel; a clench is a burst on Jaw and T7 (both must pass their threshold), a glance is a step in the "Eyes L − R" row past the dashed lines.

Keys on the Camera tab: Space = clench (no headset needed), G = glances/webcam, K = redo the eye check, R = re-centre the webcam tracker, +/− = clench harder/easier to trigger. `?eyes=mouse` skips the webcam; `?bci=http://host:port` points at a trainer on another port.
