// The EEG headset, through tools/ssvep_train.py (it owns the Ganglion stream and runs the jaw-clench
// detector in tools/clench.py and, with --montage face, the glance detector in tools/eog.py).
// Polls GET /api/live: new samples of the four channels (filtered for display), the left-right eye
// trace, the clench and glance detectors' state, and electrode impedance. A clench or glance is
// reported whenever its counter goes up. With keys: true the space bar also counts as a clench.
// ?bci=http://host:port points at a trainer that isn't on the default 127.0.0.1:8766.

const BCI = new URLSearchParams(location.search).get("bci") || "http://127.0.0.1:8766";

export function createBci({ onClench = () => {}, onGlance = () => {}, onLive = () => {}, keys = false, interval = 100 } = {}) {
  let live = null;
  let connected = false;
  let last = null; // previous counters { clench, left, right }
  let next = 0; // next display sample wanted
  let nextEye = 0; // next eye-trace block wanted
  let wait = interval;

  async function poll() {
    try {
      const response = await fetch(`${BCI}/api/live?from=${next}&efrom=${nextEye}`, { cache: "no-store" });
      live = await response.json();
      connected = true;
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
    get live() { return live; },
    url: BCI,
  };
}
