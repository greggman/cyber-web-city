// City generator: superblocks -> blocks -> lots -> building archetypes.
import {Rng} from '../math/random';
import {SegFlags, SegmentList, Style, packColor} from './segments';
import {
  AVENUE_W,
  CITY_RADIUS_SUPERS,
  CITY_HALF_SIZE,
  District,
  STREET_W,
  SUPER,
  superblockInfo,
} from './layout';
import {
  type BuildCtx,
  type FacadeSlot,
  type Lot,
  bridgedCluster,
  cylinderTower,
  gateTower,
  ledSlab,
  megablock,
  neon,
  pearlTower,
  pyramid,
  seg,
  setbackTower,
  slumStack,
  twistTower,
  wedgeTower,
} from './buildings';

/** An axis-aligned box over an avenue that the flight path must avoid. */
export interface Obstacle {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y0: number;
  y1: number;
}

export interface CityData {
  seed: number;
  segments: SegmentList;
  slots: FacadeSlot[];
  roofs: [number, number, number, number][];
  obstacles: Obstacle[];
  /** Tallest landmarks: [x, height, z]. */
  landmarks: [number, number, number][];
}

function splitLots(rng: Rng, lot: Lot, minSize: number, maxSplits: number): Lot[] {
  const out: Lot[] = [];
  const recurse = (l: Lot, depth: number) => {
    const w = l.x1 - l.x0;
    const d = l.z1 - l.z0;
    if (depth >= maxSplits || (w < minSize * 2 && d < minSize * 2) || (depth > 0 && rng.chance(0.25))) {
      out.push(l);
      return;
    }
    if (w >= d && w >= minSize * 2) {
      const s = l.x0 + w * rng.range(0.38, 0.62);
      recurse({...l, x1: s}, depth + 1);
      recurse({...l, x0: s}, depth + 1);
    } else if (d >= minSize * 2) {
      const s = l.z0 + d * rng.range(0.38, 0.62);
      recurse({...l, z1: s}, depth + 1);
      recurse({...l, z0: s}, depth + 1);
    } else {
      out.push(l);
    }
  };
  recurse(lot, 0);
  return out;
}

function inset(l: Lot, m: number): Lot {
  return {x0: l.x0 + m, z0: l.z0 + m, x1: l.x1 - m, z1: l.z1 - m};
}

