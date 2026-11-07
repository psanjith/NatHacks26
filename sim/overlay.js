// Draws detected objects over the camera view, and flickers them for SSVEP.
// Flicker is counted in display frames (assumes a 60 Hz screen): a target is
// white while (frame % period) < on, black otherwise.
const FREQUENCIES = [
  { hz: "7.5", period: 8, on: 4 },
  { hz: "8.57", period: 7, on: 4 },
  { hz: "10", period: 6, on: 3 },
  { hz: "12", period: 5, on: 3 },
];

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
      if (index === 0) ctx.moveTo(x * width, y * height);
      else ctx.lineTo(x * width, y * height);
    });
    ctx.closePath();
  }

  function label(target) {
    const text = target.frequency ? `${target.id} · ${target.frequency.hz} Hz` : `${target.id}`;
    ctx.font = "600 12px -apple-system, BlinkMacSystemFont, sans-serif";
    const textWidth = ctx.measureText(text).width;
    const x = target.center[0] * width - textWidth / 2 - 5;
    const y = target.box[3] * height + 4;
    ctx.fillStyle = "rgba(24, 27, 32, 0.86)";
    ctx.fillRect(x, y, textWidth + 10, 18);
    ctx.fillStyle = "#f1f2f4";
    ctx.fillText(text, x + 5, y + 13);
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    if (!targets.length) return;
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
        ctx.fillStyle = "rgba(255, 207, 110, 0.45)";
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#ffcf6e";
        ctx.stroke();
      } else {
        ctx.fillStyle = target.frequency ? "rgba(77, 176, 255, 0.35)" : "rgba(160, 164, 170, 0.35)";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = target.frequency ? "#4db0ff" : "#a9afb8";
        ctx.stroke();
      }
      label(target);
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
    setTargets(list, selectedId = null) {
      targets = list.map((target, index) => ({ ...target, frequency: FREQUENCIES[index] ?? null }));
      selected = selectedId;
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
    get targets() {
      return targets;
    },
    frequencyCount: FREQUENCIES.length,
  };
}
