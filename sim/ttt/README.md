# Reach tic-tac-toe sim

The cube sim's arm, physics and table camera, set up as a tic-tac-toe match. You are X and the arm plays
your moves. Your opponent, Mr. Pemberton, is a cartoon businessman playing O.

It runs in two tabs, like the cube sim:

| Tab | What it's for |
|---|---|
| **Sim** (`ttt.html`) | Runs the physics, the arm, Mr. Pemberton and the game. No eye tracking here, and nothing is chosen here. Its own view is a free camera for watching; nothing the arm or the person uses comes from it. |
| **Camera** (`ttt-camera.html`) | Where you play. Everything on it comes from one camera, the table camera, which is also the camera the arm uses. Its player view and board view are both crops of that camera's frame. It's the only place with eye tracking. |

```bash
python3 sim/run.py        # then open http://127.0.0.1:8000/ttt.html and press "Open the camera tab"
```

On first use, the camera tab sets itself up:
1. **Webcam.**
2. **Your eye profile.** It loads your saved face model and lines it up on five quick dots (about 7 s).
   The first time, it runs a full calibration instead (about 45 s).
3. **The OK check.** It runs if the headset is connected.

Then the game starts.

URL options:
- `?user=name` chooses whose profile to use.
- `?eyes=mouse` skips the webcam; the mouse stands in for your eyes.
- `?autostart=0` waits for **New game**.

## A turn

1. **Choose an X.** The camera tab crops in on your spare X's. Look at one and the camera's own mask of
   it (what the detector found) lights up yellow. Send OK (a clench, or the space bar or M) and it turns
   green. OK again or Esc cancels during the cancel window: 3 s from the headset, 1.5 s from a key.
2. **The arm picks it up.** The view goes back to the player view (the whole frame) so you can watch.
   The arm lifts the X and holds it up and out of the way.
3. **Choose a square.** The view switches to the board view. Look at a square to see a ghost X there,
   then send OK.
4. **The arm puts it down.** It places the X centred and squared, then the camera measures how well.
5. **His turn.** He thinks out loud, leans over and puts down an O. While you're choosing, his eyes
   follow what you're looking at, and in the sim tab the X or square you're looking at lights up too.

After every move the camera reads the whole board and flags any disagreement with the game's record.
After a win or draw, send OK to play again.

## The camera

**What it is.** One camera: a 4K webcam (3840×2160, 30 frames a second) set to a 78° diagonal field of
view, like a Logitech Brio 4K. The arm finds pieces in its frames, and the camera tab shows those same
frames. There's no second camera anywhere in the loop. `?camera=1080p` in the address makes it a 1080p
webcam with the same lens (a Logitech C920) for slower computers. Both tabs read it from the address,
and the sim tab passes it on when it opens the camera tab.

**Where it is.** 90 cm above the table, on a pole clamped to the table's right-hand edge, level with the
arm's back. It looks down at 53° and across to the left. The position came from a search over places a
pole can reach. The aim was the biggest possible board, while the frame still holds:
- the whole arm, parked and holding an X up high;
- all five X's, the board and the O tray;
- his face.

It also had to be a place where the arm never stands between the camera and a square. Each square is
then about 106 camera pixels across (53 at 1080p). The earlier position, lower and behind the arm's right shoulder, cut
an X off the bottom of a 16:9 frame.

**Views.** Every view is a crop of the camera's 3840×2160 frame:

| View | Crop of the camera's pixels | Zoom |
|---|---|---|
| **Player view** | the whole frame | none |
| **Board view** | 1328×748 around the board | 2.9× |
| **Your X's** (while you choose one) | 1180×664 around your spare X's | 3.3× |

On a 1280-pixel-wide window at 2× pixel density (2560 screen pixels), the board view is shown at about
twice its camera pixels. At 1080p it was four times, so it's noticeably sharper.

A crop is scaled up from the camera's own pixels, like a digital zoom on a real video feed. Nothing is
re-rendered sharper than the camera saw it, so the zoomed views are a little soft, as they would be with
the real camera. The caption on the picture says which crop is shown and how many camera pixels it holds.

The view follows the turn by itself. When you choose an X, it zooms in on your X's. When you choose a
square, it shows the board view. The rest of the time (the arm moving, his turn) it shows the player
view. The small view in the dock shows the whole frame, with the crop marked, while the big view is
zoomed in, and the board otherwise.

