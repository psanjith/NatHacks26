// Tic-tac-toe table, in the arm's frame like the cube sim: +x forward (towards the opponent),
// +y left, z up, metres. The arm's plywood mount is 12.7 mm thick with its top at z = 0.

export { MARKERS, MARKER_DIAMETER, TABLE_Z, BOARD_SIZE as MOUNT_SIZE } from "../layout.js";
import { TABLE_Z } from "../layout.js";

// A shorter table than the cube sim's: the opponent sits at its far end, close enough to reach the board.
export const TABLE = { minX: -0.32, maxX: 0.46, halfY: 0.5, thickness: 0.035, height: 0.74 };

// The game board: a 3 x 3 grid in front of the arm, centred on its reach band. The cell pitch fits a
// 36 mm piece with room for the open fingers on both sides, and every cell is within 28 cm of the base.
export const GRID = { x: 0.22, y: 0, pitch: 0.052, border: 0.016, thickness: 0.006 };
export const GRID_SIZE = GRID.pitch * 3 + GRID.border * 2;
export const BOARD_TOP = TABLE_Z + GRID.thickness;

// Cells are numbered 0-8 as the person sees them from behind the arm: row 0 is the far row
// (the opponent's side), column 0 is on the left (+y).
export function cellCenter(index) {
  const row = Math.floor(index / 3);
  const col = index % 3;
  return { x: GRID.x + (1 - row) * GRID.pitch, y: GRID.y + (1 - col) * GRID.pitch };
}

export function cellAt(x, y, margin = 0.5) {
  const col = Math.round((GRID.y - y) / GRID.pitch + 1);
  const row = Math.round((GRID.x - x) / GRID.pitch + 1);
  if (row < 0 || row > 2 || col < 0 || col > 2) return -1;
  const c = cellCenter(row * 3 + col);
  if (Math.abs(c.x - x) > GRID.pitch * margin || Math.abs(c.y - y) > GRID.pitch * margin) return -1;
  return row * 3 + col;
}

// Green stickers on the board's four corners: four more points for the table camera's calibration,
// near the middle of its image (the mount's stickers are near its bottom edge).
export const BOARD_MARKER_DIAMETER = 0.012;
export const BOARD_MARKERS = [[1, 1], [1, -1], [-1, -1], [-1, 1]]
  .map(([sx, sy]) => ({ x: GRID.x + sx * (GRID_SIZE / 2 - 0.008), y: GRID.y + sy * (GRID_SIZE / 2 - 0.008) }));

export const onBoard = (x, y) => Math.abs(x - GRID.x) < GRID_SIZE / 2 && Math.abs(y - GRID.y) < GRID_SIZE / 2;

// Pieces: an X is two crossed bars, an O a ring. Both 36 mm across and 9 mm thick, so the open claw
// (about 60 mm) closes on either with room to spare.
export const X_PIECE = { length: 0.036, width: 0.009, height: 0.009, color: "#e8412f" };
export const O_PIECE = { outer: 0.018, inner: 0.0095, height: 0.009, segments: 12, color: "#16b3c4" };

// The arm's X pieces wait on the table to its right, in three short rows pointing at the base, so the
// fingers (which close sideways, across the arm) never sweep a neighbour. Each X is turned so the
// fingers close across its diagonal, into the notches between its arms.
export const X_SUPPLY = [
  { yaw: -38, r: 0.21 }, { yaw: -38, r: 0.26 },
  { yaw: -60, r: 0.21 }, { yaw: -60, r: 0.26 },
  { yaw: -82, r: 0.21 },
];
// Scatter: X's thrown anywhere on the arm's right (the X side, nearest the camera) that it can pick
// them from: on the table (not the board), 17-28 cm from the base, at any angle, clear of the board's
// edge and of each other by enough for the open fingers. main.js also keeps them inside the camera's
// frame, below the prompt.
export const X_SCATTER = { minR: 0.17, maxR: 0.28, yawRanges: [[-100, -20]], minGap: 0.068, boardClearance: 0.035, mountClearance: 0.022 };
// Seen from above, the fingers close about this far (degrees) anticlockwise of the arm's heading.
export const CLOSING_OFFSET = 95;

// The opponent's O pieces, in a tray at his right hand (+y, on his side of the board).
export const O_TRAY = { x: 0.395, y: 0.2, pitch: 0.044 };
export const O_SUPPLY = [[-0.5, -1], [-0.5, 0], [-0.5, 1], [0.5, -0.5], [0.5, 0.5]]
  .map(([i, j]) => ({ x: O_TRAY.x + i * O_TRAY.pitch, y: O_TRAY.y + j * O_TRAY.pitch }));

// The opponent: a short cartoon figure (scale: his model's units to metres) on an office chair whose
// seat is this far below the table top, so his knees fit under it, centred on the board's line.
export const OPPONENT = { x: 0.61, y: 0, seatBelowTable: 0.22, scale: 0.72 };

// The table camera: the only camera. The arm finds pieces in its image, and the person plays from that
// same image (the camera tab): its whole frame is the player view, and the board view and the zoom onto
// the X's are crops of it, never a second camera or a re-render. It's modelled on a 4K webcam (a Logitech
// Brio 4K, say) set to its 78° diagonal field of view. ?camera=1080p in the address (both tabs) makes it
// an ordinary 1080p webcam with the same lens (a Logitech C920) instead, for slower computers.
// The camera tab draws it every screen frame for smooth motion (a real Brio gives 30 a second at 4K).
// The piece detector works on the frame scaled to 1080p, as a real pipeline would: at 4K it took up
// to 0.3 s, which froze the sim, for no useful gain in accuracy.
// Where: 90 cm above the table on a pole clamped to its right-hand edge, level with the arm's back,
// looking down (53°) and across (67° left of straight ahead). Chosen by searching positions a pole can
// reach for the one that shows the board biggest while the whole frame still holds the arm (parked, and
// holding an X up high), all five X's, the board, the O tray and his face, and where the arm never stands
// between the camera and a square: each square is then about 106 camera pixels across (53 at 1080p).
const CAMERAS = {
  "4k": { model: "4K webcam, 78° diagonal field of view (like a Logitech Brio 4K)", width: 3840, height: 2160 },
  "1080p": { model: "1080p webcam, 78° diagonal field of view (like a Logitech C920)", width: 1920, height: 1080 },
};
const chosen = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("camera");
export const CAMERA = {
  ...(CAMERAS[chosen] ?? CAMERAS["4k"]),
  diagonalFov: 78,
  detect: { width: 1920, height: 1080 },
  lens: { x: -0.2, y: -0.45, z: 0.9 },
  aim: { x: 0.065, y: 0.174, z: 0 },
};
// Vertical field of view (degrees) of that sensor and lens, which is what a pinhole camera model takes.
export const CAMERA_VFOV = (2 * Math.atan(Math.tan((CAMERA.diagonalFov * Math.PI) / 360) * CAMERA.height / Math.hypot(CAMERA.width, CAMERA.height)) * 180) / Math.PI;

export function supplyPose(slot) {
  const yaw = (slot.yaw * Math.PI) / 180;
  return { x: slot.r * Math.cos(yaw), y: slot.r * Math.sin(yaw), yaw: yaw + ((CLOSING_OFFSET - 45) * Math.PI) / 180 };
}
