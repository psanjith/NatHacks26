// Live EEG time series (like the OpenBCI GUI): the last few seconds of each channel, one row each,
// scrolling. Each row scales itself to its own resting level (median over the window), so resting
// signal fills a narrow band and a jaw clench shoots past it. On the right: how far each clench
// channel is above resting right now, yellow when it's over its pick threshold.
// With eye-corner electrodes (--montage face) an extra row shows left-right eye movement, with the
// glance thresholds dashed.

const SHOW_S = 5;
const COLORS = ["#7aa2ff", "#4dd6c1", "#c792ea", "#ffb86b"];
const EYE_COLOR = "#ff7eb6";

export function createWaves(canvas) {
  const ctx = canvas.getContext("2d");
  let names = ["O1", "Oz", "O2", "T7"];
  let rows = names.map(() => new Float32Array(SHOW_S * 200));
  let filled = 0;
  let eye = null; // { buf, filled, amp }
  let clench = null;
  let flashUntil = 0;
  let glanceNote = null; // { text, until }
  let message = "Waiting for the headset…";

  function push(live) {
    if (!live) return;
    if (live.names.length !== rows.length || rows[0].length !== SHOW_S * live.fs || live.names.join() !== names.join()) {
      names = live.names;
      rows = names.map(() => new Float32Array(SHOW_S * live.fs));
      filled = 0;
    }
    clench = live.clench;
    message = live.imp?.on ? "Impedance check running: EEG paused" : live.imp?.settling ? "EEG resuming after the impedance check…" : null;
    const data = live.wave.data;
    const n = data[0]?.length ?? 0;
    if (n) {
      const L = rows[0].length;
      rows.forEach((row, c) => {
        const add = Float32Array.from(data[c].slice(-L));
        row.copyWithin(0, add.length);
        row.set(add, L - add.length);
      });
      filled = Math.min(L, filled + n);
    }
    const e = live.eog;
    if (!e?.available) {
      eye = null;
      return;
    }
    if (!eye) eye = { buf: new Float32Array(SHOW_S * e.trace.fs), filled: 0, amp: null };
    eye.amp = e.amp;
    const add = Float32Array.from(e.trace.data.slice(-eye.buf.length));
    if (add.length) {
      eye.buf.copyWithin(0, add.length);
      eye.buf.set(add, eye.buf.length - add.length);
      eye.filled = Math.min(eye.buf.length, eye.filled + add.length);
    }
  }

  const flash = () => (flashUntil = performance.now() + 500);
  const glance = (direction) => (glanceNote = { text: direction === "left" ? "◀ left" : "right ▶", until: performance.now() + 700 });

  function trace(buf, count, x0, w, mid, scale, color) {
    const L = buf.length;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(L / w / 2));
    for (let i = L - count; i < L; i += step) {
      const x = x0 + (w * i) / (L - 1);
      const y = mid - buf[i] * scale;
      if (i === L - count) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function draw() {
    const ratio = Math.min(window.devicePixelRatio, 2);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = performance.now() < flashUntil ? "rgba(80, 220, 140, 0.18)" : "rgba(0, 0, 0, 0.25)";
    ctx.fillRect(0, 0, width, height);
    const labelW = 48;
    const valueW = 58;
    const plotW = width - labelW - valueW;
    const nRows = rows.length + (eye ? 1 : 0);
    const rowH = height / nRows;
    const bold = "600 12px -apple-system, BlinkMacSystemFont, sans-serif";
    const small = "10px -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    const rowFrame = (r, name, tag, tagColor) => {
      const mid = rowH * r + rowH / 2;
      ctx.font = bold;
      ctx.fillStyle = tag ? "#f1f2f4" : "#a9afb8";
      ctx.fillText(name, 8, mid - (tag ? 5 : 0));
      if (tag) {
        ctx.font = small;
        ctx.fillStyle = tagColor;
        ctx.fillText(tag, 8, mid + 8);
      }
      ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
      ctx.beginPath();
      ctx.moveTo(labelW, rowH * (r + 1));
      ctx.lineTo(width, rowH * (r + 1));
      ctx.stroke();
      return mid;
    };
    rows.forEach((row, c) => {
      const used = clench?.used?.includes(names[c]);
      const mid = rowFrame(c, names[c], used ? "jaw" : null, "#ffcf6e");
      if (filled < 2) return;
      const seen = row.subarray(row.length - filled);
      const sorted = Float32Array.from(seen, Math.abs).sort();
      const typical = Math.max(1, sorted[Math.floor(sorted.length / 2)]); // median |x|
      ctx.save();
      ctx.beginPath();
      ctx.rect(labelW, rowH * c, plotW, rowH);
      ctx.clip();
      trace(row, filled, labelW, plotW, mid, (rowH * 0.42) / (typical * 4), COLORS[c % COLORS.length]);
      ctx.restore();
      ctx.font = small;
      ctx.fillStyle = "#6b7078";
      ctx.fillText(`±${Math.round(typical * 4)} µV`, labelW + 4, rowH * c + 8);
      const r = clench?.ratios?.[c];
      const thr = clench?.thresholds?.[c];
      if (r != null && clench.ready && used) {
        ctx.font = bold;
        ctx.fillStyle = thr != null && r >= thr ? "#ffcf6e" : "#a9afb8";
        ctx.fillText(`${r.toFixed(1)}×`, width - valueW + 10, mid);
      }
    });
    if (eye) {
      const r = rows.length;
      const mid = rowFrame(r, "Eyes", "L − R", EYE_COLOR);
      if (eye.filled > 1) {
        const seen = eye.buf.subarray(eye.buf.length - eye.filled);
        const big = eye.amp ? Math.max(Math.abs(eye.amp.left), Math.abs(eye.amp.right)) : Math.max(20, ...Array.from(seen, Math.abs));
        const scale = (rowH * 0.45) / (big * 1.2);
        ctx.save();
        ctx.beginPath();
        ctx.rect(labelW, rowH * r, plotW, rowH);
        ctx.clip();
        if (eye.amp) {
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = "rgba(255, 126, 182, 0.45)";
          for (const a of [eye.amp.left, eye.amp.right]) {
            ctx.beginPath();
            ctx.moveTo(labelW, mid - 0.5 * a * scale);
            ctx.lineTo(labelW + plotW, mid - 0.5 * a * scale);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }
        trace(eye.buf, eye.filled, labelW, plotW, mid, scale, EYE_COLOR);
        ctx.restore();
      }
      if (glanceNote && performance.now() < glanceNote.until) {
        ctx.font = bold;
        ctx.fillStyle = EYE_COLOR;
        ctx.fillText(glanceNote.text, width - valueW + 4, mid);
      } else if (!eye.amp) {
        ctx.font = small;
        ctx.fillStyle = "#6b7078";
        ctx.fillText("not checked", width - valueW + 4, mid);
      }
    }
    if (message) {
      ctx.font = bold;
      ctx.fillStyle = "rgba(24, 27, 32, 0.8)";
      ctx.fillRect(labelW, height / 2 - 14, plotW, 28);
      ctx.fillStyle = "#f1f2f4";
      ctx.textAlign = "center";
      ctx.fillText(message, labelW + plotW / 2, height / 2);
      ctx.textAlign = "left";
    }
  }

  function loop() {
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  return { push, flash, glance, setMessage: (text) => (message = text) };
}
