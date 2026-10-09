// City layout: a grid of superblocks separated by wide avenues (the sky
// lanes the camera flies along), each split by a narrow street into 2x2
// blocks. Districts are chosen per superblock from low-frequency noise.
import {hashFloat} from '../math/random';

/** Distance between avenue centerlines. */
export const SUPER = 300;
/** Avenue width (open air for flight and traffic). */
export const AVENUE_W = 64;
/** Narrow street splitting each superblock into 2x2 blocks. */
export const STREET_W = 18;
/** Superblocks from the center to the edge of the city in each direction. */
export const CITY_RADIUS_SUPERS = 22;
export const CITY_HALF_SIZE = CITY_RADIUS_SUPERS * SUPER;

export const enum District {
  Core = 0, // downtown supertalls and landmarks
  Megablock = 1, // Mega-City One slabs
  Slum = 2, // Kowloon / Chongqing vertical slum
  Market = 3, // neon market canyons, LED facades
  Corporate = 4, // giant pyramids/monoliths
}

/** Smooth 2D value noise on the superblock grid. */
function gridNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const h = (a: number, b: number) => hashFloat(seed, a, b);
  const a = h(xi, zi);
  const b = h(xi + 1, zi);
  const c = h(xi, zi + 1);
  const d = h(xi + 1, zi + 1);
  return (
    a + (b - a) * s(fx) + (c - a) * s(fz) + (a - b - c + d) * s(fx) * s(fz)
  );
}

export interface SuperblockInfo {
  district: District;
  /** Overall height multiplier for this area. */
  heightScale: number;
}

export function superblockInfo(
  i: number,
  j: number,
  seed: number,
): SuperblockInfo {
  const cx = (i + 0.5) * SUPER;
  const cz = (j + 0.5) * SUPER;
  const r = Math.hypot(cx, cz) / CITY_HALF_SIZE;
  const n1 = gridNoise(i / 4.3, j / 4.3, seed + 11);
  const n2 = gridNoise(i / 2.1, j / 2.1, seed + 23);
  // Several downtown hubs: the center plus two satellites.
  const hubs: [number, number][] = [
    [0, 0],
    [9 * SUPER, -7 * SUPER],
    [-8 * SUPER, 10 * SUPER],
  ];
  let hub = 0;
  for (const [hx, hz] of hubs) {
    hub = Math.max(
      hub,
      Math.exp(-((cx - hx) ** 2 + (cz - hz) ** 2) / (2 * 1100 ** 2)),
    );
  }
  const heightScale = 0.55 + 0.9 * hub + 0.35 * n2 - 0.25 * r;
  let district: District;
  if (hashFloat(seed, i, j, 7) < 0.035 && hub < 0.6) {
    district = District.Corporate;
  } else if (hub > 0.55) {
    district = District.Core;
  } else if (n1 < 0.3) {
    district = District.Slum;
  } else if (n1 < 0.55) {
    district = District.Market;
  } else if (n1 < 0.75) {
    district = District.Megablock;
  } else {
    district = n2 > 0.5 ? District.Core : District.Market;
  }
  return {district, heightScale: Math.max(0.35, heightScale)};
}

/** Avenue centerline coordinate for index k. */
export const avenue = (k: number) => k * SUPER;

/** True if (x, z) lies within an avenue (open sky lane). */
export function inAvenue(x: number, z: number): boolean {
  const dx = Math.abs(x - Math.round(x / SUPER) * SUPER);
  const dz = Math.abs(z - Math.round(z / SUPER) * SUPER);
  return dx < AVENUE_W / 2 || dz < AVENUE_W / 2;
}