export function generateCity(seed: number): CityData {
  const segments = new SegmentList(1 << 18);
  const slots: FacadeSlot[] = [];
  const roofs: [number, number, number, number][] = [];
  const obstacles: Obstacle[] = [];
  const landmarks: [number, number, number][] = [];
  const N = CITY_RADIUS_SUPERS;
  const half = AVENUE_W / 2;
  const blockSize = (SUPER - AVENUE_W - STREET_W) / 2;

  // Ground: one huge slab whose top is y = 0.
  {
    const ctx: BuildCtx = {
      segs: segments,
      rng: new Rng(seed, 1),
      district: 0,
      slots,
      roofs,
      avenueSides: [false, false, false, false],
    };
    const size = CITY_HALF_SIZE * 2 + 6000;
    seg(ctx, {x: 0, z: 0, y: -4, w: size, d: size, h: 4, style: Style.Ground, colorA: packColor(1, 0.7, 0.4)});
  }

  for (let i = -N; i < N; i++) {
    for (let j = -N; j < N; j++) {
      const rng = new Rng(seed, (i + 1000) * 4096 + (j + 1000));
      const info = superblockInfo(i, j, seed);
      const hs = info.heightScale;
      const sx0 = i * SUPER + half;
      const sz0 = j * SUPER + half;
      const ctxFor = (avenueSides: [boolean, boolean, boolean, boolean]): BuildCtx => ({
        segs: segments,
        rng,
        district: info.district,
        slots,
        roofs,
        avenueSides,
      });
      const superLot: Lot = {x0: sx0, z0: sz0, x1: sx0 + SUPER - AVENUE_W, z1: sz0 + SUPER - AVENUE_W};

      // Whole-superblock buildings.
      if (info.district === District.Corporate) {
        const H = rng.range(650, 1100);
        pyramid(ctxFor([true, true, true, true]), inset(superLot, 6), H);
        landmarks.push([(superLot.x0 + superLot.x1) / 2, H, (superLot.z0 + superLot.z1) / 2]);
        continue;
      }
      if (info.district === District.Megablock && rng.chance(0.35)) {
        const H = rng.range(380, 750) * Math.min(1.3, hs);
        megablock(ctxFor([true, true, true, true]), inset(superLot, 4), H);
        continue;
      }

      const blockHeights: number[] = [];
      for (let bi = 0; bi < 2; bi++) {
        for (let bj = 0; bj < 2; bj++) {
          const bx0 = sx0 + bi * (blockSize + STREET_W);
          const bz0 = sz0 + bj * (blockSize + STREET_W);
          const block: Lot = {x0: bx0, z0: bz0, x1: bx0 + blockSize, z1: bz0 + blockSize};
          const sideOnAvenue = (l: Lot): [boolean, boolean, boolean, boolean] => [
            Math.abs(l.x0 - sx0) < 1,
            Math.abs(l.x1 - (sx0 + SUPER - AVENUE_W)) < 1,
            Math.abs(l.z0 - sz0) < 1,
            Math.abs(l.z1 - (sz0 + SUPER - AVENUE_W)) < 1,
          ];
          let maxH = 0;
          const build = (lot: Lot, fn: (ctx: BuildCtx, lot: Lot) => number) => {
            const ctx = ctxFor(sideOnAvenue(lot));
            maxH = Math.max(maxH, fn(ctx, inset(lot, 2.5)));
          };
          switch (info.district) {
            case District.Core: {
              const lots = splitLots(rng, block, 45, rng.int(0, 2));
              for (const lot of lots) {
                const big = Math.min(lot.x1 - lot.x0, lot.z1 - lot.z0) > 70;
                const landmark = big && rng.chance(0.18 * hs);
                const H = (landmark ? rng.range(900, 1700) : rng.range(220, 650)) * hs;
                build(lot, (ctx, l) => {
                  const k = rng.weighted([3, 2, landmark ? 2 : 0.4, landmark ? 1 : 0.1, 1, 0.8, 0.6]);
                  if (k === 0) setbackTower(ctx, l, H, rng.pick([Style.GlassOffice, Style.MetalPanel, Style.Monolith]), rng.chance(0.4) ? SegFlags.EdgeGlow : 0);
                  else if (k === 1) cylinderTower(ctx, l, H, Style.GlassOffice);
                  else if (k === 2) twistTower(ctx, l, H);
                  else if (k === 3) pearlTower(ctx, l, H);
                  else if (k === 4) bridgedCluster(ctx, l, H * 0.8);
                  else if (k === 5) gateTower(ctx, l, H * 0.85);
                  else wedgeTower(ctx, l, H, Style.MetalPanel);
                  if (H > 900) landmarks.push([(l.x0 + l.x1) / 2, H, (l.z0 + l.z1) / 2]);
                  return H;
                });
              }
              break;
            }
            case District.Megablock: {
              const H = rng.range(300, 650) * Math.min(1.3, hs);
              build(block, (ctx, l) => {
                megablock(ctx, l, H);
                return H;
              });
              break;
            }
            case District.Slum: {
              const lots = splitLots(rng, block, 18, 4);
              for (const lot of lots) {
                const H = rng.range(90, 380) * hs;
                build(lot, (ctx, l) => {
                  if (rng.chance(0.12)) setbackTower(ctx, l, H, Style.Residential);
                  else slumStack(ctx, l, H);
                  return H;
                });
              }
              break;
            }
            case District.Market: {
              const lots = splitLots(rng, block, 28, 2);
              for (const lot of lots) {
                const H = rng.range(130, 420) * hs;
                build(lot, (ctx, l) => {
                  const k = rng.weighted([3, 2, 1.5, 1]);
                  if (k === 0) ledSlab(ctx, l, H);
                  else if (k === 1) setbackTower(ctx, l, H, rng.pick([Style.Residential, Style.MetalPanel]), SegFlags.EdgeGlow);
                  else if (k === 2) cylinderTower(ctx, l, H, Style.Residential);
                  else wedgeTower(ctx, l, H, Style.Residential);
                  return H;
                });
              }
              break;
            }
          }
          blockHeights.push(maxH);
        }
      }

      // Sky bridges across the narrow inner streets.
      const ctx = ctxFor([false, false, false, false]);
      const midX = sx0 + blockSize + STREET_W / 2;
      const midZ = sz0 + blockSize + STREET_W / 2;
      const nb = info.district === District.Slum ? 6 : info.district === District.Market ? 3 : 1;
      for (let k = 0; k < nb; k++) {
        const acrossX = rng.chance(0.5);
        const side = rng.int(0, 2);
        const a = acrossX ? blockHeights[side * 2] : blockHeights[side];
        const b = acrossX ? blockHeights[side * 2 + 1] : blockHeights[side + 2];
        const top = Math.min(a, b) - 20;
        if (top < 40) continue;
        const y = rng.range(25, top);
        const along = (acrossX ? sz0 : sx0) + side * (blockSize + STREET_W) + rng.range(15, blockSize - 15);
        const len = STREET_W + 14;
        const w = rng.range(5, 12);
        seg(ctx, {
          x: acrossX ? along : midX,
          z: acrossX ? midZ : along,
          y,
          w: acrossX ? w : len,
          d: acrossX ? len : w,
          h: rng.range(4, 8),
          style: Style.Bridge,
          colorB: neon(rng),
          flags: SegFlags.EdgeGlow,
        });
      }

      // Occasional bridges over the avenues (very high or quite low so the
      // flight band stays clear; recorded as obstacles anyway).
      if ((info.district === District.Slum || info.district === District.Core) && rng.chance(0.25) && i < N - 1) {
        const y = rng.chance(0.4) ? rng.range(45, 85) : rng.range(470, 620);
        if (Math.min(...blockHeights) > y + 15) {
          const z = sz0 + rng.range(20, SUPER - AVENUE_W - 20);
          const x = (i + 1) * SUPER;
          const len = AVENUE_W + 16;
          const w = rng.range(8, 16);
          const h = rng.range(6, 12);
          seg(ctx, {x, z, y, w: len, d: w, h, style: Style.Bridge, colorB: neon(rng), flags: SegFlags.EdgeGlow});
          obstacles.push({x0: x - len / 2, x1: x + len / 2, z0: z - w / 2, z1: z + w / 2, y0: y, y1: y + h});
        }
      }
    }
  }

  // Sort segments spatially for culling locality.
  segments.sortBy(k => {
    const s = segments.get(k);
    if (s.style === Style.Ground) return -1;
    const cx = Math.floor((s.x + CITY_HALF_SIZE) / 600);
    const cz = Math.floor((s.z + CITY_HALF_SIZE) / 600);
    return cx * 1000 + cz;
  });
  return {seed, segments, slots, roofs, obstacles, landmarks};
}
