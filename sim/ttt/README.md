# Reach tic-tac-toe sim

The cube sim's arm, physics and table camera, set up as a tic-tac-toe match. You are X and the arm plays
your moves. Your opponent, Mr. Pemberton, is a cartoon businessman playing O.

It runs in two tabs, like the cube sim:

| Tab | What it's for |
|---|---|
| **Sim** (`ttt.html`) | Runs the physics, the arm, Mr. Pemberton and the game. No eye tracking here, and nothing is chosen here. |
| **Camera** (`ttt-camera.html`) | Where you play. It shows the table camera's image, the same camera the arm uses, and is the only place with eye tracking. |

```bash
python3 sim/run.py        # then open http://127.0.0.1:8000/ttt.html and press "Open the camera tab"
```

On first use, the camera tab sets itself up:
1. **Webcam.**
2. **Your eye profile.** It loads your saved face model and lines it up with one dot. The first time,
   it runs a full calibration instead (about 45 s).
3. **The OK check.** It runs if the headset is connected.

Then the game starts.

URL options:
- `?user=name` chooses whose profile to use.
- `?eyes=mouse` skips the webcam; the mouse stands in for your eyes.
- `?autostart=0` waits for **New game**.

## A turn

1. **Choose an X.** The camera view zooms in on your spare X's. Each one is drawn with the camera's own
   mask of it, which is what the detector found. Look at one and it lights up yellow; send OK and it
   turns green. OK again or Esc cancels during the cancel window: 3 s from the headset, 1.5 s from the
   space bar.
2. **The arm picks it up.** The view zooms out so you can watch. The arm lifts the X and holds it up and
   out of the way.
3. **Choose a square.** The view zooms in on the board. Look at a square to see a ghost X there, then
   send OK.
4. **The arm puts it down.** It places the X centred and squared, then the camera measures how well.
5. **His turn.** He thinks out loud, leans over and puts down an O. While you're choosing, his eyes
   follow what you're looking at, and in the sim tab the X or square you're looking at lights up too.

After every move the camera reads the whole board and flags any disagreement with the game's record.
After a win or draw, send OK to play again.

## The camera

**Where it is.** It's mounted high behind the arm's right shoulder, roughly where the person sits. It
sees the arm, your X's, the board, his O tray and him in one frame.

**Image quality.** The person never squints at a small part of the picture: the view zooms into what's
being chosen and back out afterwards. The sim re-renders the zoomed view at full window resolution.
A real camera would crop instead, so it needs to be 1080p or better at about this distance.

**Calibration.** It runs once, with the table cleared, from two sets of stickers:
- the four on the arm's mount, which give a first camera pose;
- four green ones on the board's corners, near the middle of the image.

A least-squares fit over all of them gives the final pose: 0.08 px error, and the camera placed within
2 mm of where it really is.

**Finding pieces.** Detection compares the camera image with one of the same view without pieces. Each
blob is then:
- sorted by colour (red X or teal O; an O also has a hole);
- placed on the table;
- for an X, given an angle from the fourfold pattern of its arms;
- kept as a pixel mask, which the camera tab draws.

From this camera the spare X's are found within 0.25 mm and 1.3°, and O's within 0.7 mm.

## Eyes

**Your face model and gaze mapping.** These come from `../gaze.js`: MediaPipe face landmarks, a rigid
3D model of your face, and head-pose-aware regression. They're saved per person in
`logs/users/<name>/gaze_profile.json`, and each session lines them up with a single dot.

**Zoom.** Targets are big when you choose: X's are about 130 px apart and squares about 110–130 px.

**It learns you while you play** (`learn.js`). Every choice you confirm, and don't cancel, says where
you were really looking: the middle of what you chose. Those pairs build a correction on top of the
tracker. It starts as an offset, and after 8 choices adds stretch and shear. Newer choices count more,
and earlier sessions less. It's saved per person in `logs/users/<name>/ttt_gaze_learning.json` (needs
the `run.py` from this branch).

On a simulated tracker that was off by 13.5% of the view, the typical miss fell to 5.5% after 3 choices
and 3.9% after 15.

## How the arm handles an X

**Grasp.** The fingers close across the X's diagonal, into the notches between its arms.

**Squaring it.** Left alone, an X would land turned by however much the arm's heading changes between the
pick and the drop. The wrist roll turns the fingers' closing line to correct this, in two parts:
- **At the pick:** you haven't chosen a square yet, so it turns by the middle of what the empty squares
  would need.
- **At the drop:** it predicts how the held X will sit and turns the rest of the way for the square you
  chose, until the bars land at 45°.

**Gentle drop.** It lowers the X until its lowest corner is 1.5 mm above the board, opens just enough to
let go, rises straight up, and parks.

**Paths.** Every move between the two sides of the table goes up and over: through the high holding pose,
then high above the target. In an earlier version, swinging straight from over the board to the tucked
park pose knocked a placed X off the board.

**Measured in the sim** (through the camera tab, mouse and space bar, 17 placements over 4 games):
- All 17 landed flat in the square chosen.
- They were 0.3–3.9 mm from the centre in true position.
- They were 0–5° off square.

A stray X, for example one knocked off the board, is still offered as a spare. If it lies at an awkward
angle, it may land less square: one test put it 8 mm off centre and 16° off square.

## His play

The rules and his deliberately bad play are unchanged. At the default 55% mistake chance:

| You play | You win | Draw | He wins |
|---|---|---|---|
| Sensibly | 73% | 22% | 5% |
| Perfectly | 85% | 16% | 0% |
| At random | 26% | 12% | 62% |

## Not tested yet

- **The webcam eye tracker on this page.** Headless Chrome has no webcam, so testing used the mouse. The
  tracker is the same code as the cube sim's camera tab.
- **The headset's OK.** It uses the same code path as the cube sim, but only the space bar was used here.
  It's the jaw clench until the motor-imagery decoder exists.
- **The learning layer on real eyes.** It was tested only on a simulated tracker.
- **The printed arm.**

## Files

| File | What it does |
|---|---|
| `../ttt.html`, `main.js`, `ttt.css` | Sim tab: physics, arm, opponent, game loop; asks the camera tab for each choice |
| `../ttt-camera.html`, `camera-view.js`, `camera.css` | Camera tab: the camera image, zoom, masks, eyes, OK, mirrors the sim |
| `scene.js` | The scene both tabs draw, and the state snapshot the sim sends the camera tab |
| `chooser.js` | Look at one of several things, then OK, with dwell, steadiness and cancel |
| `learn.js` | Per-person correction learned from confirmed choices |
| `layout.js` | Where everything is: board, cells, stickers, X supply, O tray, opponent, table camera |
| `world.js` | Room, table, battle mat, glowing board, cell highlights, camera on its pole |
| `pieces.js` | X and O meshes and their collision shapes |
| `physics.js` | Rapier: pieces, board, the arm as moving obstacles, holding and letting go |
| `reach.js` | Inverse kinematics with a chosen closing direction for the fingers |
| `robot.js` | The arm: plan and pick the X you chose, plan and drop it on the square you chose, measure |
| `vision.js` | Table camera: calibration, X/O detection with masks, X angle, board reading |
| `businessman.js` | The opponent: model, IK arms, expressions, placing an O, reactions |
| `rules.js` | Win/draw rules, his move choice, his lines |
