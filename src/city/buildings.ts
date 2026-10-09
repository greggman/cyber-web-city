// Building archetypes. Each pushes a stack of segments for one lot.
import type {Rng} from '../math/random';
import {
  type BlockPalette,
  NEON_WHITE,
  RED,
  paletteColor as blockColor,
} from './palette';
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
  /** Segment the facade belongs to (-1 if unknown). */
  seg: number;
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

// Each superblock has a block palette (palette.ts, ART_BIBLE.md 15): a
// dominant and a secondary colour chosen by its district's rules.
let palette: BlockPalette = {
  dominant: RED,
  secondary: NEON_WHITE,
  accent: null,
  magenta: false,
};

export function setPalette(p: BlockPalette) {
  palette = p;
}

export function paletteColor(rng: Rng): [number, number, number] {
  return blockColor(rng, palette);
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
  /** Bay width of the facade grid (m); defaults per style. */
  bay?: number;
}

/** Facade bay width per style; must match default_bay() in segment.wgsl. */
export function defaultBay(style: Style): number {
  switch (style) {
    case Style.GlassOffice:
      return 1.5;
    case Style.Residential:
      return 3.6;
    case Style.MetalPanel:
      return 1.5;
    case Style.Slum:
      return 3.0;
    case Style.Monolith:
      return 6.0;
    case Style.Podium:
      return 3.0;
    case Style.Structure:
      return 8.0;
    default:
      return 2.0;
  }
}

export const WINDOWED = new Set<Style>([
  Style.GlassOffice,
  Style.Residential,
  Style.MetalPanel,
  Style.Slum,
  Style.Monolith,
  Style.Podium,
]);

/** Corner pier width when a face is snapped to whole bays. */
export const PIER = 1;

/**
 * Snaps a face width to whole bays plus two corner piers (ART_BIBLE.md 3),
 * so windows never get clipped at building corners. Rounds to the nearest
 * bay count (changes the width by at most half a bay).
 */
export function snapFace(w: number, bay: number): number {
  const n = Math.round((w - 2 * PIER) / bay);
  if (n < 1) return w;
  return n * bay + 2 * PIER;
}

/** Stores a typology/district id in the alpha byte of a packed color. */
export function withTypology(color: number, id: number): number {
  return ((color & 0xffffff) | ((id & 0xff) << 24)) >>> 0;
}

/** Stores the bay width (decimetres) in the alpha byte of a packed color. */
export function withBay(color: number, bay: number): number {
  const a = Math.max(1, Math.min(254, Math.round(bay * 10)));
  return ((color & 0xffffff) | (a << 24)) >>> 0;
}

