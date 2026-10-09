// Building archetypes. Each pushes a stack of segments for one lot.
import type {Rng} from '../math/random';
import {Shape} from './meshes';
import {SegFlags, SegmentList, Style, packColor} from './segments';

export interface Lot {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** A facade rectangle suitable for signs/screens (axis-aligned building faces). */
export interface FacadeSlot {
  /** Point on the facade at the bottom center of the slot. */
  x: number;
  y: number;
  z: number;
  /** Outward normal (axis aligned). */
  nx: number;
  nz: number;
  width: number;
  height: number;
  district: number;
  /** True when this facade faces an avenue (visible from the sky lanes). */
  avenue: boolean;
}

export interface BuildCtx {
  segs: SegmentList;
  rng: Rng;
  district: number;
  slots: FacadeSlot[];
  /** Rooftop anchor points for holograms/beacons: [x, y, z, size]. */
  roofs: [number, number, number, number][];
  /** Which lot sides face an avenue: -x, +x, -z, +z. */
  avenueSides: [boolean, boolean, boolean, boolean];
}

export const WINDOW_TINTS = {
  warm: [1.0, 0.68, 0.4],
  neutral: [1.0, 0.86, 0.7],
  cool: [0.72, 0.84, 1.0],
  sodium: [1.0, 0.55, 0.2],
} as const;

export const NEON: [number, number, number][] = [
  [1.0, 0.08, 0.55], // magenta
  [0.05, 0.85, 1.0], // cyan
  [1.0, 0.5, 0.05], // amber
  [1.0, 0.1, 0.12], // red
  [0.55, 0.15, 1.0], // violet
  [0.15, 1.0, 0.45], // green
  [1.0, 0.3, 0.7], // pink
  [1.0, 0.85, 0.25], // gold
];

// Each superblock uses a small palette (1-2 dominant hues plus a warm
// accent) so districts read as coherent instead of rainbow noise.
let palette: number[] = [0, 1, 2];

export function setPalette(p: number[]) {
  palette = p;
}

export function paletteColor(rng: Rng): [number, number, number] {
  const k = rng.weighted([5, 3, 1.5]);
  return NEON[palette[Math.min(k, palette.length - 1)]];
}

export function neon(rng: Rng): number {
  const c = paletteColor(rng);
  return packColor(c[0], c[1], c[2]);
}

function tint(rng: Rng, kind?: keyof typeof WINDOW_TINTS): number {
  const k = kind ?? rng.pick(['warm', 'neutral', 'cool', 'warm'] as const);
  const c = WINDOW_TINTS[k];
  return packColor(c[0], c[1], c[2]);
}

interface SegOpts {
  x: number;
  z: number;
  y: number;
  w: number;
  d: number;
  h: number;
  shape?: Shape;
  style?: Style;
  taper?: number;
  twist?: number;
  rotY?: number;
  colorA?: number;
  colorB?: number;
  flags?: number;
  floorH?: number;
}

export function seg(ctx: BuildCtx, o: SegOpts) {
  ctx.segs.push({
    x: o.x,
    y: o.y,
    z: o.z,
    rotY: o.rotY ?? 0,
    sx: o.w,
    sy: o.h,
    sz: o.d,
    taper: o.taper ?? 1,
    twist: o.twist ?? 0,
    shape: o.shape ?? Shape.Box,
    style: o.style ?? Style.GlassOffice,
    seed: ctx.rng.nextU32(),
    colorA: o.colorA ?? tint(ctx.rng),
    colorB: o.colorB ?? neon(ctx.rng),
    flags: o.flags ?? 0,
    floorH: o.floorH ?? 4,
  });
}

/** Records the four facades of an axis-aligned box as sign/screen slots. */
function addSlots(
  ctx: BuildCtx,
  cx: number,
  cz: number,
  w: number,
  d: number,
  y0: number,
  y1: number,
) {
  const sides: [number, number, number, number, number, boolean][] = [
    [cx - w / 2, cz, -1, 0, d, ctx.avenueSides[0]],
    [cx + w / 2, cz, 1, 0, d, ctx.avenueSides[1]],
    [cx, cz - d / 2, 0, -1, w, ctx.avenueSides[2]],
    [cx, cz + d / 2, 0, 1, w, ctx.avenueSides[3]],
  ];
  for (const [x, z, nx, nz, width, avenue] of sides) {
    ctx.slots.push({
      x,
      y: y0,
      z,
      nx,
      nz,
      width,
      height: y1 - y0,
      district: ctx.district,
      avenue,
    });
  }
}

function podium(ctx: BuildCtx, lot: Lot, h: number) {
  const w = lot.x1 - lot.x0;
  const d = lot.z1 - lot.z0;
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.z0 + lot.z1) / 2;
  seg(ctx, {
    x: cx,
    z: cz,
    y: 0,
    w,
    d,
    h,
    style: Style.Podium,
    floorH: 6,
    colorA: tint(ctx.rng, 'neutral'),
    flags: SegFlags.TopGlow,
  });
  addSlots(ctx, cx, cz, w, d, 2, h);
}

