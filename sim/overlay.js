// Draws detected objects over the camera view, and flickers them for SSVEP.
// Flicker is counted in display frames (assumes a 60 Hz screen): a target is
// white while (frame % period) < on, black otherwise.
//
// Eye-tracker mode ("gaze"): every box is grey, the one being looked at is yellow, the one picked
// (clench) turns green. Boxes the arm can't reach are dimmed and can't be picked.
const FREQUENCIES = [
  { hz: "7.5", period: 8, on: 4 },
  { hz: "8.57", period: 7, on: 4 },
  { hz: "10", period: 6, on: 3 },
  { hz: "12", period: 5, on: 3 },
];
const FULL_VIEW = { x0: 0, y0: 0, s: 1 };

export function createOverlay(parent) {
  const canvas = document.createElement("canvas");
  canvas.className = "overlay";
  parent.append(canvas);
  const ctx = canvas.getContext("2d");
  let width = 0;
  let height = 0;
  let targets = [];
  let selected = null;
  let flickering = false;
  let frame = 0;
  let mode = null;
  let gazed = null;
  let reachable = null; // Set of ids, or null = all
  let view = FULL_VIEW; // shown part of the image (0-1 coordinates), for zooming in on the cubes

  // Image coordinates (0-1) -> canvas CSS pixels, through the current zoom.
  const P = (x, y) => [((x - view.x0) / view.s) * width, ((y - view.y0) / view.s) * height];

  function resize(cssWidth, cssHeight) {
    const ratio = Math.min(window.devicePixelRatio, 2);
    width = cssWidth;
    height = cssHeight;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  }

  function tracePatch(target) {
    ctx.beginPath();
    target.hull.forEach(([x, y], index) => {
      const [px, py] = P(x, y);
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
  }

  function label(target, text) {
    ctx.font = "600 12px -apple-system, BlinkMacSystemFont, sans-serif";
    const textWidth = ctx.measureText(text).width;
    const [cx] = P(target.center[0], 0);
    const [, by] = P(0, target.box[3]);
    const x = cx - textWidth / 2 - 5;
    const y = by + 4;
    ctx.fillStyle = "rgba(24, 27, 32, 0.86)";
    ctx.fillRect(x, y, textWidth + 10, 18);
    ctx.fillStyle = "#f1f2f4";
    ctx.fillText(text, x + 5, y + 13);
  }

  function paint(fill, stroke, lineWidth, dash = []) {
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.setLineDash(dash);
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawGaze() {
    for (const target of targets) {
      tracePatch(target);
      const canPick = !reachable || reachable.has(target.id);
      if (target.id === selected) paint("rgba(80, 220, 140, 0.55)", "#50dc8c", 4);
      else if (!canPick) paint("rgba(40, 42, 46, 0.55)", "#6b7078", 2, [5, 4]);
      else if (target.id === gazed) paint("rgba(255, 207, 110, 0.6)", "#ffcf6e", 4);
      else paint("rgba(160, 164, 170, 0.5)", "#a9afb8", 2);
      label(target, canPick ? `${target.id}` : `${target.id} · out of reach`);
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    if (!targets.length) return;
    if (mode === "gaze" && !flickering) {
      drawGaze();
      return;
    }
    if (flickering) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.6)"; // dim the live view to ~40%
      ctx.fillRect(0, 0, width, height);
    }
    for (const target of targets) {
      tracePatch(target);
      if (flickering && target.frequency) {
        const { period, on } = target.frequency;
        ctx.fillStyle = frame % period < on ? "#ffffff" : "#000000";
        ctx.fill();
      } else if (flickering) {
        ctx.fillStyle = "rgba(120, 124, 130, 0.7)"; // more targets than frequencies
        ctx.fill();
      } else if (target.id === selected) {
        paint("rgba(255, 207, 110, 0.45)", "#ffcf6e", 3);
      } else {
        paint(target.frequency ? "rgba(77, 176, 255, 0.35)" : "rgba(160, 164, 170, 0.35)", target.frequency ? "#4db0ff" : "#a9afb8", 2);
      }
      label(target, target.frequency ? `${target.id} · ${target.frequency.hz} Hz` : `${target.id}`);
    }
  }

  function tick() {
    if (!flickering) return;
    frame += 1;
    draw();
    requestAnimationFrame(tick);
  }

  return {
    resize,
    setTargets(list, selectedId = null, options = {}) {
      targets = list.map((target, index) => ({ ...target, frequency: FREQUENCIES[index] ?? null }));
      selected = selectedId;
      mode = options.mode ?? null;
      reachable = options.reachable ? new Set(options.reachable) : null;
      if (!targets.some((t) => t.id === gazed)) gazed = null;
      if (!targets.length) flickering = false;
      draw();
    },
    setFlicker(on) {
      const start = on && targets.length > 0 && !flickering;
      flickering = on && targets.length > 0;
      if (start) {
        frame = 0;
        requestAnimationFrame(tick);
      }
      draw();
      return flickering;
    },
    setMode(next) {
      mode = next;
      draw();
    },
    setGazed(id) {
      if (id === gazed) return;
      gazed = id;
      draw();
    },
    setSelected(id) {
      selected = id;
      draw();
    },
    setView(next) {
      view = next ?? FULL_VIEW;
      draw();
    },
    // Where a target's centre is on screen (CSS px of the window).
    screenCenter(target) {
      const rect = canvas.getBoundingClientRect();
      const [x, y] = P(target.center[0], target.center[1]);
      return [rect.left + x, rect.top + y];
    },
    canPick(target) {
      return !reachable || reachable.has(target.id);
    },
    get rect() {
      return canvas.getBoundingClientRect();
    },
    get targets() {
      return targets;
    },
    get selected() {
      return selected;
    },
    get mode() {
      return mode;
    },
    get flickering() {
      return flickering;
    },
    frequencyCount: FREQUENCIES.length,
  };
}
