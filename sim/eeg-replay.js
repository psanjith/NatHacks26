// Replays one person's real recorded SSVEP trials to choose which cube to pick.
// The file comes from tools/ssvep_train.py (Train) via sim/run.py at eeg/<user>.json.
// Each recorded trial carries the decision of a model that never saw it
// (cross-validated), so a wrong or unsure pick here is what would have happened live.

const shuffle = (list) => {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};
const hz = (f) => `${Number(f).toFixed(2).replace(/\.?0+$/, "")} Hz`;

export async function loadReplay(user) {
  const response = await fetch(`eeg/${user}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`no recorded EEG for ${user} yet: run tools/ssvep_train.py --user ${user} and press Train`);
  return response.json();
}

export function createEegChooser(replay) {
  const pools = replay.freqs.map((_, i) => shuffle(replay.trials.filter((t) => t.freq_index === i)));
  const used = pools.map(() => 0);
  const tally = { n: 0, right: 0, wrong: 0, unsure: 0 };

  // onTable: detected cubes in the order the camera tab gives them frequencies.
  // reachable: those the arm can reach (same ids). Returns the cube to pick, or none.
  function choose({ onTable, reachable }) {
    const flickering = Math.min(onTable.length, replay.freqs.length);
    const indexOf = (target) => onTable.findIndex((t) => t.id === target.id);
    const options = reachable.filter((t) => indexOf(t) < flickering && pools[indexOf(t)].length);
    if (!options.length) return { target: null, line: "No recorded EEG for the cubes in view", trial: null };
    const intended = options[Math.floor(Math.random() * options.length)];
    const i = indexOf(intended);
    const trial = pools[i][used[i]++ % pools[i].length];
    tally.n += 1;
    const looked = `${replay.user} looked at the ${hz(replay.freqs[i])} cube`;
    if (!trial.accepted) {
      tally.unsure += 1;
      return { target: null, intended, trial, line: `${looked}. Decoder wasn't sure, so the arm waits.` };
    }
    const predicted = trial.pred_index < flickering ? onTable[trial.pred_index] : null;
    const target = predicted && reachable.find((t) => t.id === predicted.id);
    if (trial.correct) tally.right += 1;
    else tally.wrong += 1;
    const said = `decoder said ${hz(replay.freqs[trial.pred_index])}`;
    if (!target) {
      return { target: null, intended, trial, line: `${looked}; ${said}, but no reachable cube has that frequency. Arm waits.` };
    }
    return { target, intended, trial, line: `${looked}; ${said} ${trial.correct ? "✓" : "✗ (wrong cube)"}.` };
  }

  return { choose, tally, replay };
}

// Draws the replayed Oz signal (µV, 100 samples/s) as a small trace.
export function drawTrace(canvas, trace) {
  canvas.hidden = false;
  const ratio = Math.min(window.devicePixelRatio, 2);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!trace?.length) return;
  const sorted = trace.map(Math.abs).sort((a, b) => a - b);
  const scale = Math.max(5, sorted[Math.floor(sorted.length * 0.95)]);
  ctx.strokeStyle = "#4db0ff";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  trace.forEach((v, k) => {
    const x = (width * k) / (trace.length - 1);
    const y = height / 2 - (Math.max(-1, Math.min(1, v / scale)) * height) / 2.3;
    if (k) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = "#a9afb8";
  ctx.font = "10px -apple-system, sans-serif";
  ctx.fillText(`Oz, ±${Math.round(scale)} µV`, 4, 11);
}