function spire(ctx: BuildCtx, x: number, z: number, y: number, size: number) {
  const r = ctx.rng;
  const h = size * r.range(0.3, 0.8);
  seg(ctx, {
    x,
    z,
    y,
    w: Math.max(1.5, size * 0.04),
    d: Math.max(1.5, size * 0.04),
    h,
    shape: Shape.Cylinder,
    style: Style.Structure,
    flags: SegFlags.RoofBeacon,
    taper: 0.3,
  });
  return y + h;
}

function crown(
  ctx: BuildCtx,
  x: number,
  z: number,
  y: number,
  w: number,
  d: number,
  style: Style,
) {
  const r = ctx.rng;
  const kind = r.weighted([0.15, 1.2, 1.6, 1, 1]);
  let top = y;
  if (kind === 0) {
    // Pyramid cap.
    const h = Math.min(w, d) * r.range(0.4, 0.9);
    seg(ctx, {x, z, y, w, d, h, taper: 0.05, style, flags: SegFlags.EdgeGlow});
    top = y + h;
  } else if (kind === 1) {
    // Glowing ring crown.
    seg(ctx, {
      x,
      z,
      y: y + 2,
      w: w * 1.08,
      d: d * 1.08,
      h: r.range(3, 6),
      shape: Shape.Cylinder,
      style: Style.NeonRing,
    });
    top = y + 6;
  } else if (kind === 2) {
    // Stepped mechanical penthouse.
    const h = r.range(8, 20);
    seg(ctx, {
      x,
      z,
      y,
      w: w * 0.6,
      d: d * 0.6,
      h,
      style: Style.MetalPanel,
      flags: SegFlags.RoofBeacon,
    });
    top = y + h;
  } else if (kind === 3) {
    // Helipad-ish disc.
    seg(ctx, {
      x,
      z,
      y: y + 3,
      w: Math.min(w, d) * 0.9,
      d: Math.min(w, d) * 0.9,
      h: 2,
      shape: Shape.Cylinder,
      style: Style.Structure,
      flags: SegFlags.TopGlow,
    });
    top = y + 5;
  }
  ctx.roofs.push([x, top, z, Math.min(w, d)]);
  if (r.chance(0.5)) {
    spire(
      ctx,
      x + r.range(-0.2, 0.2) * w,
      z + r.range(-0.2, 0.2) * d,
      top,
      Math.max(w, d) * 1.5,
    );
  }
}