**Calibration.** It runs once, with the table cleared:
1. The four green stickers on the board's corners give a first camera pose. They look alike, so the
   mount's cyan sticker, next to one of them, tells them apart.
2. Every sticker the camera can see then refines that pose with a least-squares fit. From here it sees
   all eight: four on the board and four on the arm's mount.

The result is 0.04 px error, with the camera placed within 0.4 mm of where it really is.

**Finding pieces.** Detection runs on the frame scaled to 1080p, as a real pipeline would, and takes
about 0.1 s. It only runs while the arm is still. On the full 4K frame it took up to 0.3 s and froze
the sim, without being meaningfully more accurate. It compares the frame
with one of the same view without pieces. Each blob is then:
- sorted by colour (red X or teal O; an O also has a hole);
- placed on the table;
- for an X, given an angle from the fourfold pattern of its arms;
- kept as a pixel mask, which the camera tab draws.

From this camera, pieces are found within 0.1 mm (X) and 0.45 mm (O), including pieces on the board. The height
each piece's pixels are projected at was re-tuned for this camera's angle; before that, O's came out
0.7 mm too close to the camera.

## Smoothness

The sim tab sits in the background while you play. Chrome let its timer run only about 12 times a
second there, so the camera tab got the arm's and Mr. Pemberton's positions about 10 times a second,
with gaps of up to a second: everything moved in jerks. Now:
- **The camera tab drives the sim.** It sends a tick to the sim tab every frame, and those messages
  arrive at the full 60 a second. The old timer is only a fallback for when no camera tab is open.
- **The camera tab blends between updates.** It shows the scene 0.15 s behind the sim, blended between
  the updates either side, so uneven arrival never shows. Looking for pieces pauses the sim tab for
  about 0.1 s, and the blend hides that too.
- **Only the visible part is drawn.** The camera tab renders the part of the frame on screen, at the
  camera's own pixel density (or the screen's, if that's lower). It's the same picture as rendering
  the whole 4K frame and cropping it, at a fraction of the cost. It's redrawn every screen frame.
- **Detection runs on a 1080p copy of the frame.** At 4K it took up to 0.3 s, for no useful gain in
  accuracy.
- **The gaze dot glides** to where your eyes are instead of jumping.

Measured during a game in headless Chrome:

| | Before | After |
|---|---|---|
| Sim updates reaching the camera tab | 10 a second | 60 a second |
| Gaps over 0.1 s between updates | 520 | 11 |
| Camera tab frame rate | 60 fps | 59 fps |

## Eyes

**Your face model and gaze mapping.** These come from `../gaze.js`: MediaPipe face landmarks, a rigid
3D model of your face, and head-pose-aware regression. They're saved per person in
`logs/users/<name>/gaze_profile.json`, and each session lines them up on five dots.

**Accuracy.** Two changes made the tracker more accurate. Saved profiles still work: the gaze model
itself is unchanged.
- **Five dots, not one, to line up each session.** Nobody looks exactly at a dot: people miss by about
  half a degree to a degree, which is 25–50 px on a laptop. With one dot, that miss shifted every later
  estimate. Five dots average it down.
- **A fixation filter instead of a median and smoothing.** The shown point is the average of every frame
  since your eyes last moved. A move is two frames in a row, close together, outside the usual scatter
  (which it learns for each person and webcam). A small steady drift to a neighbouring target also
  counts as a move.

Measured on 24 simulated people per error mix, after 0.33 s on a target (not real eyes; see below):

| | Before | After |
|---|---|---|
| Hit rate on targets 115 px apart | 30–46% | 45–68% |
| Typical miss | 68–91 px | 50–70 px |
| Jitter of the shown point | 9 px per frame | 5–6 px per frame |

It follows a look to a neighbouring square in about 0.2 s, which is inside the 0.3 s dwell.

The simulator is tuned so the old tracker's calibration error comes within a few tens of pixels of a
real saved profile's (138 px). It models:
- landmark noise, with the iris points noisier than the rest;
- head sway, and the head shifting between dots;
- the visual axis being a few degrees off the eye's axis;
- the landmark model under-reading large eye turns;
- the eyelid pulling the iris estimate up when looking down;
- the miss on every fixation.

