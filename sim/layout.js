// Everything on the table, in the arm's frame: +x forward, +y left, metres.
// yaw (degrees) and r (metres) are measured from the arm's base axis, so
// yaw 0 is straight ahead and +90 is the arm's left.

// The arm's plywood mount is 12.7 mm thick with its top at z = 0, so the table
// surface sits below the arm's origin.
export const TABLE_Z = -0.0127;

export const REACH = { minR: 0.15, maxR: 0.28 };

// Every object is a cube with this edge length.
export const CUBE_SIZE = 0.04;

// Four cubes, one per SSVEP flicker frequency, on an arc inside the reach band.
// About 11 cm apart, and clear of the arm's park pose at yaw -90.
export const OBJECTS = [
  { id: "cube_red", yaw: 45, r: 0.22, color: "#c8453b" },
  { id: "cube_blue", yaw: 15, r: 0.22, color: "#2f7fc1" },
  { id: "cube_green", yaw: -15, r: 0.22, color: "#5aa83f" },
  { id: "cube_yellow", yaw: -45, r: 0.22, color: "#e0a526" },
];

// The arm's plywood mount: 25 cm square, centred on the base, top at z = 0.
export const BOARD_SIZE = 0.25;

// Calibration stickers on the board's corners. The camera finds them to work out
// where it is. The cyan one marks the front-left corner so the four can be told apart.
export const MARKER_DIAMETER = 0.025;
export const MARKERS = [
  { id: "front_left", x: 0.105, y: 0.105, color: "#00d8ff" },
  { id: "back_left", x: -0.105, y: 0.105, color: "#ff2bd6" },
  { id: "back_right", x: -0.105, y: -0.105, color: "#ff2bd6" },
  { id: "front_right", x: 0.105, y: -0.105, color: "#ff2bd6" },
]; // counter-clockwise seen from above, starting at the cyan one

// Open basket on the claw's side of the arm (the claw sits right of the arm's
// centre line, so the arm reaches further to its right than its left), far
// enough out that the claw can rise well above its rim.
export const BASKET = { x: 0.05, y: -0.24, size: 0.1, height: 0.05, wall: 0.004 };

// Where Scatter drops cubes: inside reach, in camera view, off the board,
// clear of the basket and of each other. Closer than ~20 cm the arm can't
// lift a cube clear of the others (shoulder and elbow limits).
export const SCATTER = { minR: 0.205, maxR: 0.27, minYaw: -60, maxYaw: 55, minGap: 0.075, basketClearance: 0.045 };

export function positionOf(object) {
  const yaw = (object.yaw * Math.PI) / 180;
  return [object.r * Math.cos(yaw), object.r * Math.sin(yaw), TABLE_Z];
}