/** Classic setback tower: podium + 2-4 shrinking tiers + crown. */
export function setbackTower(
  ctx: BuildCtx,
  lot: Lot,
  H: number,
  style: Style,
  flags = 0,
) {
  const r = ctx.rng;
  const ph = r.range(14, 36);
  podium(ctx, lot, ph);
  const tiers = r.int(2, 5);
  let w = (lot.x1 - lot.x0) * r.range(0.75, 0.95);
  let d = (lot.z1 - lot.z0) * r.range(0.75, 0.95);
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.z0 + lot.z1) / 2;
  let y = ph;
  const colorA = tint(r, style === Style.GlassOffice ? 'cool' : undefined);
  const colorB = neon(r);
  const floorH = style === Style.Residential ? 3.2 : r.range(3.8, 4.4);
  for (let t = 0; t < tiers; t++) {
    const h = ((H - ph) / tiers) * r.range(0.8, 1.2);
    const tierStyle =
      style === Style.GlassOffice && r.chance(0.06) ? Style.LedFacade : style;
    seg(ctx, {
      x: cx,
      z: cz,
      y,
      w,
      d,
      h,
      style: tierStyle,
      colorA,
      colorB,
      flags,
      floorH,
    });
    addSlots(ctx, cx, cz, w, d, y, y + h);
    // Cantilevered glass pod jutting out of the tier (capped toward avenues).
    if (r.chance(0.3) && h > 30) {
      const side = r.int(0, 4);
      const onAvenue = ctx.avenueSides[side];
      const out = onAvenue ? r.range(3, 6) : r.range(6, 14);
      const ph = r.range(10, Math.min(28, h * 0.5));
      const py = y + r.range(0.2, 0.8) * (h - ph);
      const along = (side < 2 ? d : w) * r.range(0.3, 0.6);
      const sx = side < 2 ? out * 2 : along;
      const sz = side < 2 ? along : out * 2;
      const ox = side === 0 ? -w / 2 : side === 1 ? w / 2 : 0;
      const oz = side === 2 ? -d / 2 : side === 3 ? d / 2 : 0;
      seg(ctx, {
        x: cx + ox,
        z: cz + oz,
        y: py,
        w: sx,
        d: sz,
        h: ph,
        style: Style.GlassOffice,
        colorA,
        colorB,
        flags: SegFlags.EdgeGlow,
        floorH,
      });
    }
    y += h;
    w *= r.range(0.72, 0.9);
    d *= r.range(0.72, 0.9);
    if (t < tiers - 1 && r.chance(0.22)) {
      // Sky lobby void: a narrow lit core between tiers.
      const vh = r.range(12, 26);
      seg(ctx, {
        x: cx,
        z: cz,
        y,
        w: w * 0.35,
        d: d * 0.35,
        h: vh,
        shape: Shape.Cylinder,
        style: Style.Bridge,
        colorB,
        flags: SegFlags.FloorBands,
      });
      y += vh;
    } else if (r.chance(0.3)) {
      // Thin glowing band between tiers.
      seg(ctx, {
        x: cx,
        z: cz,
        y,
        w: w * 1.15,
        d: d * 1.15,
        h: 1.5,
        style: Style.NeonRing,
        colorB,
      });
      y += 1.5;
    }
  }
  crown(ctx, cx, cz, y, w, d, style);
}

/** Round tower with optional taper and glowing rings. */
export function cylinderTower(
  ctx: BuildCtx,
  lot: Lot,
  H: number,
  style: Style,
) {
  const r = ctx.rng;
  const ph = r.range(10, 25);
  podium(ctx, lot, ph);
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.z0 + lot.z1) / 2;
  const diam = Math.min(lot.x1 - lot.x0, lot.z1 - lot.z0) * r.range(0.7, 0.92);
  const taper = r.chance(0.5) ? r.range(0.55, 0.85) : 1;
  const colorB = neon(r);
  const h = H - ph;
  seg(ctx, {
    x: cx,
    z: cz,
    y: ph,
    w: diam,
    d: diam,
    h,
    taper,
    shape: Shape.Cylinder,
    style,
    colorB,
    floorH: r.range(3.6, 4.2),
    flags: r.chance(0.4) ? SegFlags.FloorBands : 0,
  });
  // Glowing rings at intervals (Chinese supertall style).
  if (r.chance(0.6)) {
    const n = r.int(2, 6);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      const dd = diam * (1 + (taper - 1) * t) * 1.06;
      seg(ctx, {
        x: cx,
        z: cz,
        y: ph + h * t,
        w: dd,
        d: dd,
        h: 2.5,
        shape: Shape.Cylinder,
        style: Style.NeonRing,
        colorB,
      });
    }
  }
  const top = diam * taper;
  crown(ctx, cx, cz, H, top * 0.75, top * 0.75, style);
}

/** Shanghai-Tower-like twisting, tapering tower. */
export function twistTower(ctx: BuildCtx, lot: Lot, H: number) {
  const r = ctx.rng;
  podium(ctx, lot, r.range(15, 30));
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.z0 + lot.z1) / 2;
  const s = Math.min(lot.x1 - lot.x0, lot.z1 - lot.z0) * 0.85;
  const taper = r.range(0.45, 0.7);
  seg(ctx, {
    x: cx,
    z: cz,
    y: 0,
    w: s,
    d: s,
    h: H,
    shape: Shape.BoxTwist,
    twist: r.range(0.9, 2.2) * (r.chance(0.5) ? 1 : -1),
    taper,
    style: Style.GlassOffice,
    colorA: tint(r, 'cool'),
    flags: SegFlags.EdgeGlow,
    floorH: 4.2,
  });
  const top = s * taper;
  seg(ctx, {
    x: cx,
    z: cz,
    y: H,
    w: top * 0.7,
    d: top * 0.7,
    h: top * 0.5,
    shape: Shape.Cylinder,
    taper: 0.6,
    style: Style.Structure,
    flags: SegFlags.RoofBeacon | SegFlags.TopGlow,
  });
  ctx.roofs.push([cx, H + top * 0.5, cz, top]);
}

