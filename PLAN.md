# NatHacks26
# Reach: look at it, and the arm acts on it (natHacks 2026)

**Reach** combines a visual brain–computer interface (SSVEP), a robotic arm and an accessible app so people with limited arm or hand movement can act on the world around them: choose something on the table by looking at it, and the arm picks it up and places it. A jaw clench (EMG) confirms/cancels, selects in scan mode, or stops everything.

One core, two uses:
- **Three Territories** (flagship demo): a turn-based tabletop strategy game the Reach player plays with a family member or friend. It shows *why* this matters: play, companionship and connection.
- **Everyday mode**: the same system fetches everyday objects ("bring me the cup"). It shows the platform is general, not a one-trick demo.

- **Event:** natHacks 2026, Healthcare & Accessibility track. Build window Nov 6, 7 PM → Nov 9, 11 AM MT (submission target 10 AM). Hardware back by 7 PM Nov 9.
- **Why:** in a 2025 ALS survey we reviewed, many respondents described loneliness and wanting more interaction with others. Play, companionship and connection deserve attention alongside practical needs. People living with ALS are **one intended user group, subject to individual accessibility needs and further user testing**. (TODO: add the survey citation to README/slides.)
- **Thesis:** "The brain chooses; the robot moves." Non-invasive EEG can't steer each joint, but choosing 1 of 3 bowls needs under 2 bits. The camera turns what's on the table into selectable targets: "the scene is the menu."
- **The product is the control software.** It sits behind an `ArmDriver` interface: the same software drives the simulated arm, the real printed arm, or (in principle) a commercial assistive arm.
- **Team:** 5 people. 3 on software (EEG/EMG, backend/vision/game, frontend/arm software), 2 building the physical arm.

## The Reach core (built once, used by both)

```
camera frame → YOLO finds targets (bowls / objects) → flicker patch on each
→ SSVEP decodes the one the user looks at → CONFIRM (1.5 s, clench cancels)
→ arm picks up (a token from the rack, or the chosen object) → arm places it (in a bowl / at the hand-off spot)
```

The game and everyday mode differ only in what the targets are and where things get picked up and put down. Everything else (detection, flicker, decoding, IK, pick-and-place, safety) is shared code. `app_mode: game | everyday` is an operator switch.

## Three Territories (flagship demo)

**Rules.** 2–4 players (the demo uses 2), six tokens each, own colour each. Three territories worth **3, 4 and 5** points: **three small bowls**. Players take turns placing one token in a territory of their choice. When all tokens are placed, the player with the most tokens in a territory earns its points; a tie for the most awards nothing. Highest total wins. Strategy: defend a lead, challenge an opponent, or concede one territory to secure the others. No time limit on decisions; all players follow the same rules.

**Reach player's turn.** `/user` shows the frozen camera view with a flickering patch on each bowl → SSVEP picks one → CONFIRM → the arm takes the next token from the supply rack and **drops it into that bowl** → the **operator confirms** (`G` landed / `M` retry). A failed placement is retried **without losing the token or the turn**.

**Other players' turns (demo).** They drop their own token in a bowl by hand and tap that bowl in the app. (Stretch: the camera counts tokens per bowl by colour, so no tap is needed.) The software treats every player as an input source (SSVEP, scan + switch, tap, keyboard), so other access methods or a second headset can be added later without changing the game.

**The app** (`/game`, tablet or phone browser): current player, tokens left per player, token count per bowl and player, arm status ("choosing", "arm moving: hands clear", "check placement"), final scoring. Tapping a bowl records a hand-placed move; undo for mistakes.

**Why it suits the system:** 3 targets (more reliable than 4), dropping into a bowl tolerates 1–3 cm servo error, no time pressure, operator-verified placement as the prototype safety net. A 2-player game = 12 placements (6 by the arm); keep a **short variant** (3 tokens each) for judging.

## Everyday mode (second use)

Flicker patches on the detected everyday objects (YOLO) → SSVEP picks one → CONFIRM → arm picks it up → brings it to the **hand-off spot** beside the arm → waits for clench or 10 s → returns it to where it was → HOME. Stretch: after pickup, offer destinations (hand-off spot or one of the bowls) as a second flicker selection; destinations are filtered by rules (reachable, big enough, free), not learned.

