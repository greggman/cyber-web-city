// City generator: superblocks -> blocks -> lots -> building archetypes.
import {Rng, hashFloat} from '../math/random';
import {unwarp, warp, warpAngle} from './warp';
import {Shape} from './meshes';
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
  setPalette,
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
  /** Avenue bridges, in GRID space (the flight path is planned there). */
  obstacles: Obstacle[];
  /** Tallest landmarks: [x, height, z]. */
  landmarks: [number, number, number][];
  /** Cable bundles strung across inner streets (world space). */
  cables: Cable[];
}

export interface Cable {
  a: [number, number, number];
  b: [number, number, number];
  /** Sag at the middle (m). */
  sag: number;
  radius: number;
  /** Paper lanterns along the cable: 0 none, else a color index. */
  lanterns: number;
}

function splitLots(
  rng: Rng,
  lot: Lot,
  minSize: number,
  maxSplits: number,
): Lot[] {
  const out: Lot[] = [];
  const recurse = (l: Lot, depth: number) => {
    const w = l.x1 - l.x0;
    const d = l.z1 - l.z0;
    if (
      depth >= maxSplits ||
      (w < minSize * 2 && d < minSize * 2) ||
      (depth > 0 && rng.chance(0.25))
    ) {
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
  const cables: Cable[] = [];
  const N = CITY_RADIUS_SUPERS;
  const half = AVENUE_W / 2;

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
    const size = CITY_HALF_SIZE * 2 + 120000;
    seg(ctx, {
      x: 0,
      z: 0,
      y: -4,
      w: size,
      d: size,
      h: 4,
      style: Style.Ground,
      colorA: packColor(1, 0.7, 0.4),
    });
  }

  for (let i = -N; i < N; i++) {
    for (let j = -N; j < N; j++) {
      const rng = new Rng(seed, (i + 1000) * 4096 + (j + 1000));
      const info = superblockInfo(i, j, seed);
      // District palette: two hues from slowly varying noise plus amber.
      {
        const h0 = Math.floor(
          hashFloat(seed, Math.floor(i / 3), Math.floor(j / 3), 5) * 8,
        );
        const h1 = (h0 + 1 + Math.floor(hashFloat(seed, i, j, 6) * 3)) % 8;
        setPalette([h0, h1, 2]);
      }
      const hs = info.heightScale;
      const sx0 = i * SUPER + half;
      const sz0 = j * SUPER + half;
      const ctxFor = (
        avenueSides: [boolean, boolean, boolean, boolean],
      ): BuildCtx => ({
        segs: segments,
        rng,
        district: info.district,
        slots,
        roofs,
        avenueSides,
      });
      const superLot: Lot = {
        x0: sx0,
        z0: sz0,
        x1: sx0 + SUPER - AVENUE_W,
        z1: sz0 + SUPER - AVENUE_W,
      };

      // Whole-superblock buildings.
      if (info.district === District.Corporate) {
        const H = rng.range(650, 1100);
        pyramid(ctxFor([true, true, true, true]), inset(superLot, 6), H);
        landmarks.push([
          (superLot.x0 + superLot.x1) / 2,
          H,
          (superLot.z0 + superLot.z1) / 2,
        ]);
        continue;
      }
      if (info.district === District.Megablock && rng.chance(0.35)) {
        const H = rng.range(380, 750) * Math.min(1.3, hs);
        megablock(ctxFor([true, true, true, true]), inset(superLot, 4), H);
        continue;
      }

      const blockHeights: number[] = [];
      const blockSegs: [number, number][] = [];
      // Irregular blocks: the inner streets sit off-center, and sometimes one
      // is missing so blocks merge into bigger ones.
      const inner = SUPER - AVENUE_W;
      const spans = (origin: number): [number, number][] => {
        if (rng.chance(0.2)) return [[origin, origin + inner]];
        const c = inner * rng.range(0.3, 0.7);
        return [
          [origin, origin + c - STREET_W / 2],
          [origin + c + STREET_W / 2, origin + inner],
        ];
      };
      const xs = spans(sx0);
      const zs = spans(sz0);
      for (let bi = 0; bi < xs.length; bi++) {
        for (let bj = 0; bj < zs.length; bj++) {
          const block: Lot = {
            x0: xs[bi][0],
            z0: zs[bj][0],
            x1: xs[bi][1],
            z1: zs[bj][1],
          };
          const sideOnAvenue = (
            l: Lot,
          ): [boolean, boolean, boolean, boolean] => [
            Math.abs(l.x0 - sx0) < 1,
            Math.abs(l.x1 - (sx0 + SUPER - AVENUE_W)) < 1,
            Math.abs(l.z0 - sz0) < 1,
            Math.abs(l.z1 - (sz0 + SUPER - AVENUE_W)) < 1,
          ];
          // Bridges must stay below the shortest building in the block so
          // they always connect to something.
          let minH = Infinity;
          const segStart = segments.count;
          const build = (lot: Lot, fn: (ctx: BuildCtx, lot: Lot) => number) => {
            const ctx = ctxFor(sideOnAvenue(lot));
            minH = Math.min(minH, fn(ctx, inset(lot, 2.5)));
          };
          switch (info.district) {
            case District.Core: {
              const lots = splitLots(rng, block, 45, rng.int(0, 2));
              for (const lot of lots) {
                const big = Math.min(lot.x1 - lot.x0, lot.z1 - lot.z0) > 70;
                const landmark = big && rng.chance(0.18 * hs);
                const H =
                  (landmark ? rng.range(900, 1700) : rng.range(220, 650)) * hs;
                build(lot, (ctx, l) => {
                  const k = rng.weighted([
                    3,
                    2,
                    landmark ? 2 : 0.4,
                    landmark ? 1 : 0.1,
                    1,
                    0.8,
                    0.6,
                  ]);
                  if (k === 0)
                    setbackTower(
                      ctx,
                      l,
                      H,
                      rng.pick([
                        Style.GlassOffice,
                        Style.MetalPanel,
                        Style.Monolith,
                      ]),
                      rng.chance(0.25) ? SegFlags.EdgeGlow : 0,
                    );
                  else if (k === 1) cylinderTower(ctx, l, H, Style.GlassOffice);
                  else if (k === 2) twistTower(ctx, l, H);
                  else if (k === 3) pearlTower(ctx, l, H);
                  else if (k === 4) bridgedCluster(ctx, l, H * 0.8);
                  else if (k === 5) gateTower(ctx, l, H * 0.85);
                  else wedgeTower(ctx, l, H, Style.MetalPanel);
                  if (H > 900)
                    landmarks.push([(l.x0 + l.x1) / 2, H, (l.z0 + l.z1) / 2]);
                  // Height that bridges can safely attach below.
                  if (k === 3) return 0; // slender columns: no bridges
                  if (k === 4) return H * 0.8 * 0.85;
                  if (k === 5) return H * 0.85;
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
                  if (rng.chance(0.12))
                    setbackTower(ctx, l, H, Style.Residential);
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
                  const k = rng.weighted([0.8, 2.5, 1.5, 1]);
                  if (k === 0) ledSlab(ctx, l, H);
                  else if (k === 1)
                    setbackTower(
                      ctx,
                      l,
                      H,
                      rng.pick([Style.Residential, Style.MetalPanel]),
                      SegFlags.EdgeGlow,
                    );
                  else if (k === 2) cylinderTower(ctx, l, H, Style.Residential);
                  else wedgeTower(ctx, l, H, Style.Residential);
                  return H;
                });
              }
              break;
            }
          }
          blockHeights.push(minH === Infinity ? 0 : minH);
          blockSegs.push([segStart, segments.count]);
        }
      }

      // Sky bridges across the narrow inner streets, spanning exactly between
      // building faces that exist at the bridge height on both sides.
      const ctx = ctxFor([false, false, false, false]);
      const nb =
        info.district === District.Slum
          ? 10
          : info.district === District.Market
            ? 5
            : 2;
      for (let k = 0; k < nb; k++) {
        // Blocks are indexed bi * 2 + bj. Bridge across the z-street (between
        // bj = 0 and 1) or across the x-street (between bi = 0 and 1).
        // alongX: the bridge crosses a street running along x (between the
        // two z spans); otherwise one running along z.
        const alongX = rng.chance(0.5);
        if (alongX ? zs.length < 2 : xs.length < 2) continue;
        const side = rng.int(0, alongX ? xs.length : zs.length);
        const nz = zs.length;
        const [ia, ib] = alongX
          ? [side * nz, side * nz + 1]
          : [side, nz + side];
        const top = Math.min(blockHeights[ia], blockHeights[ib]);
        if (top < 30) continue;
        const y = rng.range(12, Math.min(top - 10, 250));
        const h = rng.range(4, 8);
        const w = rng.range(5, 12);
        const [blockStart, blockEnd] = alongX ? xs[side] : zs[side];
        if (blockEnd - blockStart < 30) continue;
        const along = rng.range(blockStart + 10, blockEnd - 10);
        // Find the face nearest the street in each block at this height.
        const face = (bidx: number, sign: number): number | null => {
          let best: number | null = null;
          const [s0, s1] = blockSegs[bidx];
          for (let q = s0; q < s1; q++) {
            const g = segments.get(q);
            if (g.y > y || g.y + g.sy < y + h || g.style === Style.Bridge)
              continue;
            const f = Math.min(1, (y + h - g.y) / g.sy);
            const tp = 1 + (g.taper - 1) * f;
            const hx = (g.sx / 2) * tp;
            const hz = (g.sz / 2) * tp;
            const c = alongX ? g.x : g.z; // coordinate along the street
            const half = alongX ? hx : hz;
            if (Math.abs(along - c) > half - w / 2 - 1) continue;
            const edge = alongX ? g.z + sign * hz : g.x + sign * hx;
            if (best === null || (sign > 0 ? edge > best : edge < best))
              best = edge;
          }
          return best;
        };
        const ea = face(ia, 1);
        const eb = face(ib, -1);
        if (ea === null || eb === null || eb - ea < 4 || eb - ea > 60) continue;
        const len = eb - ea + 2;
        const mid = (ea + eb) / 2;
        seg(ctx, {
          x: alongX ? along : mid,
          z: alongX ? mid : along,
          y,
          w: alongX ? w : len,
          d: alongX ? len : w,
          h,
          style: Style.Bridge,
          colorB: neon(rng),
          flags: SegFlags.EdgeGlow,
        });
      }

      // Cable bundles (and lantern strings) across the inner streets,
      // anchored on real facing walls. Own random stream so the rest of the
      // city doesn't change.
      {
        const crng = new Rng(seed, (i + 1000) * 4096 + (j + 1000) + 7777777);
        const nCables =
          info.district === District.Slum
            ? 40
            : info.district === District.Market
              ? 26
              : info.district === District.Megablock
                ? 8
                : 5;
        for (let k = 0; k < nCables; k++) {
          const alongX = crng.chance(0.5);
          if (alongX ? zs.length < 2 : xs.length < 2) continue;
          const side = crng.int(0, alongX ? xs.length : zs.length);
          const nz = zs.length;
          const [ia, ib] = alongX
            ? [side * nz, side * nz + 1]
            : [side, nz + side];
          const top = Math.min(blockHeights[ia], blockHeights[ib]);
          if (top < 12) continue;
          // Denser low down, near the street.
          const y = 6 + Math.pow(crng.next(), 2.2) * Math.min(top - 4, 180);
          const [blockStart, blockEnd] = alongX ? xs[side] : zs[side];
          if (blockEnd - blockStart < 10) continue;
          const along = crng.range(blockStart + 3, blockEnd - 3);
          const faceAt = (bidx: number, sign: number): number | null => {
            let best: number | null = null;
            const [s0, s1] = blockSegs[bidx];
            for (let q = s0; q < s1; q++) {
              const g = segments.get(q);
              if (g.y > y || g.y + g.sy < y || g.style === Style.Bridge)
                continue;
              const f = Math.min(1, (y - g.y) / g.sy);
              const tp = 1 + (g.taper - 1) * f;
              const hx = (g.sx / 2) * tp;
              const hz = (g.sz / 2) * tp;
              const c = alongX ? g.x : g.z;
              if (Math.abs(along - c) > (alongX ? hx : hz) - 0.5) continue;
              const edge = alongX ? g.z + sign * hz : g.x + sign * hx;
              if (best === null || (sign > 0 ? edge > best : edge < best))
                best = edge;
            }
            return best;
          };
          const ea = faceAt(ia, 1);
          const eb = faceAt(ib, -1);
          if (ea === null || eb === null || eb - ea < 3 || eb - ea > 45)
            continue;
          const span = eb - ea;
          const lantern =
            info.district === District.Slum || info.district === District.Market
              ? crng.chance(0.35)
              : crng.chance(0.08);
          const strands = lantern ? 1 : crng.int(1, 4);
          const drop = crng.range(-2, 2);
          for (let st = 0; st < strands; st++) {
            const off = (st - (strands - 1) / 2) * 0.35;
            const p0: [number, number, number] = alongX
              ? [along + off, y, ea]
              : [ea, y, along + off];
            const p1: [number, number, number] = alongX
              ? [along + off, y + drop, eb]
              : [eb, y + drop, along + off];
            cables.push({
              a: p0,
              b: p1,
              sag: span * crng.range(0.04, 0.12) + 0.3,
              radius: crng.range(0.03, 0.08),
              lanterns: lantern ? crng.int(1, 5) : 0,
            });
          }
        }
      }

      // Occasional bridges over the avenues (very high or quite low so the
      // flight band stays clear; recorded as obstacles anyway).
      if (
        (info.district === District.Slum || info.district === District.Core) &&
        rng.chance(0.25) &&
        i < N - 1
      ) {
        const y = rng.chance(0.4) ? rng.range(45, 85) : rng.range(470, 620);
        if (Math.min(...blockHeights) > y + 15) {
          const z = sz0 + rng.range(20, SUPER - AVENUE_W - 20);
          const x = (i + 1) * SUPER;
          const len = AVENUE_W + 16;
          const w = rng.range(8, 16);
          const h = rng.range(6, 12);
          seg(ctx, {
            x,
            z,
            y,
            w: len,
            d: w,
            h,
            style: Style.Bridge,
            colorB: neon(rng),
            flags: SegFlags.EdgeGlow,
          });
          obstacles.push({
            x0: x - len / 2,
            x1: x + len / 2,
            z0: z - w / 2,
            z1: z + w / 2,
            y0: y,
            y1: y + h,
          });
        }
      }
    }
  }

  // Far field: a ring of simpler buildings beyond the detailed city so the
  // skyline continues to the horizon (seen through haze, beyond the flight
  // area). Cheap boxes/cylinders; the facade shader's distant averages do
  // the rest.
  {
    const rng = new Rng(seed, 4040);
    const ctx: BuildCtx = {
      segs: segments,
      rng,
      district: District.Megablock,
      slots: [],
      roofs: [],
      avenueSides: [false, false, false, false],
    };
    const R = CITY_RADIUS_SUPERS + 24;
    for (let i = -R; i < R; i++) {
      for (let j = -R; j < R; j++) {
        if (i >= -N && i < N && j >= -N && j < N) continue;
        const info = superblockInfo(i, j, seed);
        const n = rng.int(2, 6);
        for (let k = 0; k < n; k++) {
          const w = rng.range(40, 110);
          const d = rng.range(40, 110);
          const x =
            i * SUPER + half + rng.range(w / 2, SUPER - AVENUE_W - w / 2);
          const z =
            j * SUPER + half + rng.range(d / 2, SUPER - AVENUE_W - d / 2);
          const h =
            rng.range(80, 500) *
            info.heightScale *
            (rng.chance(0.05) ? 2.5 : 1);
          seg(ctx, {
            x,
            z,
            y: 0,
            w,
            d,
            h,
            shape: rng.chance(0.2) ? Shape.Cylinder : Shape.Box,
            style: rng.pick([
              Style.Residential,
              Style.GlassOffice,
              Style.Slum,
              Style.MetalPanel,
            ]),
            flags: rng.chance(0.15)
              ? SegFlags.EdgeGlow
              : rng.chance(0.2)
                ? SegFlags.FloorBands
                : 0,
            taper: 1,
            floorH: 3.4,
          });
        }
      }
    }
  }

  // Rooftop clutter: AC units, water tanks, antennas, billboard frames.
  {
    const rng = new Rng(seed, 31337);
    const ctx: BuildCtx = {
      segs: segments,
      rng,
      district: 0,
      slots,
      roofs,
      avenueSides: [false, false, false, false],
    };
    for (const [x, y, z, size] of roofs) {
      if (size < 8) continue;
      const n = rng.int(2, Math.min(9, 2 + Math.floor(size / 10)));
      for (let k = 0; k < n; k++) {
        const px = x + rng.range(-0.35, 0.35) * size;
        const pz = z + rng.range(-0.35, 0.35) * size;
        const kind = rng.weighted([4, 2, 2, 0.6]);
        if (kind === 0) {
          seg(ctx, {
            x: px,
            z: pz,
            y,
            w: rng.range(2, 6),
            d: rng.range(2, 6),
            h: rng.range(1.5, 4),
            style: Style.MetalPanel,
            flags: SegFlags.NoWindows,
          });
        } else if (kind === 1) {
          const r = rng.range(2.5, 5);
          seg(ctx, {
            x: px,
            z: pz,
            y,
            w: r,
            d: r,
            h: rng.range(3, 7),
            shape: Shape.Cylinder,
            style: Style.MetalPanel,
            flags: SegFlags.NoWindows,
          });
        } else if (kind === 2) {
          seg(ctx, {
            x: px,
            z: pz,
            y,
            w: 0.6,
            d: 0.6,
            h: rng.range(6, 25),
            style: Style.Structure,
            flags: SegFlags.RoofBeacon,
          });
        } else {
          // Rooftop billboard frame (lit).
          seg(ctx, {
            x: px,
            z: pz,
            y: y + 4,
            w: rng.range(10, 20),
            d: 1,
            h: rng.range(5, 9),
            rotY: rng.int(0, 2) * (Math.PI / 2),
            style: Style.LedFacade,
            colorB: neon(rng),
          });
        }
      }
    }
  }

  // Mark exposed roofs (no other segment sits on top) for rooftop kitbash.
  {
    const CELL = 100;
    const grid = new Map<number, number[]>();
    const key = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);
    for (let i = 0; i < segments.count; i++) {
      const g = segments.get(i);
      if (g.style === Style.Ground) continue;
      const r = Math.max(g.sx, g.sz) * 0.75 * Math.max(1, g.taper);
      for (
        let cx = Math.floor((g.x - r) / CELL);
        cx <= Math.floor((g.x + r) / CELL);
        cx++
      ) {
        for (
          let cz = Math.floor((g.z - r) / CELL);
          cz <= Math.floor((g.z + r) / CELL);
          cz++
        ) {
          const k = key(cx, cz);
          let a = grid.get(k);
          if (!a) grid.set(k, (a = []));
          a.push(i);
        }
      }
    }
    for (let i = 0; i < segments.count; i++) {
      const g = segments.get(i);
      if (
        g.style === Style.Ground ||
        g.shape > 4 ||
        g.sx * g.sz * g.taper * g.taper < 150
      )
        continue;
      const top = g.y + g.sy;
      const others =
        grid.get(key(Math.floor(g.x / CELL), Math.floor(g.z / CELL))) ?? [];
      const coveredAt = (px: number, pz: number) => {
        for (const j of others) {
          if (j === i) continue;
          const o = segments.get(j);
          if (o.y > top + 0.5 || o.y + o.sy < top + 0.5) continue;
          if (
            Math.abs(o.x - px) < o.sx * 0.5 &&
            Math.abs(o.z - pz) < o.sz * 0.5
          )
            return true;
        }
        return false;
      };
      const q = 0.33 * g.taper;
      let quads = 0;
      for (const [sx, sz] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        if (!coveredAt(g.x + sx * q * g.sx, g.z + sz * q * g.sz)) quads++;
      }
      if (quads >= 3) {
        const ring = coveredAt(g.x, g.z) ? SegFlags.RoofRing : 0;
        segments.setFlags(i, g.flags | SegFlags.RoofExposed | ring);
      }
    }
  }

  // Bend the grid-space city into world space (see warp.ts). Obstacles stay
  // in grid space: the flight path is planned there and warped afterwards.
  // Avenue corridors (flight path and traffic) must stay clear: after
  // rotating to follow the warped streets, a building's corners are mapped
  // back to grid space and the footprint shrinks until it stays CLEAR m
  // from every avenue centerline.
  const CLEAR = 26;
  const aveDist = (t: number) => Math.abs(t - Math.round(t / SUPER) * SUPER);
  for (let i = 0; i < segments.count; i++) {
    const g = segments.get(i);
    if (g.style === Style.Ground) continue;
    const [x, z] = warp(g.x, g.z);
    const rot = g.rotY + warpAngle(g.x, g.z);
    segments.setPose(i, x, z, rot);
    // Pieces that are meant to be over an avenue (bridges) are exempt.
    if (aveDist(g.x) < CLEAR || aveDist(g.z) < CLEAR) continue;
    const grow = Math.max(1, g.taper);
    const hx = (g.sx / 2) * grow;
    const hz = (g.sz / 2) * grow;
    const reach = Math.hypot(hx, hz);
    if (
      aveDist(g.x) - reach * 1.3 > CLEAR &&
      aveDist(g.z) - reach * 1.3 > CLEAR
    )
      continue;
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    const fits = (k: number) => {
      for (const [ex, ez] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ]) {
        const lx = ex * hx * k;
        const lz = ez * hz * k;
        const [u, v] = unwarp(x + c * lx - sn * lz, z + sn * lx + c * lz);
        if (aveDist(u) < CLEAR || aveDist(v) < CLEAR) return false;
      }
      return true;
    };
    if (fits(1)) continue;
    let k = 0.95;
    while (k > 0.5 && !fits(k)) k -= 0.05;
    segments.setSize(i, g.sx * k, g.sz * k);
  }
  for (const sl of slots) {
    const a = warpAngle(sl.x, sl.z);
    [sl.x, sl.z] = warp(sl.x, sl.z);
    const c = Math.cos(a);
    const sn = Math.sin(a);
    [sl.nx, sl.nz] = [c * sl.nx - sn * sl.nz, sn * sl.nx + c * sl.nz];
  }
  for (const r of roofs) [r[0], r[2]] = warp(r[0], r[2]);
  for (const l of landmarks) [l[0], l[2]] = warp(l[0], l[2]);
  for (const c of cables) {
    [c.a[0], c.a[2]] = warp(c.a[0], c.a[2]);
    [c.b[0], c.b[2]] = warp(c.b[0], c.b[2]);
  }

  // Sort segments spatially for culling locality.
  const newIndex = segments.sortBy(k => {
    const s = segments.get(k);
    if (s.style === Style.Ground) return -1;
    const cx = Math.floor((s.x + CITY_HALF_SIZE) / 600);
    const cz = Math.floor((s.z + CITY_HALF_SIZE) / 600);
    return cx * 1000 + cz;
  });
  for (const sl of slots) if (sl.seg >= 0) sl.seg = newIndex[sl.seg];
  return {seed, segments, slots, roofs, obstacles, landmarks, cables};
}

