// Choosing one of a few things on screen with the eyes and an OK, for the camera tab.
// Look at one: after DWELL_MS it's highlighted. Send OK (headset or space bar): it's confirmed and turns
// green, with a moment to change your mind (OK again or Esc cancels). Guards as in the cube sim: the gaze
// must be clearly closer to a new item to switch, steady before an OK counts, and an OK from the headset
// is ignored while you're talking or looking away from the screen.

const DWELL_MS = 300;
const SWITCH_RATIO = 0.8;
const HOLD_LOST_MS = 1500;
const STEADY_MS = 400;
// The headset needs longer to cancel: a clench registers after ~0.6 s of holding and the detector waits
// for the jaw to relax before it can count another.
const CONFIRM_MS = { eeg: 3000, key: 1500 };
const REACH = 0.75; // gaze further than this many item spacings from every item = none

export function createChooser({ gaze, point, onFocus = () => {}, onChoose = () => {}, onPrompt = () => {} }) {
  let items = []; // [{ id, name, screen: () => ({ x, y }) }]
  let what = ""; // "an X", "a square"
  let gazed = null;
  let gazedSince = 0;
  let candidate = null;
  let candidateSince = 0;
  let awaySince = null;
  let confirm = null; // { id, source, until, timer, seen }
  let note = null;

  const find = (id) => items.find((i) => i.id === id);
  function setGazed(id, now = performance.now()) {
    if (id === gazed) return;
    gazed = id;
    gazedSince = now;
    onFocus(id, id === null ? null : "gaze");
    prompt();
  }

  function say(text, ms = 2200) {
    note = { text, until: performance.now() + ms };
    prompt();
  }

  function prompt() {
    let text = null;
    if (note && performance.now() < note.until) text = note.text;
    else if (confirm) {
      const left = Math.max(0, Math.ceil((confirm.until - performance.now()) / 1000));
      text = `${find(confirm.id)?.name ?? "Chosen"} · ${confirm.source === "eeg" ? "relax, then OK again" : "OK again"} to cancel (${left} s)`;
    } else if (items.length) {
      if (gaze.calibrated && !gaze.face) text = "Can't see your face in the webcam";
      else if (gazed === null) text = `Look at ${what}`;
      else text = `Send OK: ${find(gazed)?.name ?? ""}`;
    }
    onPrompt(text);
  }

  // Typical distance between neighbouring items on screen, so the reach scales with the zoom.
  function spacing() {
    if (items.length < 2) return 400;
    const pts = items.map((i) => i.screen());
    const nearest = pts.map((p, i) => Math.min(...pts.filter((_, j) => j !== i).map((q) => Math.hypot(p.x - q.x, p.y - q.y))));
    return nearest.reduce((s, d) => s + d, 0) / nearest.length;
  }

  function tick(now) {
    if (note && now > note.until) {
      note = null;
      prompt();
    }
    if (confirm) {
      prompt();
      return;
    }
    if (!items.length) return;
    const p = point();
    const lost = !p || (gaze.calibrated && gaze.away);
    if (lost) {
      awaySince ??= now;
      if (gazed !== null && now - awaySince > HOLD_LOST_MS) setGazed(null, now);
      return;
    }
    awaySince = null;
    let best = null;
    let bestD = REACH * spacing();
    for (const item of items) {
      const s = item.screen();
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = item.id;
      }
    }
    const current = gazed !== null && find(gazed);
    if (current && best !== gazed) {
      const s = current.screen();
      if (bestD > SWITCH_RATIO * Math.hypot(s.x - p.x, s.y - p.y)) best = gazed; // not clearly closer: stay
    }
    if (best !== candidate) {
      candidate = best;
      candidateSince = now;
    }
    if (candidate !== gazed && now - candidateSince >= DWELL_MS) setGazed(candidate, now);
  }

  function cancelConfirm(message) {
    if (!confirm) return;
    clearTimeout(confirm.timer);
    confirm = null;
    onFocus(gazed, gazed === null ? null : "gaze");
    if (message) say(message);
    prompt();
  }

  // An OK from the headset ("eeg") or the space bar ("key"). seen(): where the eyes were just before it.
  function ok(source, seen = () => null) {
    if (confirm) {
      cancelConfirm("Cancelled");
      return;
    }
    if (!items.length) return;
    if (source === "eeg" && gaze.talking) return say("Talking: that OK was ignored");
    if (gaze.calibrated && gaze.away) return say("Look at the screen to choose");
    if (gazed === null) return say(`Look at ${what} first, then OK`);
    if (performance.now() - gazedSince < STEADY_MS) return say("Keep looking at it, then OK");
    const id = gazed;
    const item = find(id);
    const where = seen();
    onFocus(id, "confirm");
    const ms = CONFIRM_MS[source] ?? CONFIRM_MS.eeg;
    confirm = {
      id, source, until: performance.now() + ms,
      timer: setTimeout(() => {
        confirm = null;
        const target = item.screen();
        items = [];
        gazed = candidate = null;
        prompt();
        onChoose(id, { seen: where, target });
      }, ms),
    };
    prompt();
  }

  // Offer a new set of items (or none). Keeps nothing from the last set.
  function offer(list, description) {
    if (confirm) clearTimeout(confirm.timer);
    confirm = null;
    items = list;
    what = description;
    gazed = candidate = null;
    onFocus(null, null);
    prompt();
  }

  return {
    tick, ok, offer, say,
    escape: () => cancelConfirm("Cancelled"),
    get gazed() { return gazed; },
    get confirming() { return confirm?.id ?? null; },
    get active() { return items.length > 0; },
  };
}
