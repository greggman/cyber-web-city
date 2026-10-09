// Placement of giant ad screens (on big avenue-facing facades) and
// building-sized holograms (on landmark roofs and over plazas).
import {Rng} from '../math/random';
import type {Vec3} from '../math/vec';
import type {FacadeSlot} from './buildings';
import {NEON} from './buildings';
import {District, SUPER} from './layout';

export const AD_TILES = 32;
export const AD_SCENES = 8;

export interface Screen {
  pos: Vec3;
  right: Vec3;
  normal: Vec3;
  width: number;
  height: number;
  tile: number;
}

export interface Hologram {
  pos: Vec3;
  scale: number;
  kind: number;
  color: Vec3;
  color2: Vec3;
  rot: number;
}

export interface AdTile {
  scene: number;
  colorA: Vec3;
  colorB: Vec3;
  glyphs: number[];
}

export function generateAds(
  seed: number,
  slots: FacadeSlot[],
  roofs: [number, number, number, number][],
  landmarks: [number, number, number][],
  brandGlyphs: (rng: Rng) => number[],
  isClear: (
    x: number,
    z: number,
    r: number,
    y0: number,
    y1: number,
  ) => boolean = () => true,
): {screens: Screen[]; holograms: Hologram[]; tiles: AdTile[]} {
  const rng = new Rng(seed, 5150);
  const tiles: AdTile[] = [];
  for (let i = 0; i < AD_TILES; i++) {
    const a = rng.pick(NEON);
    let b = rng.pick(NEON);
    if (b === a) b = NEON[(NEON.indexOf(a) + 3) % NEON.length];
    tiles.push({
      scene: i % AD_SCENES,
      colorA: a,
      colorB: b,
      glyphs: brandGlyphs(rng),
    });
  }
  const screens: Screen[] = [];
  for (const s of slots) {
    if (!s.avenue || s.width < 28 || s.height < 30) continue;
    const p =
      s.district === District.Core
        ? 0.22
        : s.district === District.Market
          ? 0.3
          : 0.1;
    if (!rng.chance(p)) continue;
    const vertical = rng.chance(0.35);
    let w = Math.min(
      s.width * 0.85,
      vertical ? rng.range(18, 40) : rng.range(35, 110),
    );
    let h = vertical
      ? Math.min(s.height * 0.9, w * rng.range(1.5, 3))
      : w * rng.range(0.45, 0.65);
    if (h > s.height * 0.9) {
      h = s.height * 0.9;
      w = Math.min(w, vertical ? h / 1.5 : h * 2.2);
    }
    if (w < 12 || h < 8) continue;
    const y = s.y + h / 2 + rng.next() * Math.max(0, s.height - h);
    const along = rng.range(-0.5, 0.5) * Math.max(0, s.width - w);
    const right: Vec3 = [s.nz, 0, -s.nx];
    screens.push({
      pos: [
        s.x + right[0] * along + s.nx * 0.6,
        y,
        s.z + right[2] * along + s.nz * 0.6,
      ],
      right,
      normal: [s.nx, 0, s.nz],
      width: w,
      height: h,
      tile: rng.int(0, AD_TILES),
    });
  }
  const holograms: Hologram[] = [];
  // On the tallest roofs.
  const tall = roofs
    .filter(r => r[1] > 250 && r[3] > 25)
    .sort((a, b) => b[1] - a[1]);
  for (const r of tall.slice(0, 40)) {
    if (!rng.chance(0.7)) continue;
    const scale = rng.range(50, 110);
    // Keep clear of neighbouring towers (the roof itself is below y0).
    if (!isClear(r[0], r[2], scale * 0.6, r[1] + 1, r[1] + scale * 2.3))
      continue;
    const c = rng.pick(NEON);
    const c2 = rng.pick(NEON);
    holograms.push({
      pos: [r[0], r[1], r[2]],
      scale,
      kind: rng.int(0, 5),
      color: c,
      color2: c2,
      rot: rng.range(0, Math.PI * 2),
    });
  }
  // Giant ones rising beside landmarks.
  // Giants standing in the avenue intersections near landmarks (open air).
  for (const [x, , z] of landmarks) {
    const ix = Math.round(x / SUPER) * SUPER;
    const iz = Math.round(z / SUPER) * SUPER;
    const scale = rng.range(150, 260);
    if (!isClear(ix, iz, scale * 0.3, 0, scale * 2.3)) continue;
    holograms.push({
      pos: [ix, 0, iz],
      scale,
      kind: rng.pick([0, 1, 3]),
      color: rng.pick(NEON),
      color2: rng.pick(NEON),
      rot: rng.range(0, Math.PI * 2),
    });
  }
  return {screens, holograms, tiles};
}
