// Tic-tac-toe rules and the opponent's (deliberately bad) play.
// The board is an array of 9: "X", "O" or null, numbered as in layout.js (row 0 = far row).

export const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export function winner(board) {
  for (const line of LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return { mark: board[a], line };
  }
  if (board.every(Boolean)) return { mark: null, line: null }; // draw
  return null;
}

export const empties = (board) => board.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);

// Cells where `mark` would complete a line right now.
export function winningMoves(board, mark) {
  return empties(board).filter((i) => {
    const next = board.slice();
    next[i] = mark;
    return winner(next)?.mark === mark;
  });
}

const randomOf = (list, random) => list[Math.floor(random() * list.length)];

// The businessman's move. He knows the basics but gets distracted:
//   - an open win: he takes it, unless he's having a bad moment (half the mistake chance);
//   - your open win: he blocks it, unless he blunders (the full mistake chance);
//   - otherwise: a sensible square (centre, then corners) or, with the mistake chance, any square.
// Returns { cell, kind } where kind says what he meant to do (for his lines) and blunder says
// whether he skipped something better.
export function opponentMove(board, { mistake = 0.5, random = Math.random } = {}) {
  const open = empties(board);
  const wins = winningMoves(board, "O");
  const threats = winningMoves(board, "X");
  if (wins.length && random() > mistake / 2) return { cell: randomOf(wins, random), kind: "win", blunder: false };
  if (threats.length && random() > mistake) return { cell: randomOf(threats, random), kind: "block", blunder: false };
  const missed = wins.length ? "win" : threats.length ? "block" : null;
  if (random() < mistake) {
    // A random square that isn't the one he should have played (if there's another).
    const better = new Set([...wins, ...threats]);
    const pool = open.filter((i) => !better.has(i));
    return { cell: randomOf(pool.length ? pool : open, random), kind: "random", blunder: Boolean(missed), missed };
  }
  // He meant to play by position; it's only a blunder if that wasn't also the square he needed.
  const result = (cell, kind) => ({ cell, kind, blunder: Boolean(missed) && !wins.includes(cell) && !threats.includes(cell), missed });
  if (open.includes(4)) return result(4, "centre");
  const corners = [0, 2, 6, 8].filter((i) => open.includes(i));
  if (corners.length) return result(randomOf(corners, random), "corner");
  return result(randomOf(open, random), "edge");
}

// What he says while deciding, and after he plays.
export const LINES_THINKING = [
  "Let me circle back on this...", "Running the numbers...", "Leveraging my core competencies...",
  "Per my last email...", "Let's not boil the ocean here.", "Thinking outside the box. Literally.",
  "Synergizing...", "Let me loop in my brain.",
];
export const LINES_PLAYED = {
  win: ["Checkmate. Wait, wrong game.", "Closing the deal."],
  block: ["Not on my watch.", "Blocked. Like your promotion.", "Nice try, robot."],
  centre: ["Centre of the org chart. Obviously.", "Strategic positioning."],
  corner: ["A corner office. Naturally.", "Corner office energy."],
  edge: ["A bold pivot.", "Moving the needle."],
  random: ["Nailed it.", "Trust the process.", "Disruptive, right?", "That's what we call a paradigm shift.", "Bold move. Very bold."],
};
