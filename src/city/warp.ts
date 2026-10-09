// The city is laid out on a regular grid in "grid space" (u, v) and then
// bent into world space by a smooth shear warp:
//
//   x = u + ax(v)        z = v + az(u)
//
// so avenues become long meandering curves and intersections stop being
// right angles. Everything that knows about the grid (buildings, signs,
// lamps, traffic lanes, the flight path, ground road markings) applies the
// same warp. Must match src/shaders/warp.wgsl.
import type {Vec3} from '../math/vec';

const TAU = Math.PI * 2;
// [amplitude m, wavelength m, phase]
const AX: [number, number, number][] = [
  [150, 4300, 1.3],
  [55, 1900, 0.4],
  [18, 700, 2.2],
];
const AZ: [number, number, number][] = [
  [140, 4700, 2.1],
  [60, 2100, 5.0],
  [16, 650, 0.9],
];

// Flattened (amplitude, angular frequency, phase) triples: wave() is hot
// (city generation and sign placement call it millions of times).
const flat = (t: [number, number, number][]) =>
  Float64Array.from(t.flatMap(([a, l, p]) => [a, TAU / l, p]));
const AXF = flat(AX);
const AZF = flat(AZ);

function wave(t: number, terms: [number, number, number][]): number {
  const f = terms === AX ? AXF : AZF;
  return (
    f[0] * Math.sin(t * f[1] + f[2]) +
    f[3] * Math.sin(t * f[4] + f[5]) +
    f[6] * Math.sin(t * f[7] + f[8])
  );
}

function dwave(t: number, terms: [number, number, number][]): number {
  const f = terms === AX ? AXF : AZF;
  return (
    f[0] * f[1] * Math.cos(t * f[1] + f[2]) +
    f[3] * f[4] * Math.cos(t * f[4] + f[5]) +
    f[6] * f[7] * Math.cos(t * f[7] + f[8])
  );
}

export function warp(u: number, v: number): [number, number] {
  return [u + wave(v, AX), v + wave(u, AZ)];
}

export function warp3(p: Vec3): Vec3 {
  const [x, z] = warp(p[0], p[2]);
  return [x, p[1], z];
}

/** World direction of a grid-space direction (du, dv) at (u, v), normalized. */
export function warpDir(
  u: number,
  v: number,
  du: number,
  dv: number,
): [number, number] {
  const x = du + dwave(v, AX) * dv;
  const z = dv + dwave(u, AZ) * du;
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
}

/**
 * Rotation (radians, same convention as segment rotY) that best aligns a
 * grid-aligned box at (u, v) with the warped streets: the mean of the
 * rotations of the u axis and the v axis.
 */
export function warpAngle(u: number, v: number): number {
  const a1 = Math.atan(dwave(u, AZ));
  const a2 = -Math.atan(dwave(v, AX));
  return (a1 + a2) / 2;
}

/** Inverse warp (fixed-point iteration; converges since |slopes| < 1). */
export function unwarp(x: number, z: number): [number, number] {
  let u = x;
  let v = z;
  for (let k = 0; k < 8; k++) {
    u = x - wave(v, AX);
    v = z - wave(u, AZ);
  }
  return [u, v];
}

/** Max slope of either warp term (for sanity tests). */
export function maxSlope(): number {
  const m = (t: [number, number, number][]) =>
    t.reduce((s, [a, l]) => s + (a * TAU) / l, 0);
  return Math.max(m(AX), m(AZ));
}

/** WGSL constants generated from the same tables (see warp.wgsl). */
export const WARP_TERMS = {AX, AZ};
