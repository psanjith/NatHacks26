# Reach

**A hands-free assistive robotic arm for people with ALS who still have jaw control.**

Look at an object and clench your jaw, and the arm picks it up. Look where it should go and clench again, and the arm puts it there.

Built in 64 hours at natHacks 2026 (Healthcare & Accessibility track).

| | |
|---|---|
| **Demo video** | **[TODO: add link]** |
| **Slides** | **[TODO: add link]** (source in [`pitch/project/slides/`](pitch/project/slides/)) |
| **Code** | https://github.com/psanjith/NatHacks26 |

## The problem

ALS takes away the use of a person's hands and arms, often while their mind and eyes keep working. Assistive arms exist, but a Kinova JACO costs about $35,000 and is steered by joystick, and the Obi costs about $8,000–9,600 and only feeds. Researchers have shown that eye gaze can control a robot arm, but gaze alone has a known flaw: the system can't tell looking from choosing (the "Midas touch" problem).

## How Reach works

1. **See the table.** A table camera finds the objects from the image alone.
2. **Choose with your eyes.** A webcam eye tracker follows your gaze, and whatever you look at lights up yellow.
3. **Confirm with your jaw.** Hold a clench for about a second. The clench is the signal that separates choosing from just looking.
4. **The arm picks it up.** It locates the object from the camera image and plans the move.
5. **Put it where you want.** A ghost of the object follows your gaze. Clench to place it.

The clench is read as muscle activity (EMG) through an OpenBCI Ganglion. **Reach is not mind control.**

### Planning for ALS progression

ALS is progressive, so a person's jaw control will eventually go. Three electrodes sit over the occipital lobe for a planned upgrade to SSVEP, a brain signal that could replace the clench. **They aren't used yet, and the upgrade isn't built.** It would also depend on the person's vision and some eye control.

We tried SSVEP first. Over 185 trials in 3 sessions, mains hum was about 1,000 times larger than the response, and no decoder beat 32% on 7 targets (chance is 14%). That noise has to be solved before the upgrade can work.

## Current status

| Part | Status |
|---|---|
| Camera detection, eye tracking, clench confirmation | Working in the sim |
| Tic-tac-toe sim | Working: 32 of 33 test placements landed flat in the chosen square, 0.4–4.1 mm from its centre. One landed 12 cm away, off the board; the camera caught it and the game asked for a square again, but the cause isn't known yet |
| Placing anywhere on the table | Working in the cube sim: the cube landed about 1 mm from the chosen spot |
| Physical printed arm | CAD is in this repo. **This repo has no firmware or code that drives the physical arm** |
| Stopping the arm mid-move | **Not built.** You can only cancel before the arm starts moving |
| SSVEP upgrade | Planned, not built |

**How it was tested.** Most sim features were tested in a browser with the mouse standing in for the eyes and the space bar for the clench. The latest eye tracker improvements were measured on simulated people, not real eyes: typical miss fell from 68–91 px to 50–70 px. One real saved profile had a calibration error of 138 px.

## To try it without any hardware

