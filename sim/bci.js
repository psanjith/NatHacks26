// The EEG headset, through tools/ssvep_train.py (it owns the Ganglion stream and runs the jaw-clench
// detector in tools/clench.py and, with --montage face, the glance detector in tools/eog.py).
// Polls GET /api/live: new samples of the four channels (filtered for display), the left-right eye
// trace, the clench and glance detectors' state, and electrode impedance. A clench or glance is
// reported whenever its counter goes up. With keys: true the space bar also counts as a clench.
// ?bci=http://host:port points at a trainer that isn't on the default 127.0.0.1:8766.
// Connected means the headset's samples are arriving, not just that the trainer answers: the trainer
// connects to the Ganglion once, when it starts, so if Bluetooth drops it keeps answering with the last
// readings frozen. headsetProblem() says which it is.

const BCI = new URLSearchParams(location.search).get("bci") || "http://127.0.0.1:8766";
const STALE_S = 3; // no samples from the headset for this long = not connected

// What's wrong when it isn't connected, in a sentence (or null when it is).
export function headsetProblem(bci) {
  if (bci.connected) return null;
  if (!bci.trainer) return "Headset not connected: start tools/ssvep_train.py.";
  const s = bci.live?.stale_s;
  if (s === null || s === undefined) return "The trainer is running and waiting for the headset: is the Ganglion switched on?";
  const ago = s < 120 ? `${Math.round(s)} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
  return `The trainer is running, but the headset has sent nothing for ${ago}: switch the Ganglion on and restart the trainer (Ctrl+C, then run it again).`;
}

export function createBci({ onClench = () => {}, onGlance = () => {}, onLive = () => {}, keys = false, interval = 100 } = {}) {
  let live = null;
  let trainer = false; // the trainer answered
  let connected = false; // and the headset's samples are arriving
  let last = null; // previous counters { clench, left, right }
  let next = 0; // next display sample wanted
  let nextEye = 0; // next eye-trace block wanted
  let wait = interval;

  async function poll() {
    try {
      const response = await fetch(`${BCI}/api/live?from=${next}&efrom=${nextEye}`, { cache: "no-store" });
      live = await response.json();
      trainer = true;
      connected = live.stale_s !== null && live.stale_s !== undefined && live.stale_s <= STALE_S;
      if (live.wave.end < next) next = 0; // the trainer was restarted
      next = live.wave.end;
      const eye = live.eog.available ? live.eog : null;
      if (eye) nextEye = eye.trace.end < nextEye ? 0 : eye.trace.end;
      const now = { clench: live.clench.n, left: eye?.n_left ?? 0, right: eye?.n_right ?? 0 };
      if (last) {
        if (now.clench > last.clench) onClench("eeg");
        if (now.left > last.left) onGlance("left");
        if (now.right > last.right) onGlance("right");
      }
      last = now;
    } catch {
      trainer = false;
      connected = false;
      live = null;
      last = null;
      next = nextEye = 0;
    }
    onLive({ connected, live });
    setTimeout(poll, connected ? wait : 2000);
  }

  if (keys) {
    const typing = (event) => event.target.closest?.("input, textarea, select");
    window.addEventListener("keydown", (event) => {
      if (event.code !== "Space" || typing(event)) return;
      event.preventDefault(); // don't press whichever button has focus
      if (!event.repeat) onClench("key");
    });
    window.addEventListener("keyup", (event) => {
      if (event.code === "Space" && !typing(event)) event.preventDefault();
    });
  }

  // text/plain keeps these "simple" cross-origin requests (no preflight); the trainer parses JSON anyway.
  async function send(path, body) {
    const response = await fetch(`${BCI}${path}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) });
    return response.json();
  }

  poll();
  return {
    calibrateClench: (step, factor) => send("/api/clench/calibrate", { step, factor }),
    calibrateGlance: (step, phase) => send("/api/eog/calibrate", { step, phase }),
    impedance: (on) => send("/api/impedance", { on }),
    setInterval: (ms) => (wait = ms),
    get connected() { return connected; },
    get trainer() { return trainer; },
    get live() { return live; },
    url: BCI,
  };
}
