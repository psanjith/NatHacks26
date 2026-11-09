# PNJEX browser sim

A 3D table scene with the team's arm (`finalll2222(1).STEP`: yaw, shoulder, elbow, wrist roll and a gear-driven parallel claw), four cubes, a basket and a table camera. The person picks a cube by looking at it and clenching their jaw (eye tracker + EEG headset); the arm finds it using only the camera image, picks it up, and puts it wherever the person looks next and clenches (a spot on the table that passes the checks, or the basket). Cubes are simulated with Rapier physics: they drop, tumble, get pushed by the arm and fall into the basket. A cube counts as held once two fingers touch it.

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
| `task.js` | Pick and place: park, calibrate, detect, locate, plan, wait for the person's pick, then wait for where to put it (place anywhere) and put it there or in the basket. |
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
3. The view zooms in on the cubes. Choosing: with the webcam, the cube you look at turns yellow; without it (or if it loses your face, or after pressing **G**), glance at the left or right edge of the screen to move the yellow one cube. Clench for about a second to pick it (it turns green); relax and clench again within 3 s to cancel (1.5 s with the space bar). Esc stops.
4. **Where it goes.** With "Choose where to put it" ticked in the sim tab (the default), the arm parks holding the cube and the Camera tab shows small green dots where it can go, plus the basket. Look at a spot: a ghost cube shows green if it passes the checks, red with the reason if not. Clench to put it there (relax and clench again within 3 s to cancel (1.5 s with the space bar)). With glances, the highlight steps through a few suggested spots and the basket. Esc puts it in the basket and stops.
   The checks, judged only from what the camera saw: **reachable** (the arm can lower it there within 5 mm), **free** (6 cm from every other cube), **off the arm's base board and the table edge, clear of the basket**, and **inside the camera's view**. The spots are a polar grid around the arm (`PLACE_GRID` in `task.js`).
5. The live EEG at the bottom shows each channel; a clench is a burst on Jaw and T7 (both must pass their threshold), a glance is a step in the "Eyes L − R" row past the dashed lines.

### When the webcam can't track your eyes

If glances are set up, the Camera tab switches to them by itself when the webcam can't track the eyes, and shows why on screen:

| Trigger | Switch after |
|---|---|
| Face lost | 2.5 s |
| Webcam image below 40% of its brightness at the last calibration or re-centre (covered camera, lights off, backlight) | 1 s |
| Gaze estimate jumping more than 3× as much as at calibration (and at least 40 px): poor tracking in dim light | 1.5 s |

It goes back to the webcam only when the face is visible, the image is above 55% of the calibration brightness and the tracking is steady again, all for 2 s. The gap between 40% and 55% (and between 3× and 2× jitter) stops it bouncing between modes when the light is borderline. Without the glances set up it stays on the webcam and says so. The thresholds are at the top of `camera-view.js`; `sim.state()` in the Camera tab's console shows the current mode and readings.

### Eye calibration must pass

A new eye profile is only accepted when its typical error is **175 px or less** and no single dot is off by more than 350 px. Each dot's error is measured with a fit made without that dot. Until then it sends you back to the dots that are off (missing ones first, then the worst 3 at a time, re-scoring after each round), with no limit on rounds; **Esc** gives up, nothing is saved, and the mouse stands in. A saved profile that doesn't meet the limit isn't loaded: it asks for a new one. `?eyeError=150` on the Camera tab's address changes the limit.

The webcam is asked for 1280×720. Each still dot stays up 2.2 s and ignores its first 0.8 s, while the eyes get there. Frames next to a blink are dropped, and so are frames where several inputs disagree with the rest of that dot (a glance away, eyes not settled). A dot left with too few frames gets redone. A profile records its webcam image size and only loads at that size. The "Eyes:" line shows the size in use.

Keys on the Camera tab: Space = clench (no headset needed), G = glances/webcam, K = redo the eye check, R = line the webcam tracker up again (5 dots), +/− = clench harder/easier to trigger. `?eyes=mouse` skips the webcam; `?bci=http://host:port` points at a trainer on another port.