You only need [Python 3](https://www.python.org/downloads/) and Chrome. There's nothing to install, and the 3D and physics libraries are included in the repo.

```bash
git clone https://github.com/psanjith/NatHacks26.git
cd NatHacks26
python3 sim/run.py
```

On Windows, use `py -3 sim/run.py` if `python3` isn't available.

The server starts on port 8000, or the next free port if that one is taken, and opens the cube sim in a new tab. Then open the main demo:

1. Open http://127.0.0.1:8000/ttt.html. This tab runs the arm and the physics, so leave it open.
2. Open http://127.0.0.1:8000/ttt-camera.html?eyes=mouse. This is the view you control it from, with the mouse standing in for your eyes. Keep this tab in front while you play.
3. Move the mouse onto one of your red X's and press **Space**. That's the clench. Wait for the cancel window to end and the arm to pick it up.
4. Move the mouse onto a board square: a ghost X shows where it will land. Press **Space** again. The arm places it, and your opponent, Mr. Pemberton, replies with an O.

Close old sim tabs before starting, because they can interfere with new ones.

### The two demos

| Demo | Open | What it shows |
|---|---|---|
| **Tic-tac-toe** (main demo) | `ttt.html`, then `ttt-camera.html` | Play a full game against a cartoon opponent, with the arm moving your pieces. **Scatter the X's** on the `ttt.html` tab throws them to random spots, so the arm has to find them |
| **Cube sim** | `index.html`, then **Pick with eyes + clench** | Pick up cubes and place them on the table or in a basket, with each spot checked first |

### Tic-tac-toe controls

| Input | Action |
|---|---|
| Look at something, then clench or press **Space** or **M** | Choose it |
| Clench or press **Space** or **M** again, or press **Esc** (Esc is keyboard only) | Cancel during the short window before the arm moves |
| **R** | Line up the eye tracker again (5 dots) |
| **D** | Show or hide the gaze dot |

The view zooms by itself: in on your X's when you choose one, to the board when you choose a square, and out to the whole table the rest of the time.

## Run it with the full setup

### 1. Eye tracking

Open the camera tab without `?eyes=mouse` and allow webcam access. The first time, you calibrate by looking at dots (about 45 seconds), and your profile is saved to `logs/users/<name>/`, which git ignores. Later sessions only need 5 quick dots. Add `?user=yourname` to choose a profile.

The eye tracker downloads MediaPipe from the internet the first time, so this step needs a connection.

### 2. Electrodes

| Ganglion channel | Position | Job |
|---|---|---|
| ch1, ch2, ch3 | O1, Oz, O2 (occipital lobe) | Not used yet: planned SSVEP upgrade |
| ch4 | Jaw: on the cheek in front of the ear, where the muscle bulges when you clench | Clench |
| REF | Earlobe | Reference |
| D_G | Forehead | Ground |

### 3. Headset software

Tested with Python 3.11. Close the OpenBCI GUI first, because only one program can hold the Ganglion connection.

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Ganglion over a Mac's Bluetooth
python tools/ssvep_train.py --native --user yourname --no-browser

# or with the BLED112 USB dongle (not the setup we tested most)
python tools/ssvep_train.py --port /dev/cu.usbmodemXXXX --user yourname --no-browser

# or with no headset, to test the connection on simulated data
python tools/ssvep_train.py --fake --user yourname --no-browser
```

The sim finds the headset software by itself on port 8766, and you can watch the live signal at http://127.0.0.1:8766/signal. In the camera tab, press **Check the OK signal** to set your clench threshold: relax for 5 seconds, then clench and hold for 3.

The Bluetooth connection can drop without an error. If the waves stop moving, restart the command above.

More detail: [`sim/README.md`](sim/README.md) (cube sim) and [`sim/ttt/README.md`](sim/ttt/README.md) (tic-tac-toe). `sim/README.md` describes an older electrode layout (`--montage face`) that isn't used with the layout above.

## Requirements

### Software

| Needed for | Requirement |
|---|---|
| Sim | Python 3, Chrome with WebGL. Other browsers are untested |
| Eye tracking | Webcam, plus internet on first use |
| Headset | Python 3.11, with [`requirements.txt`](requirements.txt): BrainFlow, NumPy, SciPy |
| Regenerating the arm model from CAD (optional) | `pip install cadquery`, then `tools/export_arm.py` |

### Hardware

None of this is needed for the sim.

| Part | Qty | Notes |
|---|---|---|
| OpenBCI Ganglion | 1 | 4-channel board, $624.99 at last check |
| Electrodes | 6 | 3 occipital, jaw, reference, ground |
| Webcam | 1 | For eye tracking; the sim asks for 1280×720 |
| 3D-printed arm | 1 | About 1 kg PLA. CAD in [`cad/`](cad/) and `finalll2222(1).STEP` |
| Hobby servos | 5 | Yaw, shoulder, elbow, wrist roll, claw |
| Arduino Uno | 1 | Planned servo controller; no firmware in this repo yet |
| Servo power supply | 1 | Separate from the Arduino, at least 5 A. Check the voltage against your servos |
| Table camera | 1 | For the physical arm; a phone works |
| Jumper wires | | |

**Estimated parts cost: about $750.** This is what the parts would cost someone building one, not a selling price. Most prices other than the Ganglion are estimates.

## Repository layout

| Path | Contents |
|---|---|
| [`sim/`](sim/) | Cube sim: arm, physics, camera detection, eye tracker, headset link |
| [`sim/ttt/`](sim/ttt/) | Tic-tac-toe sim |
| [`tools/`](tools/) | Ganglion streaming, clench detector, SSVEP experiments, CAD export |
| [`cad/`](cad/), `finalll2222(1).STEP` | Arm design files |
| [`pitch/`](pitch/) | Pitch notes and slide source |
| [`PLAN.md`](PLAN.md) | The original plan. It describes an older SSVEP-based design, not the current demo |

## Credits

### Team

**[TODO: team name]**

- Josh Barre
- Prakul Sanjith Selvakumar
- Emily Want
- Navjot Ghotra
- Xinrin Li

Thanks to natHacks 2026 for lending us the hardware.

### Third-party software

| Project | Used for | Licence |
|---|---|---|
| [three.js](https://threejs.org/) r169 | 3D rendering (in `sim/vendor/`) | MIT |
| [Rapier](https://rapier.rs/) | Physics (in `sim/vendor/rapier/`) | Apache-2.0 |
| [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) | Face landmarks for eye tracking | Apache-2.0 |
| [BrainFlow](https://brainflow.org/) | Streaming from the Ganglion | MIT |
| [NumPy](https://numpy.org/), [SciPy](https://scipy.org/) | Signal processing | BSD-3-Clause |
| [CadQuery](https://github.com/CadQuery/cadquery) | Converting the arm's CAD for the sim | Apache-2.0 |
| [MuJoCo](https://mujoco.org/) | Early grasp study of the gripper (since removed; in git history) | Apache-2.0 |
| [SSVEP Analysis Toolbox](https://github.com/pikipity/SSVEP-Analysis-Toolbox) (Wang et al., IEEE TNSRE 2024) | Our SSVEP experiments (since removed; in git history) | CC BY-NC-SA 4.0 |

### Sources

**Price comparisons**
- [OpenBCI shop: Ganglion price](https://shop.openbci.com/collections/frontpage/openbci)
- [Kinova JACO price (about $35,000)](https://futurism.com/robot-arm-wheelchair)
- [R-ARM paper: other wheelchair-mounted arms over $40,000](https://www.nibib.nih.gov/sites/default/files/R-ARM.pdf)
- [Obi 3 retail listing](https://peakprimalwellness.com/products/obi-3-robotic-feeding-device) and [Obi retail listing (rehab-store)](https://www.rehab-store.com/p-obi-robotic-independent-feeding-device.html)

**Research**
- [Fischer-Janzen et al. 2024: scoping review of gaze control for assistive arms](https://pmc.ncbi.nlm.nih.gov/articles/PMC10909843)
- [Eye-gaze control of a wheelchair-mounted 6-DOF assistive robot](https://ouci.dntb.gov.ua/works/4MQ0gMN4)
- [Stanford ARMLab: gaze + EMG control of a JACO](https://src.stanford.edu/demo/gaze-based-control-for-assistive-arms)
- [Northwestern 2023: eye-gaze signals in assistive device control](https://www.mccormick.northwestern.edu/news/articles/2023/06/study-finds-eye-gaze-signals-provide-key-answers-in-assistive-device-control/index.html)
- [Nature Communications 2022: intracortical BCI in completely locked-in ALS](https://www.nature.com/articles/s41467-022-28859-8)