/** Oriental-Pearl-inspired landmark: columns and glowing spheres. */
export function pearlTower(ctx: BuildCtx, lot: Lot, H: number) {
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.z0 + lot.z1) / 2;
  const base = Math.min(lot.x1 - lot.x0, lot.z1 - lot.z0);
  const colorB = packColor(1, 0.15, 0.6);
  // Central column.
  seg(ctx, {
    x: cx,
    z: cz,
    y: 0,
    w: base * 0.12,
    d: base * 0.12,
    h: H * 0.85,
    shape: Shape.Cylinder,
    style: Style.Structure,
    colorB,
    flags: SegFlags.FloorBands,
  });
  // Three outer columns up to the first sphere.
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.3;
    seg(ctx, {
      x: cx + Math.cos(a) * base * 0.3,
      z: cz + Math.sin(a) * base * 0.3,
      y: 0,
      w: base * 0.09,
      d: base * 0.09,
      h: H * 0.3,
      shape: Shape.Cylinder,
      style: Style.Structure,
      colorB,
    });
  }
  const spheres: [number, number][] = [
    [0.27, 0.62],
    [0.6, 0.38],
    [0.82, 0.18],
  ];
  for (const [t, s] of spheres) {
    const d = base * s;
    seg(ctx, {
      x: cx,
      z: cz,
      y: H * t - d / 2,
      w: d,
      d,
      h: d,
      shape: Shape.Sphere,
      style: Style.LedFacade,
      colorB,
      colorA: packColor(1, 0.4, 0.8),
    });
  }
  seg(ctx, {
    x: cx,
    z: cz,
    y: H * 0.85,
    w: 3,
    d: 3,
    h: H * 0.15,
    shape: Shape.Cylinder,
    taper: 0.2,
    style: Style.Structure,
    flags: SegFlags.RoofBeacon,
  });
  ctx.roofs.push([cx, H * 0.6 + base * 0.2, cz, base * 0.4]);
}

/** Mega-City One style residential slab with rooftop clutter. */
export function megablock(ctx: BuildCtx, lot: Lot, H: number) {
  const r = ctx.rng;
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.z0 + lot.z1) / 2;
  const w = lot.x1 - lot.x0;
  const d = lot.z1 - lot.z0;
  const colorA = tint(r, 'warm');
  const colorB = neon(r);
  podium(ctx, lot, r.range(20, 40));
  const tiers = r.int(1, 3);
  let y = 30;
  let ww = w * 0.96;
  let dd = d * 0.96;
  for (let t = 0; t < tiers; t++) {
    const h = (H - 30) / tiers;
    seg(ctx, {
      x: cx,
      z: cz,
      y,
      w: ww,
      d: dd,
      h,
      style: Style.Residential,
      colorA,
      colorB,
      floorH: 3.0,
      flags: r.chance(0.35) ? SegFlags.FloorBands : 0,
    });
    addSlots(ctx, cx, cz, ww, dd, y, y + h);
    y += h;
    ww *= 0.85;
    dd *= 0.85;
  }
  // Rooftop: blocks, antennas, a big sign frame.
  for (let k = 0; k < r.int(3, 8); k++) {
    const bw = r.range(8, 30);
    seg(ctx, {
      x: cx + r.range(-0.4, 0.4) * ww,
      z: cz + r.range(-0.4, 0.4) * dd,
      y,
      w: bw,
      d: r.range(8, 30),
      h: r.range(5, 25),
      style: Style.MetalPanel,
      flags: r.chance(0.3) ? SegFlags.RoofBeacon : 0,
    });
  }
  ctx.roofs.push([cx, y, cz, Math.min(ww, dd)]);
  if (r.chance(0.5)) spire(ctx, cx, cz, y, Math.min(ww, dd));
}