export function seg(ctx: BuildCtx, o: SegOpts) {
  // Backstop against z-fighting: pieces generated independently can end up
  // sharing an exact plane (same width, same top). A deterministic sub-
  // percent jitter of size and top keeps any two pieces from being exactly
  // coplanar without visibly changing the design.
  const j = (k: number) => 1 + (ctx.rng.next() - 0.5) * k;
  const style = o.style ?? Style.GlassOffice;
  const shape = o.shape ?? Shape.Box;
  const bay = o.bay ?? defaultBay(style);
  let w = o.w;
  let d = o.d;
  if (shape <= Shape.BoxTwist && WINDOWED.has(style)) {
    w = snapFace(w, bay);
    d = snapFace(d, bay);
  }
  ctx.segs.push({
    x: o.x,
    y: o.y,
    z: o.z,
    rotY: o.rotY ?? 0,
    sx: w * j(0.008),
    sy: o.h * j(0.004),
    sz: d * j(0.008),
    taper: o.taper ?? 1,
    twist: o.twist ?? 0,
    shape,
    style,
    seed: ctx.rng.nextU32(),
    colorA: withBay(o.colorA ?? tint(ctx.rng), bay),
    // The typology byte holds the district for now (shop bays etc.).
    colorB: withTypology(o.colorB ?? neon(ctx.rng), ctx.district),
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
  seg = ctx.segs.count - 1,
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
      seg,
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
    floorH: 4.5,
    colorA: tint(ctx.rng, 'neutral'),
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
/**
 * Kitbash massing for one tier (Megacity-style): breaks a plain box into a
 * composition of volumes that reads from a distance: bay stacks jutting out
 * of the faces, ring bands wrapping the shaft and corner pilasters. All of
 * it stays inside the lot.
 */
export function kitbashTier(
  ctx: BuildCtx,
  lot: Lot,
  cx: number,
  cz: number,
  w: number,
  d: number,
  y: number,
  h: number,
  style: Style,
  colorA: number,
  colorB: number,
  floorH: number,
  opts: {
    bays?: number;
    bands?: boolean;
    pilasters?: boolean;
    bay?: number;
  } = {},
) {
  // Massing on the host's bay grid (ART_BIBLE.md 5, "enclosure"): stacks
  // whole bays wide, in the host's style, starting on floor lines and
  // spanning the full tier or multiples of five floors. No random sizes.
  const r = ctx.rng;
  if (h < 20 || w < 14 || d < 14) return;
  const stacks = opts.bays ?? 1;
  const bay = opts.bay ?? defaultBay(style);
  const windowed = WINDOWED.has(style);
  const sw = windowed ? snapFace(w, bay) : w;
  const sd = windowed ? snapFace(d, bay) : d;
  // Room to the lot edge on each side: -x, +x, -z, +z.
  const room = [
    cx - sw / 2 - lot.x0,
    lot.x1 - (cx + sw / 2),
    cz - sd / 2 - lot.z0,
    lot.z1 - (cz + sd / 2),
  ];
  const firstFloor = Math.ceil(y / floorH);
  const floors = Math.floor((y + h) / floorH) - firstFloor;
  for (let side = 0; side < 4; side++) {
    const n = r.int(0, stacks + 2) - 1;
    const faceLen = side < 2 ? sd : sw;
    const nFace = Math.round((faceLen - 2 * PIER) / bay);
    for (let k = 0; k < n; k++) {
      // 1-2 bays on coarse grids, a 6-9 m group of modules on fine ones.
      const nb = bay >= 3 ? r.int(1, 3) : r.int(4, 7);
      if (nb > nFace - 2) continue;
      const b0 = r.int(1, nFace - nb);
      const along = (b0 + nb / 2 - nFace / 2) * bay;
      const bw = nb * bay + 2 * PIER;
      const bd = Math.min(r.range(1.5, 4), room[side] + 1.5);
      if (bd < 1.2) continue;
      let f0 = 0;
      let nf = floors;
      if (floors >= 10 && r.chance(0.5)) {
        nf = 5 * r.int(1, Math.floor(floors / 5) + 1);
        f0 = r.int(0, floors - nf + 1);
      }
      if (nf < 3) continue;
      const by = (firstFloor + f0) * floorH;
      const bh = nf * floorH;
      // Embedded 1.5 m in the host so it reads as part of the building.
      const off = (side < 2 ? sw : sd) / 2 + bd / 2 - 1.5;
      const sgn = side % 2 === 0 ? -1 : 1;
      seg(ctx, {
        x: side < 2 ? cx + sgn * off : cx + along,
        z: side < 2 ? cz + along : cz + sgn * off,
        y: by,
        w: side < 2 ? bd + 3 : bw,
        d: side < 2 ? bw : bd + 3,
        h: bh,
        style,
        colorA,
        colorB,
        floorH,
        bay,
      });
    }
  }
  if (opts.bands !== false && style === Style.GlassOffice) {
    // Mechanical floors every 15 floors: a louvred double-height collar.
    const every = 15 * floorH;
    let by = Math.ceil((y + 12) / every) * every;
    while (by + 2 * floorH < y + h - 6) {
      const out = Math.min(r.range(0.6, 1.4), ...room.map(v => v + 1));
      seg(ctx, {
        x: cx,
        z: cz,
        y: by,
        w: sw + out * 2,
        d: sd + out * 2,
        h: 2 * floorH,
        style: Style.MetalPanel,
        colorA,
        colorB,
        floorH,
        flags: SegFlags.NoWindows,
      });
      by += every;
    }
  }
  if (opts.pilasters !== false && style === Style.Monolith && r.chance(0.35)) {
    // Stone corner pilasters running the full tier, poking above it.
    const pw = r.range(2.5, Math.min(6, sw * 0.15));
    const extra = r.range(0, 12);
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      seg(ctx, {
        x: cx + sx * (sw / 2 - pw / 2 + 0.6),
        z: cz + sz * (sd / 2 - pw / 2 + 0.6),
        y,
        w: pw,
        d: pw,
        h: h + extra,
        style: Style.Monolith,
        colorA,
        colorB,
        floorH,
        flags: SegFlags.NoWindows,
      });
    }
  }
}

export function setbackTower(
  ctx: BuildCtx,
  lot: Lot,
  H: number,
  style: Style,
  flags = 0,
) {
  const r = ctx.rng;
  const glass = style === Style.GlassOffice;
  // C1 (ART_BIBLE.md 4.1): 4 x 6 m podium; tiers are whole 15-floor
  // blocks so setbacks happen only at mechanical floors, one 9 m module
  // group per side; an open lattice crown.
  const ph = glass ? 24 : r.range(14, 36);
  podium(ctx, lot, ph);
  let w = (lot.x1 - lot.x0) * r.range(0.75, 0.95);
  let d = (lot.z1 - lot.z0) * r.range(0.75, 0.95);
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.z0 + lot.z1) / 2;
  const colorA = tint(r, glass ? 'cool' : undefined);
  const colorB = neon(r);
  const floorH =
    style === Style.Residential ? 3.2 : glass ? 4.2 : r.range(3.8, 4.4);
  const block = 15 * floorH;
  const blocks = Math.max(2, Math.round((H - ph) / block));
  const tiers = Math.min(r.int(2, 5), blocks);
  // Split the blocks between tiers (lower tiers get more).
  const perTier: number[] = [];
  let left = blocks;
  for (let t = 0; t < tiers; t++) {
    const n =
      t === tiers - 1
        ? left
        : Math.max(1, Math.round(left / (tiers - t) + r.range(-0.4, 0.8)));
    perTier.push(Math.min(n, left - (tiers - t - 1)));
    left -= perTier[t];
  }
  let y = ph;
  for (let t = 0; t < tiers; t++) {
    const h = perTier[t] * block;
    const tierStyle = style; // curtain walls stay glass (LED skins only on Market frames)
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
    kitbashTier(
      ctx,
      lot,
      cx,
      cz,
      w,
      d,
      y,
      h,
      tierStyle,
      colorA,
      colorB,
      floorH,
    );
    y += h;
    if (w > 40 && d > 40) {
      w -= 18;
      d -= 18;
    } else {
      w *= 0.85;
      d *= 0.85;
    }
    if (t < tiers - 1 && r.chance(0.22)) {
      // Sky lobby void at the mechanical floor: a narrow lit core.
      const vh = 2 * floorH;
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
    }
  }
  if (glass) {
    // Open lattice crown over the top three floors, one crown light, and a
    // mast on half of them.
    const ch = 3 * floorH;
    seg(ctx, {
      x: cx,
      z: cz,
      y,
      w,
      d,
      h: ch,
      style: Style.Structure,
      colorB,
      flags: SegFlags.TopGlow,
    });
    y += ch;
    if (r.chance(0.5)) {
      seg(ctx, {
        x: cx,
        z: cz,
        y,
        w: 3,
        d: 3,
        h: r.range(25, 70),
        taper: 0.3,
        style: Style.Structure,
        flags: SegFlags.RoofBeacon,
      });
    }
    ctx.roofs.push([cx, y, cz, Math.min(w, d)]);
    return;
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
  const floorH = r.range(3.6, 4.2);
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
    floorH,
  });
  // Rings only at mechanical floors (every 15 floors), at most four.
  if (r.chance(0.6)) {
    const mech = Math.floor(h / (15 * floorH));
    const step = Math.max(1, Math.ceil(mech / 4));
    for (let m = step; m < mech; m += step) {
      const t = (m * 15 * floorH) / h;
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
  // Signal red spheres (ART_BIBLE.md 15.9 #18).
  const colorB = packColor(RED[0], RED[1], RED[2]);
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
  // M1 slab block (ART_BIBLE.md 4.2): 2.75 m floors in stacks of 30,
  // separated by two-floor sky streets (inset, lit); upper stacks may step
  // in one 7.2 m unit on the long faces. Core lift rooms on the roof.
  const r = ctx.rng;
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.z0 + lot.z1) / 2;
  const colorA = tint(r, 'warm');
  const colorB = neon(r);
  const fh = 2.75;
  const ph = 22.5;
  podium(ctx, lot, ph);
  let ww = (lot.x1 - lot.x0) * 0.96;
  let dd = (lot.z1 - lot.z0) * 0.96;
  const stackH = 30 * fh;
  const streetH = 2 * fh;
  const longX = ww >= dd;
  let y = ph;
  while (y + stackH * 0.5 < H) {
    const h = Math.min(stackH, Math.ceil((H - y) / fh) * fh);
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
      floorH: fh,
    });
    addSlots(ctx, cx, cz, ww, dd, y, y + h);
    kitbashTier(
      ctx,
      lot,
      cx,
      cz,
      ww,
      dd,
      y,
      h,
      Style.Residential,
      colorA,
      colorB,
      fh,
      {
        bays: 2,
        bands: false,
      },
    );
    y += h;
    if (y + streetH + stackH * 0.5 >= H) break;
    // Sky street: inset 3 m, lit underside and railings.
    seg(ctx, {
      x: cx,
      z: cz,
      y,
      w: ww - 6,
      d: dd - 6,
      h: streetH,
      style: Style.Bridge,
      colorA,
      colorB,
      floorH: fh,
      flags: SegFlags.FloorBands,
    });
    y += streetH;
    if (r.chance(0.4)) {
      if (longX) dd = Math.max(16, dd - 14.4);
      else ww = Math.max(16, ww - 14.4);
    }
  }
  // Lift-motor rooms over the core: two floors, centred on the long face.
  const coreW = 2 * 3.6 + 2;
  seg(ctx, {
    x: cx,
    z: cz,
    y,
    w: longX ? coreW : ww * 0.5,
    d: longX ? dd * 0.5 : coreW,
    h: 2 * fh,
    style: Style.MetalPanel,
    flags: SegFlags.NoWindows | SegFlags.RoofBeacon,
  });
  ctx.roofs.push([cx, y, cz, Math.min(ww, dd)]);
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
  addSlots(ctx, cx, cz, w0, w0, 10, H * 0.25, -1);
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
  // One bay width per building: its windows stack floor to floor, while
  // neighbours differ (ART_BIBLE.md S1).
  const bay = r.range(2.4, 4.4);
  let first = true;
  while (y < H) {
    const h = Math.min(H - y, r.range(15, 60));
    const fh = r.range(2.8, 3.3);
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
      floorH: fh,
      bay: style === Style.Slum ? bay : undefined,
    });
    addSlots(ctx, x, z, w, d, first ? 3 : y, y + h);
    kitbashTier(ctx, lot, x, z, w, d, y, h, style, colorB, colorB, fh, {
      bay: style === Style.Slum ? bay : undefined,
      bays: 2,
      bands: false,
      pilasters: false,
    });
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
  const spanH = H * 0.12;
  for (const s of [-1, 1]) {
    const off = s * ((alongX ? w : d) / 2 - legW / 2);
    seg(ctx, {
      x: alongX ? cx + off : cx,
      z: alongX ? cz : cz + off,
      y: 0,
      w: alongX ? legW : thick,
      d: alongX ? thick : legW,
      // Legs stop inside the span so their roofs never share its plane.
      h: H - spanH * 0.5,
      style: Style.GlassOffice,
      colorA: tint(r, 'neutral'),
      colorB,
      flags: SegFlags.EdgeGlow,
    });
  }
  seg(ctx, {
    x: cx,
    z: cz,
    y: H - spanH,
    w: (alongX ? w : thick) * 1.02,
    d: (alongX ? thick : d) * 1.02,
    h: spanH,
    // ART_BIBLE.md C4: the span is a glazed bridge, not an LED skin.
    style: Style.Bridge,
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
  if (shape === Shape.Box) {
    kitbashTier(
      ctx,
      lot,
      cx,
      cz,
      w,
      d,
      ph,
      H - ph,
      Style.MetalPanel,
      neon(r),
      neon(r),
      3.5,
      {bays: 0},
    );
  }
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
  kitbashTier(ctx, lot, cx, cz, w, d, ph, body, style, colorA, colorB, 3.6);
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
