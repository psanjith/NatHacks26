// Everything on the table, in the arm's frame: +x forward, +y left, metres.
// yaw (degrees) and r (metres) are measured from the arm's base axis, so
// yaw 0 is straight ahead and +90 is the arm's left.

// The arm's plywood mount is 12.7 mm thick with its top at z = 0, so the table
// surface sits below the arm's origin.
export const TABLE_Z = -0.0127;

export const REACH = { minR: 0.15, maxR: 0.28 };

// Every object is a cube with this edge length.
export const CUBE_SIZE = 0.04;

export const OBJECTS = [
  { id: "bowl_left", yaw: 50, r: 0.23, color: "#2f7fc1" },
  { id: "bowl_center", yaw: 0, r: 0.21, color: "#e0a526" },
  { id: "bowl_right", yaw: -50, r: 0.23, color: "#c8453b" },
  { id: "token_rack", yaw: -82, r: 0.205, color: "#3a3f47" },
  { id: "apple", yaw: 25, r: 0.19, color: "#b8302a" },
  { id: "orange", yaw: -25, r: 0.19, color: "#ee8a1d" },
  { id: "cup", yaw: -22, r: 0.27, color: "#f1ede4" },
  { id: "bottle", yaw: 22, r: 0.27, color: "#58a9b8" },
  { id: "foam_ball", yaw: 79, r: 0.21, color: "#7cc04b" },
  { id: "soda_can", yaw: 68, r: 0.275, color: "#8d3fa8" },
  { id: "wood_block", yaw: -68, r: 0.28, color: "#c79a62" },
];

export function positionOf(object) {
  const yaw = (object.yaw * Math.PI) / 180;
  return [object.r * Math.cos(yaw), object.r * Math.sin(yaw), TABLE_Z];
}