/** Tyrell-like stepped pyramid occupying a whole superblock. */
export function pyramid(ctx: BuildCtx, lot: Lot, H: number) {
  const r = ctx.rng;
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.z0 + lot.z1) / 2;
  const w0 = Math.min(lot.x1 - lot.x0, lot.z1 - lot.z0);
  const steps = r.int(10, 16);
  const colorA = packColor(1.0, 0.75, 0.4);
  const colorB = packColor(1.0, 0.6, 0.2);
  for (let s = 0; s < steps; s++) {
    const t0 = s / steps;
    const t1 = (s + 1) / steps;
    const w = w0 * (1 - t0 * 0.92);
    seg(ctx, {
      x: cx,
      z: cz,
      y: H * t0,
      w,
      d: w,
      h: H * (t1 - t0),
      taper: (1 - t1 * 0.92) / (1 - t0 * 0.92),
      style: Style.Monolith,
      colorA,
      colorB,
      floorH: 5,
      flags: SegFlags.FloorBands,
    });
  }
  seg(ctx, {
    x: cx,
    z: cz,
    y: H,
    w: w0 * 0.08,
    d: w0 * 0.08,
    h: H * 0.05,
    taper: 0.1,
    style: Style.NeonRing,
    colorB,
  });
  addSlots(ctx, cx, cz, w0, w0, 10, H * 0.25);
  ctx.roofs.push([cx, H, cz, w0 * 0.1]);
}

/** Kowloon/Chongqing-like irregular stack of boxes. */
export function slumStack(ctx: BuildCtx, lot: Lot, H: number) {
  const r = ctx.rng;
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.z0 + lot.z1) / 2;
  let w = lot.x1 - lot.x0;
  let d = lot.z1 - lot.z0;
  let y = 0;
  let x = cx;
  let z = cz;
  const colorB = neon(r);
  let first = true;
  while (y < H) {
    const h = Math.min(H - y, r.range(15, 60));
    const style = r.chance(0.75)
      ? Style.Slum
      : r.pick([
          Style.Residential,
          Style.MetalPanel,
          Style.Residential,
          Style.LedFacade,
        ]);
    seg(ctx, {
      x,
      z,
      y,
      w,
      d,
      h,
      style,
      colorA: tint(r),
      colorB,
      floorH: r.range(2.8, 3.3),
    });
    addSlots(ctx, x, z, w, d, first ? 3 : y, y + h);
    first = false;
    y += h;
    // Shrink or shift a little; occasionally cantilever outward (within lot).
    const nw = Math.max(10, w * r.range(0.75, 1.02));
    const nd = Math.max(10, d * r.range(0.75, 1.02));
    // Shift relative to the tier below so tiers always overlap (cantilevers
    // but never floating), and stay within the lot.
    const maxDx = Math.max(0, (lot.x1 - lot.x0 - nw) / 2);
    const maxDz = Math.max(0, (lot.z1 - lot.z0 - nd) / 2);
    x = Math.max(cx - maxDx, Math.min(cx + maxDx, x + r.range(-0.2, 0.2) * w));
    z = Math.max(cz - maxDz, Math.min(cz + maxDz, z + r.range(-0.2, 0.2) * d));
    w = nw;
    d = nd;
  }
  ctx.roofs.push([x, y, z, Math.min(w, d)]);
  if (r.chance(0.3)) {
    seg(ctx, {
      x,
      z,
      y,
      w: 1.2,
      d: 1.2,
      h: r.range(10, 30),
      style: Style.Structure,
      flags: SegFlags.RoofBeacon,
    });
  }
}

/** Raffles-City-Chongqing-like row of towers joined by a horizontal skybridge. */
export function bridgedCluster(ctx: BuildCtx, lot: Lot, H: number) {
  const r = ctx.rng;
  const w = lot.x1 - lot.x0;
  const d = lot.z1 - lot.z0;
  const alongX = w >= d;
  const n = r.int(3, 5);
  const len = alongX ? w : d;
  const thick = (alongX ? d : w) * 0.8;
  const step = len / n;
  const colorB = neon(r);
  const bridgeY = H * r.range(0.72, 0.85);
  for (let k = 0; k < n; k++) {
    const c = (alongX ? lot.x0 : lot.z0) + step * (k + 0.5);
    const tw = step * 0.72;
    const th = H * r.range(0.85, 1.05) * (k === 0 || k === n - 1 ? 0.95 : 1);
    const x = alongX ? c : (lot.x0 + lot.x1) / 2;
    const z = alongX ? (lot.z0 + lot.z1) / 2 : c;
    seg(ctx, {
      x,
      z,
      y: 0,
      w: alongX ? tw : thick,
      d: alongX ? thick : tw,
      h: th,
      style: Style.GlassOffice,
      colorA: tint(r, 'cool'),
      colorB,
      flags: SegFlags.EdgeGlow,
      taper: 0.92,
    });
    ctx.roofs.push([x, th, z, tw]);
  }
  // The horizontal "crystal" across the tops.
  seg(ctx, {
    x: (lot.x0 + lot.x1) / 2,
    z: (lot.z0 + lot.z1) / 2,
    y: bridgeY,
    w: alongX ? len * 0.92 : thick * 0.9,
    d: alongX ? thick * 0.9 : len * 0.92,
    h: 24,
    style: Style.Bridge,
    colorB,
    flags: SegFlags.EdgeGlow,
  });
}