## Two worlds, one pipeline

| | `world: sim` (safety net) | `world: real` (goal) |
|---|---|---|
| What `/user` shows | Rendered 3D scene (frozen frame) | iPhone camera frame of the real table (frozen frame) |
| Targets | YOLO on the rendered frame (bowls, objects) | YOLO on the camera frame (bowls, objects) |
| Pixel → 3D | Virtual camera K + pose (known) | ArUco board on the table → camera pose |
| Placement/grasp check | Sim ground truth (automatic) | Operator: `G` success / `M` retry (logged) |
| Physical arm | **Mirror**: copies the sim arm's joint angles | Moves to the real target; sim arm shows the same joints as a live twin |

Everything from EEG/clench → state machine → target → IK → `ArmDriver` is identical in both worlds. `world`, `arm_hw: on|off` and `app_mode` are config/operator switches.
**Build order:** sim game end to end → mirror (real arm copies sim) → real mode → everyday mode.

## Hardware

- **OpenBCI Ganglion** (4 ch, 200 Hz) + **Ultracortex** (dry electrodes). Mac native Bluetooth works (some packet loss); get a **USB-C → USB-A adapter** for the BLED112 dongle, which is more reliable. Kit has **no ear clips**: REF on an electrode at Cz (or right mastoid), ground on the forehead. Tested Nov 6: real EEG on two back channels (~9–13 µVrms at rest); alpha not yet confirmed.
- **3D-printed arm "P.N.J.E.X V6"** (built by the hardware pair). Model: `assets/arm/PNJEX_V6.xml` (MJCF) + `assets/arm/assets/*.obj`. 7 servos: 4 × SF3218MG (yaw, shoulder, elbow, wrist) + 3 × MG90S (one tendon-driven finger each). Details in the Arm spec below.
- **Arduino Uno** drives all 7 servos and reads the physical STOP button. Servos need a **separate supply (~6–7.4 V, ≥ 5 A; check both servo models' voltage ratings)** with ground tied to the Uno's; never power servos from the Uno's 5 V pin. Power is the biggest hardware risk. PCA9685 servo board if available.
- **iPhone 16 Pro** as the real-mode camera via macOS Continuity Camera (a normal OpenCV webcam). Fixed mount near the Reach player's viewpoint, facing the table. Lock zoom/lens.
- **Game parts:** **3 small, low bowls** (~10 cm across, ≤ 4 cm tall, light, ideally 3 different colours so the 3/4/5 values are easy to tell apart), a small **ArUco sticker beside each bowl** (detection fallback), an **ArUco board** on the table (camera pose), a printed **6-slot supply rack** for the Reach player's tokens, tokens in 2–4 colours (6 per player) sized for the gripper (e.g. ~2.5 cm diameter × ~3 cm tall cylinders with a knob or neck; confirm with gripper tests).
- **Everyday objects:** small, light COCO-class items that fit the gripper (≤ 5–6 cm wide): small cup, mini bottle, small apple/orange, foam ball.
- **No EMG amplifier**: jaw EMG comes from the Ganglion (channel map below).
- Hardware desk list: USB-C→USB-A adapter, male-to-female jumper wires (electrode extensions), ear clip electrodes or ECG snap electrodes + leads, conductive paste, BioAmp EXG / MyoWare, large push button, photoresistor + 10 kΩ, servo power supply if needed, a second EEG headset (optional, for a second Reach player).

### Ganglion channel map

| Ch | Ultracortex position | Use |
|---|---|---|
| 1 | O1 | SSVEP |
| 2 | Oz | SSVEP |
| 3 | O2 | SSVEP |
| 4 | T7, over the temporalis | Jaw clench (EMG) |
| REF | Cz (or right mastoid) | Reference |
| D_G | Forehead | Ground |

Finding positions: inion = bump at the back of the skull; Oz ≈ 3.5 cm above it on the midline (10% of nasion–inion); O1/O2 ≈ 3 cm either side; T7 ≈ 3 cm above the top of the left ear; Cz = midpoint of nasion–inion and ear–ear. Fallback layout "4+0" (O1 Oz O2 POz for SSVEP, clench from broadband bursts) is tested at Gate 1 and kept only if it beats 3+1.

## Hard rules

1. **The arm only knows what the camera sees.** Pick and place targets come from detections in the (rendered or camera) frame: YOLO boxes for bowls and objects, ArUco stickers as the bowl fallback. Never from sim ground truth. Ground truth (sim only) is used to render the scene, to check whether a grasp/placement landed, and as the fallback box when detection misses (flagged `source: "gt"`). Exception, stated openly: the token supply rack is a calibrated fixed fixture.
2. **Safety never depends on EEG or on the laptop.** A long clench (>1 s), the on-screen STOP button, spacebar or the physical STOP button → `STOPPED` from any state → `driver.stop()`. The physical button stops the servos **inside the Uno firmware**, and the firmware also halts if the backend heartbeat is lost for > 500 ms. Recovery only by operator "resume". Nobody's hands in the table area while the arm moves (the app shows "arm moving: hands clear").
3. **Flicker is frame-counted.** `requestAnimationFrame` + frame index: `on = (frame % P) < K`. Never `setInterval`, timers or CSS animation. Only `/user` flickers; other views show static outlines.
4. **Detect once, then freeze.** Detection runs on one still frame when SELECTING starts. Targets stay fixed for the selection.
5. **Flicker only during the Reach player's selection.** Off while the arm moves and during other players' turns.
6. **Scope limits:** max 4 targets at once (3 bowls in the game); small (≤ 5–6 cm), light objects/tokens; bowls and objects on a flat table inside the reachable band (15–28 cm from the base, front half only); angled grasp (as close to top-down as the joint limits allow); kinematic attach in sim (no physics); nothing goes near the face: everyday mode ends at a hand-off spot beside the arm.
7. **Accessibility first.** Every selection has a non-EEG path (scan + clench, scan + any switch/button, keyboard by an assistant). Don't assume the jaw clench works for every user (bulbar ALS can weaken it). Photosensitivity warning before any flicker; keep sessions short (flicker is tiring).
8. **Stretch goals only after Gate 3:** everyday-mode destination choice, camera token counting, other input methods / second headset, remote players, physics (MuJoCo), FBCCA/TRCA.
9. **Keep it honest.** EEG metrics come from real teammates; label every other metric as sim or real. Say on stage when a fallback (scan, keyboard, mirror, `gt`, ArUco fallback, operator confirmation) is in use. The game's social benefit is a hypothesis to evaluate with intended users, not a result. Never write "mind control", "reads thoughts", "cures" or "treats" anything.
10. Never commit API keys or raw EEG of people who didn't consent. `logs/` is git-ignored.

## Architecture

```
Ganglion + Ultracortex (200 Hz, BLE) ─────────┐
   ch1-3 O1 Oz O2 → SSVEP │ ch4 T7 → clench    │
iPhone (Continuity Camera, real mode) ────────┤
                                              ▼
                 Python backend (FastAPI + asyncio, one process)
   eeg/ → ssvep/ (CCA, decider) │ emg/ (clench) │ vision/ (YOLO, ArUco, pixel→3D)
   game/ (rules for 2–4 players, turns, input sources) │ sim/ (scene state)
   arm/ (IK → sequences → ArmDriver: Sim / Serial / Mirror)
   core/ state machine │ server/ WebSocket hub │ logs/ everything
          │ serial 115200                     │ WebSocket JSON /ws
          ▼                ┌──────────────────┼──────────────────────┐
  Arduino Uno ── servos   /user (60 Hz monitor:   /game (app: scores,   /world (operator: 3D twin,
       └─ STOP button      frozen frame + flicker)  turns, taps)          signals, operator panel)
```

- **Backend is the source of truth** for scene and game state. Frontends render what they're told.
- **Python owns IK and trajectories.** The frontend and the Uno only follow joint angles they receive.
- Threads for blocking I/O (BrainFlow, serial, camera); asyncio for the server, state machine and drivers.

### State machines

**Game (`game/`):** `SETUP (players, colours, input source per player, who starts) → TURN(player i) → … → SCORING → GAME_OVER`. Turn order rotates; the starting player alternates between games.
**Reach player's turn (`core/state.py`):** `SELECTING (bowls) → CONFIRM (1.5 s, clench = cancel → SELECTING) → PLACING (supply slot → drop in bowl) → VERIFY (operator G/M; M → retry PLACING with the same token) → next turn`.
**Hand-placing player's turn:** wait for a tap in `/game` (or keyboard by the operator) → next turn.
**Everyday mode:** `SELECTING (objects) → CONFIRM → GRASPING → DELIVERING → DELIVERED (clench or 10 s) → RETURNING → SELECTING`. A miss goes straight back to SELECTING.
Any state → `STOPPED` on long clench / STOP (screen, key or button) / arm error / Uno reports STOP; operator resume → previous safe state (game state is never lost).

### Coordinate frame and table layout

Arm base = origin (yaw axis, bottom of the base pedestal). x forward, y left, z up, metres, table top at z = 0 (assumes the base sits on the table; confirm). Same frame as the MJCF file. three.js is y-up: apply **one** fixed rotation at the scene root and nowhere else. In real mode the ArUco board's pose relative to the arm base is a measured constant in `config/scene.yaml`.

Proposed layout (validate every point with IK before printing/placing):
- **Bowls** on an arc at radius ~21 cm, yaw −50° / 0° / +50°, ~10 cm across. Point values are assigned **left to right as seen by the Reach player** (3 / 4 / 5, configurable) or by bowl colour; the labels on `/user` and `/game` follow. Release point = bowl centre, ~4 cm above the rim.
- **Supply rack** at yaw ~−80°, radius 18–23 cm, 6 slots (2 rows × 3).
- **Reach player** sits beside the arm on the +y side (also the everyday-mode hand-off side, yaw ≈ +90°), watching the `/user` monitor. **Other players** sit across the table (+x side) and reach the bowls by hand.
- Everyday mode uses the same front area (bowls removed or left as extra targets).

## Repo layout

```
backend/   main.py, core/state.py, game/{rules,turns,inputs}.py,
           eeg/{acquire,preprocess}.py, ssvep/{cca,decider}.py, emg/clench.py,
           vision/{camera,detect,aruco,project}.py, sim/scene.py,
           arm/{model,ik,driver,serial_driver,sequences}.py, server/ws.py
firmware/uno_arm/uno_arm.ino   (servo control, local speed limit, STOP button, heartbeat)
frontend/  user.html, game.html, world.html, src/{scene,flicker,capture,game,ui}.ts
           (TypeScript + Vite, three.js; no React in the render loop)
assets/    arm/PNJEX_V6.xml + arm/assets/*.obj (team CAD; note sources of REF_ vendor part models),
           game/ (supply rack + token STLs, sim models of bowls/tokens), objects/ (glTFs; keep licences)
config/    scene, game, arm, servos, poses, objects, vision, ssvep, emg .yaml
tools/     eeg_check, export_arm (MJCF → arm_model.json), joint_sliders (sim + real arm), servo_calib,
           camera_calib, print_aruco, record_session, offline_eval, fake_eeg, detect_eval
analysis/  notebooks + figures for the pitch
logs/      git-ignored: eeg.csv + events.jsonl per session
```

Stack: Python 3.11 (`brainflow`, `numpy`, `scipy`, `scikit-learn`, `fastapi`, `uvicorn`, `pyserial`, `ultralytics`, `opencv-contrib-python`, `pyyaml`; optional `mujoco` to cross-check FK), Node 20 + pnpm + Vite (`three` with `OBJLoader`). No URDF and no `ikpy`: the MJCF is parsed directly and IK is closed-form. Install `opencv-contrib-python` only (includes ArUco). Arduino IDE / `arduino-cli`, `Servo` library (or Adafruit PCA9685). System Python is 3.14; use a 3.11 venv (`uv venv -p 3.11 .venv`).

## Module specs

**EEG (`eeg/`).** BrainFlow `GANGLION_BOARD` (dongle) or `GANGLION_NATIVE_BOARD`. Pull every 100 ms into a 6 s ring buffer. Channels 1–3 → SSVEP, channel 4 → `emg/` (roles in config, so 3+1 vs 4+0 is a switch). Per SSVEP window: detrend → 60 Hz notch → band-pass 6–45 Hz (4th-order Butterworth, `filtfilt`). Reject the window if any SSVEP channel's peak-to-peak > ~200 µV (also drops clench/movement windows). Log raw EEG + timestamps continuously. Multiple boards can run side by side later (one per Reach player). Signal check: `tools/eeg_check.py`.

**SSVEP (`ssvep/`).** Square-wave stimuli at 60 Hz: 7.5 (4/4 frames), 8.57 (4/3), 10 (3/3), 12 (3/2); spare 6.67 (5/4). Never pair a frequency with its own harmonic. The game needs **3** (the user's best 3 from calibration; watch 10 Hz for alpha false positives); everyday mode up to 4. **Plain CCA first** (references at f, 2f, 3f); FBCCA only if time allows.
Decider: 3 s window, 0.25 s step, same winner in K=4 consecutive windows, score > T_abs, (best − 2nd) > T_margin, 3 s refractory. Thresholds = 95th percentile of idle scores/margins from calibration. The game has no time limit, so the decider must stay quiet while the user looks around or talks: CONFIRM with clench-cancel is the guard. Calibration: 30 s rest + 3–4 targets × 3 trials × 4 s, saved per user.

**EMG (`emg/`).** Ganglion ch4 (T7) at 200 Hz (Nyquist 100 Hz). 60 Hz notch → band-pass 30–90 Hz → rectify → 100 ms RMS envelope. Baseline 10 s → clench = envelope > μ + 5σ for ≥ 150 ms, 400 ms debounce. Long clench > 1.0 s = STOP. A future EMG amplifier or any switch plugs in behind the same interface.

**Vision (`vision/`).** On entering SELECTING, one still frame:
- *sim:* `/user` renders and sends PNG + K + camera pose.
- *real:* backend grabs a frame from the iPhone, detects the ArUco board → camera pose via `solvePnP` (intrinsics from `tools/camera_calib.py`, ChArUco, once), sends the frozen JPEG to `/user`.

YOLO (`yolo11s`, pretrained COCO, no training needed), conf ≥ 0.4, short side ≥ 60 px. *Game:* keep class `bowl`, expect exactly 3; if one is missing, fall back to the ArUco sticker beside it (flagged `source: "aruco"`). *Everyday:* keep the allowed object classes, top 4. *Sim:* match detections to sim objects by IoU ≥ 0.3, GT fallback flagged; operator switch `detector = yolo | gt`.
Pixel → 3D (same code both worlds): bottom-centre pixel of the box → ray via K + camera pose → intersect table plane z = 0 → push back by the class half-depth (bowls: radius) → grasp/release height from config → optional noise σ (sim only).
Token counting per bowl by colour (stretch): colour blobs inside each bowl's box, checked against the game state.

**Objects and tokens.** Tokens: printed, one colour per player, gripper-sized; grasp height and finger closure in `config/game.yaml`. Bowls: class `bowl`, release height and radius in `config/objects.yaml`. Everyday objects: small cup, mini bottle, small apple/orange, foam ball; check each with YOLO from the iPhone angle before using it. Fixed, pre-validated **demo layouts** for both modes, mirrored on the real table with tape marks.

**Arm (`arm/`).** The team's P.N.J.E.X V6, from `assets/arm/PNJEX_V6.xml` (CAD-derived kinematic preview; not calibrated physics). Body frames have no rotation, so FK is just translations + joint rotations.

| Joint | Axis | Origin (in parent) | Range | Servo |
|---|---|---|---|---|
| yaw | +z | (0, 0, 0.0625) from base | ±90° | SF3218MG |
| shoulder | −y | (0, −0.016, 0.0455) | ±30° | SF3218MG |
| elbow | −y | (0.05, 0, 0.0866): upper arm 10 cm at 60° | ±25° | SF3218MG |
| wrist | −y | (0.0816, 0, −0.0380): forearm 9 cm | −20° … +30° | SF3218MG |
| finger 1/2/3 | (per finger) | on the palm | proximal 0–10°, distal 0–60° (tendon) | MG90S each |

Positive shoulder/elbow/wrist = tip rotates up/back. Grasp point (provisional) = centroid of the three distal-finger origins = (0.112, −0.029, −0.078) in the wrist/palm frame; refine by measuring the real fingertips. It sits 4.5 cm to the side of the yaw axis; IK accounts for it.
**Workspace (FK sweep):** at grasp heights 0–6 cm the gripper reaches **~15–28 cm** from the yaw axis; max lift ~36 cm; front half-plane only (yaw ±90°).
**IK (`arm/ik.py`):** closed-form. Yaw from atan2 with the lateral-offset correction, then planar 3-link solve for position, sweeping the approach pitch and picking the most downward one within limits. Reject if out of limits or FK error > 5 mm → UNREACHABLE (grey, no flicker). Unit-test FK against MuJoCo if installed.
Joint-space interpolation, speed limit in `config/arm.yaml` (start ~30°/s on the real servos). Taught poses HOME / HANDOFF (yaw ≈ +90°, lifted ~25–30 cm) / SAFE_ABOVE in `config/poses.yaml`.
**Gripper:** one claw value 0 (open) → 1 (closed); the backend maps it to 3 finger angles with per-finger calibration. Per-finger overrides for calibration or awkward items.
**Sequences (`arm/sequences.py`)**, built from two primitives, `pick(point)` and `place(point)`:
- *game turn:* HOME → pick(supply slot) → above bowl → descend to release height → open → lift → HOME.
- *everyday:* HOME → pick(object) (sim: attach if within 2 cm of GT, else MISS) → HANDOFF → wait for clench or 10 s → place(original spot) → HOME.
`ArmDriver` interface: `move_joints(q, duration_s)`, `set_claw(value, duration_s)`, `stop()`, `state()`. Implementations: `SimDriver` (30 Hz interpolation, sends `arm_joints`), `SerialArmDriver` (Uno), `MirrorDriver` (both). Keep this interface clean; it's the hardware-agnostic claim in the pitch.
Servo calibration (`config/servos.yaml`, `tools/servo_calib.py`): per servo pin, zero offset, direction, min/max pulse. Expect 1–3 cm real-world error; dropping into bowls is designed to tolerate it.

**Uno firmware (`firmware/uno_arm`).** Line protocol at 115200 baud. Backend → Uno: `J <yaw> <shoulder> <elbow> <wrist> <f1> <f2> <f3>` (servo degrees after calibration), `H` heartbeat (every 100 ms), `S` stop, `R` resume. Uno → backend: `OK`, `POS <…>`, `STOP` (button), `ERR <msg>`. Firmware ramps servos under its own speed limit; STOP button or > 500 ms without heartbeat → hold position and ignore `J` until `R`.
Proposed pinout (confirm with the hardware pair): D0/D1 USB serial, **D2 STOP button** (`INPUT_PULLUP`), D3 yaw, D4 shoulder, D5 elbow, D6 wrist, D7–D9 fingers 1–3.

**Arm rendering.** `tools/export_arm.py` parses the MJCF into `arm_model.json` (body tree, joint axes/ranges, geoms with mesh file, pos, quat, rgba); the frontend builds the three.js hierarchy with `OBJLoader`. MuJoCo quats are (w, x, y, z), three.js is (x, y, z, w): convert in one place. Skip the tiny `REF_M2…`/`REF_M3…` fastener meshes if load time or frame rate suffers.

**Frontends.**
- `/user`: 1920×1080 fullscreen on the 60 Hz monitor. During SELECTING: frozen frame dimmed to ~40%, each target filled solid white↔black (min 140 px, max ~260 px, ≥ 1 patch-width apart) plus its label (bowl points, or object name). Small game strip (whose turn, score). Frame-drop monitor (> 20 ms delta = dropped; red warning above 1%). Photosensitivity warning before the first flicker.
- `/game` (the app): large, readable status for all players: current player, tokens left, per-bowl counts by player, arm status, final scoring. Tap a bowl to record a hand-placed move; undo. Works on a tablet or phone browser.
- `/world` (operator): 3D twin, user-camera frustum, signal panel (bar per frequency, dwell ring, threshold line; big), EMG envelope, STOP, operator panel behind `O` (app_mode, world, arm_hw, mode, detector, noise, recalibrate, resume, fake-EEG/keyboard, `G`/`M` placement keys, game setup/reset/short variant).

## WebSocket messages (`/ws`, JSON)

Backend → frontend:
```json
{"type":"state","state":"SELECTING","mode":"ssvep","app_mode":"game","world":"sim","arm_hw":true}
{"type":"game","phase":"TURN","current":0,"players":[{"id":0,"name":"Alex","input":"ssvep","colour":"blue","tokens_left":4},{"id":1,"name":"Sam","input":"tap","colour":"orange","tokens_left":5}],"territories":[{"id":0,"points":3,"counts":[1,0]},{"id":1,"points":4,"counts":[1,1]},{"id":2,"points":5,"counts":[0,0]}],"score":null}
{"type":"targets","round":12,"kind":"bowl|object","items":[{"id":1,"label":"4 points","class":"bowl","conf":0.81,"source":"yolo","xyxy":[412,380,760,640],"slot":1,"freq":8.57,"target":[0.21,0.0,0.08],"reachable":true}]}
{"type":"capture_request","round":12}
{"type":"frame","round":12,"jpg":"<base64>","K":[...],"cam_pose":[...]}
{"type":"scores","t":1731000000.12,"scores":[0.61,0.22,0.18],"winner":0,"dwell":3}
{"type":"selected","kind":"bowl","id":1,"label":"4 points"}
{"type":"emg","envelope":0.12,"clench":false}
{"type":"arm_joints","q":[0.0,0.1,-0.2,0.05],"claw":0.0,"fingers":[0.0,0.0,0.0]}
{"type":"arm","phase":"PLACE_DESCEND","progress":0.4}
{"type":"hw","uno":"ok|stopped|disconnected"}
{"type":"error","msg":"target unreachable"}
```
`capture_request` is sim only; in real mode the backend sends `frame`. `q` = [yaw, shoulder, elbow, wrist] in radians (model frame); `fingers` = 3 closures 0–1 derived from `claw`. `targets` replaces the earlier `detections` message.

Frontend → backend:
```json
{"type":"capture","round":12,"png":"<base64>","K":[...],"cam_pose":[...]}
{"type":"cmd","cmd":"start|stop|resume|mode|app_mode|world|arm_hw|detector|verify|game_setup|game_reset|game_variant","value":"ssvep|scan|keys|game|everyday|sim|real|on|off|yolo|gt|hit|miss|full|short"}
{"type":"move","player":1,"territory":2}
{"type":"undo"}
{"type":"key_select","slot":2}
{"type":"stim","on":true,"refresh_hz":60.0,"dropped_frames":0}
```
Change these only with the whole team's agreement; update this file when they change.

## Dev modes

- **Keyboard mode** (keys 1–4) and `tools/fake_eeg.py` let everyone work end to end without a headset. Keep them working all weekend.
- **Scan + clench**: targets highlight 1.5 s each with a tick; clench selects. Guaranteed demo path. Any switch (Uno button, spacebar by an assistant) can replace the clench.
- **`arm_hw: off`** runs without the printed arm; `tools/joint_sliders` drives sim and real arm by hand.
- **Game short variant** (3 tokens each) for quick tests and judging.

## Priorities

- **Must (by Gate 3):** the shared core (YOLO bowls → flicker → SSVEP/scan → confirm → pick → place), the game on top in sim end to end (rules, turns, `/game` app with taps, operator verify/retry), STOP everywhere (incl. firmware), mirror mode on the real arm, backup video.
- **Should:** real mode for the game (iPhone + ArUco board + real token drops), everyday mode (pick an object, hand-off, return), core metrics.
- **Only if ahead:** everyday destination choice, camera token counting, second headset / other input methods, remote players, FBCCA, noise experiments, physics.

## Gates and fallbacks

| Gate | When | Pass criteria | If it fails |
|---|---|---|---|
| 1 | Sat ~3 AM | SSVEP peak at ≥ 3 freqs on ≥ 1 person (O1/Oz/O2); clench visible on ch4; arm renders in three.js from the MJCF and Python FK matches; servo power supply sorted; backend moves one servo through the Uno and the STOP button halts it; iPhone frame in OpenCV: YOLO finds all 3 real bowls and the ArUco board is detected; keyboard select reaches the frontend; frame-drop monitor shows 0 drops; game rules unit-tested (2–4 players, ties) | Fix electrode contact before anything else (paste if available). Bowls not detected: try other bowls/angle, else ArUco stickers |
| 2 | Sat 12 PM | Full game in sim by keyboard (with `/game` app); SSVEP ≥ 85% on 3 targets; clench ≥ 95%, < 1 false/min; sim IK reaches every supply slot and bowl release point (≤ 5 mm); real arm follows `joint_sliders` after servo calibration and drops a token from the rack into a bowl using taught poses | SSVEP: 4 s windows / bigger patches; by 2 PM scan mode becomes primary. Clench: move electrode / re-baseline / switch input. Arm: taught poses per slot/bowl instead of IK |
| 3 | Sat 10 PM | A short game end to end with real EEG (or scan + clench), sim + **mirror** (real arm drops tokens), no manual arm control. **Record backup video.** | Stretch goals stay off; demo is sim + video |
| 3.5 | Sun 12 PM | Real mode: YOLO bowls → arm drops into the right bowl ≥ 8 of 10; everyday mode fetches 1 object end to end | Demo the game in mirror mode; show everyday mode in sim |
| 4 | Sun 6 PM | Feature freeze: bug fixes only after this | |

## Metrics to collect (for README, slides, submission)

Core: SSVEP accuracy on 3 targets (20 cued selections per person), time per selection, ITR, idle false selections per 2 min, clench detection and false triggers, calibration time. Game: Reach turn time (look → token in bowl), placement success rate (first try / after retry), games completed end to end (n). Vision: bowl detection rate from the iPhone angle (n frames). Arm: sim IK error, real placement success, everyday fetch success. Label each metric sim / real / EEG, and always state n. No claims about loneliness or wellbeing outcomes: those need user studies.

ITR: B = log2 N + P·log2 P + (1−P)·log2[(1−P)/(N−1)]; ITR = B × 60 / T (T in seconds per selection).

## Working conventions

- Small commits, push often; the commit history proves everything was built during the event. Branch per module, merge to `main` at each gate.
- Tunable numbers go in `config/*.yaml`, not in code.
- Log every event to `events.jsonl` (stim on/off, target, prediction, state and game changes, Uno messages, G/M results, player moves); metrics are computed from logs.
- Licence: repo is AGPL-3.0 (required by Ultralytics). README credits must list BrainFlow, three.js, Ultralytics YOLO (AGPL-3.0), OpenCV, MuJoCo (if used), the team's P.N.J.E.X arm design, the sources of the `REF_` vendor part models, every 3D model source, and the 2025 ALS survey.

## Open questions

Hardware pair:
1. Are shoulder ±30° and elbow ±25° hard mechanical stops or conservative? Wider ranges grow the workspace a lot.
2. Final Uno pinout (proposal above) and the servo power supply (voltage, amps).
3. Table height relative to the base (assumed: base on the table, z = 0).
4. Real fingertip positions and max gripper opening, to fix the grasp point.
5. Token shape the gripper picks reliably; supply rack design; total `.obj` mesh size; `REF_` model sources.

Team:
6. Which 3 bowls (size, colour), and does YOLO detect them from the iPhone angle? Test early.
7. Survey citation (title, publisher, n).
8. Who starts the first game? (Default: alternate; Reach player starts game 1.)
