P.N.J.E.X MUJOCO - MAC START GUIDE

Requirements
Apple Silicon Mac, native arm64 CPython 3.12.x, and an internet connection for
setup. This package pins MuJoCo 4.0.0 and NumPy 2.5.4. The reviewed MuJoCo core
4.0.0 Mac wheel for Python 3.12 is arm64, not Intel x86_64. Do not use an Intel
Python under Rosetta. Setup stops if the exact binary packages cannot install;
it does not switch versions or attempt a source build.

The physics models and recorded results were validated on Windows. These Mac
launchers were checked against the official viewer requirements and reviewed
for syntax and paths, but have NOT been executed on a real Mac. Availability
of wheels is not a guarantee of graphics-driver or complete-runtime success.

1. Extract the complete ZIP.
Keep the folder named PNJEX_MuJoCo_Physics. Keep the .py and .command files in
that folder alongside models/, assets/, results/ and parameters/. Do not move
the Python files into a separate scripts folder.

2. Open Terminal and enter that folder.
Type cd followed by a space, drag the PNJEX_MuJoCo_Physics folder from Finder
into Terminal, then press Return. Install native Python 3.12 from python.org
first if it is not available as python3.12 or python3.

3. Run setup once:
    bash SETUP_MAC.command

Setup creates a local .venv and downloads the pinned packages and their
dependencies from https://pypi.org/simple. It does not install into system
Python, use sudo, or require a separate MuJoCo engine download. An existing
compatible .venv is reused. An incompatible or partial .venv is left unchanged;
rename it manually, for example to .venv_backup, before retrying setup. Do not
move the package after setup; virtual environments contain absolute paths.

4. View a recorded run:
    bash REPLAY_CYLINDER_MAC.command
or:
    bash REPLAY_SPHERE_MAC.command

Close the viewer to stop the looping replay. Replay displays the saved
integrated positions; it does not solve a new grasp experiment.

5. To perform a new simulation instead:
    bash RUN_CYLINDER_MAC.command
or:
    bash RUN_SPHERE_MAC.command

Let the run finish so all eight simulated seconds are scored. Loading and
integration may take considerably longer than eight real seconds. Each run
writes JSON, telemetry CSV and trajectory NPZ into its own timestamped folder
under reruns/, preserving the supplied results and previous reruns.

The RUN launchers use the full visual replay XML with the corresponding
reference parameters and the original force-driven simulation script. These
models have the same physical collision/inertia setup as their full reference
counterparts, with visualization included. Their XML file/hash differs from
the original fast/lite reference XML; do not claim file identity or guaranteed
bit-for-bit Mac/Windows numerical agreement.

The launchers use .venv/bin/mjpython because MuJoCo requires it for the passive
viewer on macOS. Running the raw XML in a standalone viewer does NOT execute
the custom pull-only cable forces, finite servo controller or timed fixture
release. Use RUN for physics and REPLAY for saved results.

What is included
- All models and required mesh assets, 44 result JSON records, their rerun
  parameter files, the CSV results summary and the full results/limits report.
- Two reference trajectories and their telemetry CSV files:
    cylinder_sweep_w12_mu05
    sphere_baseline_z60
- Large GIF media and the other raw trajectories/telemetry are omitted from
  this email-sized archive. Those files remain in the separate full archive.

Results to understand before interpreting the viewer
None of the 44 formal cases passed every criterion. The sphere fell. The
reference cylinder remained held during the final hold but moved about 15 mm
after release, exceeding the 5 mm slip requirement. Simulated holding does not
certify the printed hardware, purchased servos or arbitrary objects. Read
RESULTS_AND_LIMITS_EN.txt for the conditions and limitations.

Troubleshooting
- No Python 3.12: install a native arm64 CPython 3.12 distribution, then open a
  new native Terminal. This setup intentionally rejects other Python versions.
- Intel Mac / x86_64 Python: this exact pinned-wheel setup is not supported.
  Ask for a separately validated alternative; do not silently downgrade MuJoCo.
- Installation or viewer error: retain the Terminal error text. Do not bypass
  macOS security settings. No Gatekeeper-disable or quarantine-removal steps
  are part of this package.
- Missing file: extract the whole ZIP and preserve the folder layout above.

Official references checked
Passive viewer and mjpython:
https://mujoco.readthedocs.io/en/stable/python.html#passive-viewer
MuJoCo 4.0.0 entry package and dependencies:
https://pypi.org/project/mujoco/4.0.0/
MuJoCo core CPython 3.12 macOS arm64 wheel:
https://pypi.org/project/mujoco-core/4.0.0/#files
NumPy 2.5.4 CPython 3.12 macOS wheels:
https://pypi.org/project/numpy/2.5.4/#files