/** Gate tower: two legs and a high span (like the Gate of the Orient). */
export function gateTower(ctx: BuildCtx, lot: Lot, H: number) {
  const r = ctx.rng;
  const w = lot.x1 - lot.x0;
  const d = lot.z1 - lot.z0;
  const alongX = w >= d;
  const legW = (alongX ? w : d) * 0.3;
  const thick = (alongX ? d : w) * 0.75;
  const colorB = neon(r);
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.z0 + lot.z1) / 2;
  for (const s of [-1, 1]) {
    const off = s * ((alongX ? w : d) / 2 - legW / 2);
    seg(ctx, {
      x: alongX ? cx + off : cx,
      z: alongX ? cz : cz + off,
      y: 0,
      w: alongX ? legW : thick,
      d: alongX ? thick : legW,
      h: H,
      style: Style.GlassOffice,
      colorA: tint(r, 'neutral'),
      colorB,
      flags: SegFlags.EdgeGlow,
    });
  }
  const spanH = H * 0.12;
  seg(ctx, {
    x: cx,
    z: cz,
    y: H - spanH,
    w: alongX ? w : thick,
    d: alongX ? thick : d,
    h: spanH,
    style: Style.LedFacade,
    colorB,
    flags: SegFlags.EdgeGlow,
  });
  ctx.roofs.push([cx, H, cz, Math.min(w, d)]);
}

/** LED-wrapped slab (Shenzhen) with a bright podium. */
export function ledSlab(ctx: BuildCtx, lot: Lot, H: number) {
  const r = ctx.rng;
  const ph = r.range(12, 30);
  podium(ctx, lot, ph);
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.z0 + lot.z1) / 2;
  const w = (lot.x1 - lot.x0) * 0.9;
  const d = (lot.z1 - lot.z0) * 0.9;
  const shape = r.chance(0.3)
    ? Shape.Oct
    : r.chance(0.2)
      ? Shape.Hex
      : Shape.Box;
  seg(ctx, {
    x: cx,
    z: cz,
    y: ph,
    w,
    d,
    h: H - ph,
    shape,
    style: Style.LedFacade,
    colorB: neon(r),
    colorA: neon(r),
    floorH: 3.5,
  });
  addSlots(ctx, cx, cz, w, d, ph, H);
  crown(ctx, cx, cz, H, w * 0.8, d * 0.8, Style.MetalPanel);
}

/** Wedge-roofed tower. */
export function wedgeTower(ctx: BuildCtx, lot: Lot, H: number, style: Style) {
  const r = ctx.rng;
  const ph = r.range(12, 30);
  podium(ctx, lot, ph);
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.z0 + lot.z1) / 2;
  const w = (lot.x1 - lot.x0) * 0.85;
  const d = (lot.z1 - lot.z0) * 0.85;
  const body = (H - ph) * 0.8;
  const colorA = tint(r);
  const colorB = neon(r);
  seg(ctx, {
    x: cx,
    z: cz,
    y: ph,
    w,
    d,
    h: body,
    style,
    colorA,
    colorB,
    flags: SegFlags.EdgeGlow,
  });
  seg(ctx, {
    x: cx,
    z: cz,
    y: ph + body,
    w,
    d,
    h: (H - ph) * 0.2,
    shape: Shape.Wedge,
    rotY: r.int(0, 2) * Math.PI,
    style,
    colorA,
    colorB,
    flags: SegFlags.EdgeGlow,
  });
  ctx.roofs.push([cx, H, cz, Math.min(w, d)]);
}