Tried and dropped, because they didn't help live use in the simulator: averaging the iris ring, squared
eye terms, and 13 calibration dots instead of 9.

**Zoom.** Targets are big when you choose. In a 1280-pixel-wide window, the X's are at least 148 px
apart and the squares 106–121 px across.

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

**Measured in the sim.** Through the camera tab (mouse and space bar), 33 placements over 9 games with
this camera position:
- 32 landed flat in the square chosen: 0.4–4.1 mm from the centre in true position, 0–4.5° off square.
- With the 4K camera, the camera's own measurement of each placement matched the true position within
  0.1 mm.
- One, on the top-right square late in a game, ended 12 cm away, off the board's far edge. The camera
  saw it and the game asked for a square again. Fourteen more drops onto that square, with the same
  pieces on the board and the same grip, all landed (0.5–5.4 mm), so the cause isn't known yet.

A stray X, for example one knocked off the board, is still offered as a spare. If it lies at an awkward
angle, it may land less square: one test put it 8 mm off centre and 16° off square.

**Scatter the X's** (sim tab). Throws the spare X's (not the ones on the board or in the claw) onto
random spots on the arm's right, the side nearest the camera, at random angles. Every spot is:
- 17–28 cm from the base, clear of the board, the arm's mounting plate and each other;
- inside the camera's frame, below the prompt banner;
- checked with the arm's own pick planner, at that angle.

The planner check matters because the fingers' closing line only turns about 15°. An X lying with a bar
along that line gets gripped by the bar's ends and lands up to 28° off square. So only angles the arm
can grip near the diagonal (28° or more from a bar) are used.

New games put the X's back where they were last scattered, not in their starting row. If you're choosing
an X when you scatter, the camera looks again and offers them where they landed.

Measured:
- 40 scatters: every X was in frame, seen by the camera and offered for picking. Each scatter took up
  to 0.6 s.
- 15 rounds of scatter, pick a random X, drop it on a random square: all 15 landed in their square,
  0.5–6.7 mm from the centre and at most 4.3° off square.

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
  It's the jaw clench until the motor-imagery decoder exists. The camera tab counts the headset as
  connected only while its samples are arriving. The trainer connects to the Ganglion once, at start-up,
  and keeps answering with frozen readings if Bluetooth drops. The tab now says so and tells you to
  restart the trainer. When the headset comes back, it runs the OK check by itself.
- **The learning layer and the accuracy changes on real eyes.** They were tested only on simulated people.
- **The printed arm.**
- **A real table camera.** The sim's camera is a perfect pinhole: no lens distortion, sensor noise,
  motion blur or auto-exposure. A real C920 needs its lens distortion measured once (a printed
  checkerboard) and undone before these accuracy numbers can hold. The colour tests may also need
  retuning under the room's light.

## Files

| File | What it does |
|---|---|
| `../ttt.html`, `main.js`, `ttt.css` | Sim tab: physics, arm, opponent, game loop; asks the camera tab for each choice |
| `../ttt-camera.html`, `camera-view.js`, `camera.css` | Camera tab: the camera's frame, the player and board views (crops of it), masks, eyes, OK; mirrors the sim |
| `scene.js` | The scene both tabs draw, and the state snapshot the sim sends the camera tab |
| `chooser.js` | Look at one of several things, then OK, with dwell, steadiness and cancel |
| `learn.js` | Per-person correction learned from confirmed choices |
| `layout.js` | Where everything is: board, cells, stickers, X supply, O tray, opponent; the table camera (model, resolution, position) |
| `world.js` | Room, table, battle mat, glowing board, cell highlights, camera on its pole |
| `pieces.js` | X and O meshes and their collision shapes |
| `physics.js` | Rapier: pieces, board, the arm as moving obstacles, holding and letting go |
| `reach.js` | Inverse kinematics with a chosen closing direction for the fingers |
| `robot.js` | The arm: plan and pick the X you chose, plan and drop it on the square you chose, measure |
| `vision.js` | Table camera: calibration from the board's and mount's stickers, X/O detection with masks on the 1080p frame, X angle, board reading |
| `businessman.js` | The opponent: model, IK arms, expressions, placing an O, reactions |
| `rules.js` | Win/draw rules, his move choice, his lines |