/**
 * Builds a test for whether a vertical cylinder (center x,z, radius r,
 * heights y0..y1) is free of building segments (coarse AABB check).
 */
export function makeClearanceTest(
  segments: SegmentList,
): (x: number, z: number, r: number, y0: number, y1: number) => boolean {
  const CELL = 300;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < segments.count; i++) {
    const g = segments.get(i);
    if (g.style === Style.Ground) continue;
    const hx = (Math.max(g.sx, g.sz) / 2) * Math.max(1, g.taper);
    for (
      let cx = Math.floor((g.x - hx) / CELL);
      cx <= Math.floor((g.x + hx) / CELL);
      cx++
    ) {
      for (
        let cz = Math.floor((g.z - hx) / CELL);
        cz <= Math.floor((g.z + hx) / CELL);
        cz++
      ) {
        const k = `${cx},${cz}`;
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(i);
      }
    }
  }
  return (x, z, r, y0, y1) => {
    for (
      let cx = Math.floor((x - r) / CELL);
      cx <= Math.floor((x + r) / CELL);
      cx++
    ) {
      for (
        let cz = Math.floor((z - r) / CELL);
        cz <= Math.floor((z + r) / CELL);
        cz++
      ) {
        for (const i of grid.get(`${cx},${cz}`) ?? []) {
          const g = segments.get(i);
          if (g.y >= y1 || g.y + g.sy <= y0) continue;
          // Ignore small rooftop clutter, antennas and spires.
          if (Math.max(g.sx, g.sz) < 14) continue;
          // Test in the segment's rotated frame (tapers/twists: use the
          // larger bottom footprint, rotated by the mid-height twist).
          const a = -(g.rotY + g.twist * 0.5);
          const dx = x - g.x;
          const dz = z - g.z;
          const lx = Math.cos(a) * dx - Math.sin(a) * dz;
          const lz = Math.sin(a) * dx + Math.cos(a) * dz;
          const round = g.shape === Shape.Cylinder || g.shape === Shape.Sphere;
          if (round) {
            if (Math.hypot(lx / (g.sx / 2 + r), lz / (g.sz / 2 + r)) < 1)
              return false;
          } else if (
            Math.abs(lx) < g.sx / 2 + r &&
            Math.abs(lz) < g.sz / 2 + r
          ) {
            return false;
          }
        }
      }
    }
    return true;
  };
}
