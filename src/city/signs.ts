// Neon signs on facades, and the static lights of the city (signs, street
// lamps). Brands are invented: random syllables, kana and CJK characters.
import {Rng} from '../math/random';
import {unwarp, warp3} from './warp';
import type {LightDesc} from '../render/lightClusters';
import {type FacadeSlot} from './buildings';
import {type BlockPalette, blockPalette, paletteColor} from './palette';
import {AVENUE_W, CITY_RADIUS_SUPERS, District, SUPER} from './layout';
import {
  CJK_COUNT,
  CJK_START,
  KANA_COUNT,
  KANA_START,
  LATIN_START,
} from '../render/glyphs';
import {packColor} from './segments';

export const SIGN_BYTES = 64;

export const enum SignKind {
  Flat = 0, // horizontal text flat on the wall
  Blade = 1, // vertical text, protruding perpendicular to the wall
  Column = 2, // vertical text flat on the wall
  Frame = 3, // abstract neon shapes
}

export interface Sign {
  pos: [number, number, number]; // center
  kind: SignKind;
  right: [number, number, number];
  width: number;
  normal: [number, number, number];
  height: number;
  colorA: number;
  colorB: number;
  glyphs: number[]; // up to 8
  lightbox: boolean;
  thickness: number;
}

export function brandGlyphs(rng: Rng, vertical: boolean): number[] {
  const n = vertical ? rng.int(2, 6) : rng.int(3, 8);
  const script = rng.weighted(vertical ? [1, 2, 5] : [4, 2, 3]);
  const out: number[] = [];
  if (script === 0) {
    // Pronounceable fake brand: consonant-vowel syllables.
    const C = 'BDGKLMNRSTVZXY';
    const V = 'AEIOU';
    let s = '';
    while (s.length < n) s += C[rng.int(0, C.length)] + V[rng.int(0, V.length)];
    for (const ch of s.slice(0, n))
      out.push(LATIN_START + ch.charCodeAt(0) - 65);
    if (rng.chance(0.3) && n < 8) out.push(LATIN_START + 26 + rng.int(0, 10));
  } else if (script === 1) {
    for (let i = 0; i < n; i++) out.push(KANA_START + rng.int(0, KANA_COUNT));
  } else {
    for (let i = 0; i < n; i++) out.push(CJK_START + rng.int(0, CJK_COUNT));
  }
  return out.slice(0, 8);
}

// The block palette of a slot, computed once (unwarping is not cheap and
// signs ask for it per sign).
const blockCache = new WeakMap<FacadeSlot, BlockPalette>();
function slotBlock(slot: FacadeSlot): BlockPalette {
  let p = blockCache.get(slot);
  if (!p) {
    const [gu, gv] = unwarp(slot.x, slot.z);
    p = blockPalette(
      seedForPalette,
      Math.floor(gu / SUPER),
      Math.floor(gv / SUPER),
      slot.district,
    );
    blockCache.set(slot, p);
  }
  return p;
}

/** Signs use their block's palette (palette.ts): dominant 60%, secondary
 * 30%, warm white 10%. */
function slotPalette(rng: Rng, slot: FacadeSlot): [number, number, number] {
  const block = slotBlock(slot);
  // The building's own colour leads; some signs follow the neighbourhood,
  // some are plain warm white (ART_BIBLE.md 15.2c).
  if (slot.color) {
    const r = rng.next();
    if (r < 0.55) return slot.color;
    if (r < 0.8) return block.dominant;
    return [1.0, 0.723, 0.434];
  }
  return paletteColor(rng, block);
}

/** The district accent for one deliberate sign (one per Slum tenement). */
function slotAccent(slot: FacadeSlot): [number, number, number] | null {
  return slot.district === District.Slum ? slotBlock(slot).accent : null;
}
let seedForPalette = 0;

/**
 * Rejects signs that would sit inside a building (z-fighting with or
 * buried in a wall or a bolted-on piece) or overlap a sign already placed.
 */
function makePlacer(
  inside: ((x: number, y: number, z: number) => number) | undefined,
) {
  const CELL = 12;
  const grid = new Map<number, {s: Sign; pts: Float64Array}[]>();
  const key = (cx: number, cz: number) => (cx + 8192) * 16384 + (cz + 8192);
  // 3x3 sample points over a sign's face (its right x up plane), flat.
  const samples = (s: Sign): Float64Array => {
    const pts = new Float64Array(27);
    let o = 0;
    for (const a of [-0.48, 0, 0.48]) {
      for (const b of [-0.48, 0, 0.48]) {
        pts[o++] = s.pos[0] + s.right[0] * a * s.width;
        pts[o++] = s.pos[1] + b * s.height;
        pts[o++] = s.pos[2] + s.right[2] * a * s.width;
      }
    }
    return pts;
  };
  // Does any sample point fall within sign t's slab (rectangle, thickened)?
  const hits = (t: Sign, pts: Float64Array) => {
    const hd = t.thickness / 2 + 0.25;
    const ha = t.width / 2 + 0.1;
    const hh = t.height / 2 + 0.1;
    for (let o = 0; o < 27; o += 3) {
      const dx = pts[o] - t.pos[0];
      const dy = pts[o + 1] - t.pos[1];
      const dz = pts[o + 2] - t.pos[2];
      if (
        Math.abs(dx * t.normal[0] + dz * t.normal[2]) < hd &&
        Math.abs(dx * t.right[0] + dz * t.right[2]) < ha &&
        Math.abs(dy) < hh
      ) {
        return true;
      }
    }
    return false;
  };
  return (s: Sign): boolean => {
    const pts = samples(s);
    if (inside) {
      // Corners and centre, slightly in front of the face so the wall it
      // hangs on is clear.
      for (const k of [0, 2, 4, 6, 8]) {
        const o = k * 3;
        const x = pts[o] + s.normal[0] * 0.05;
        const z = pts[o + 2] + s.normal[2] * 0.05;
        if (inside(x, pts[o + 1], z) >= 0) return false;
      }
    }
    // Each sign is registered in every grid cell its extent covers, so
    // a query only needs those same cells.
    const ext = Math.max(s.width, s.height) / 2 + 1;
    const x0 = Math.floor((s.pos[0] - ext) / CELL);
    const x1 = Math.floor((s.pos[0] + ext) / CELL);
    const z0 = Math.floor((s.pos[2] - ext) / CELL);
    const z1 = Math.floor((s.pos[2] + ext) / CELL);
    const y0 = s.pos[1] - s.height / 2 - 0.5;
    const y1 = s.pos[1] + s.height / 2 + 0.5;
    for (let i = x0; i <= x1; i++) {
      for (let j = z0; j <= z1; j++) {
        const list = grid.get(key(i, j));
        if (!list) continue;
        for (const t of list) {
          const ty = t.s.pos[1];
          const th = t.s.height / 2;
          if (ty + th < y0 || ty - th > y1) continue;
          if (hits(t.s, pts) || hits(s, t.pts)) return false;
        }
      }
    }
    const entry = {s, pts};
    for (let i = x0; i <= x1; i++) {
      for (let j = z0; j <= z1; j++) {
        const k = key(i, j);
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(entry);
      }
    }
    return true;
  };
}

export function generateSigns(
  seed: number,
  slots: FacadeSlot[],
  /** Point-in-building test (inside.ts); signs inside buildings are dropped. */
  inside?: (x: number, y: number, z: number) => number,
): {signs: Sign[]; lights: LightDesc[]} {
  const place = makePlacer(inside);
  const rng = new Rng(seed, 4242);
  seedForPalette = seed;
  const signs: Sign[] = [];
  const lights: LightDesc[] = [];
  const density = [0.5, 0.6, 0.95, 0.95, 0.3];
  for (const slot of slots) {
    if (slot.height < 8 || slot.width < 8) continue;
    const p = density[slot.district] * (slot.avenue ? 1 : 0.06);
    if (!rng.chance(p)) continue;
    const busy =
      slot.district === District.Slum || slot.district === District.Market;
    if (slot.y > 480) continue;
    const count = Math.min(
      busy ? (slot.avenue ? rng.int(2, 8) : rng.int(0, 2)) : rng.int(1, 3),
      Math.ceil(slot.height / 18),
    );
    // Hero dressing: one tall corner blade per 60 m of avenue frontage, at
    // 40-120 m, on the corner bay (ART_BIBLE.md 8).
    const heroBlades =
      slot.avenue && slot.height > 70
        ? Math.max(1, Math.floor(slot.width / 60))
        : 0;
    // right x up = normal (right-handed), so text reads left to right.
    const right: [number, number, number] = [slot.nz, 0, -slot.nx];
    const slotLights: LightDesc[] = [];
    const normal: [number, number, number] = [slot.nx, 0, slot.nz];
    for (let k = 0; k < count + heroBlades; k++) {
      const hero = k >= count;
      const kind = hero
        ? SignKind.Blade
        : busy
          ? (rng.weighted([3, 4, 2, 1]) as SignKind)
          : (rng.weighted([5, 1, 2, 0.5]) as SignKind);
      let w: number;
      let h: number;
      let thick = 0.6;
      if (kind === SignKind.Flat) {
        w = Math.min(slot.width * 0.8, rng.range(10, busy ? 28 : 45));
        h = w * rng.range(0.18, 0.32);
      } else if (kind === SignKind.Blade) {
        w = rng.range(3.5, 8);
        h = hero ? rng.range(30, 60) : rng.range(12, 45);
        thick = 0.8;
      } else if (kind === SignKind.Column) {
        w = rng.range(3.5, 7);
        h = rng.range(15, 55);
      } else {
        w = rng.range(8, 20);
        h = w * rng.range(0.5, 1);
      }
      const maxY =
        slot.y + Math.max(10, Math.min(slot.height - h / 2 - 2, 420));
      let yc =
        slot.y +
        h / 2 +
        3 +
        Math.pow(rng.next(), 1.6) * Math.max(0, maxY - slot.y - h / 2 - 3);
      let along =
        rng.range(-0.5, 0.5) *
        Math.max(0, slot.width - (kind === SignKind.Blade ? 4 : w) - 4);
      if (hero) {
        const lo = Math.max(slot.y + h / 2 + 2, 40 + h / 2);
        const hi = Math.min(slot.y + slot.height - h / 2 - 2, 120 + h / 2);
        if (hi < lo) continue;
        yc = rng.range(lo, hi);
        const corner = k - count;
        const side = corner % 2 === 0 ? -1 : 1;
        along = side * (slot.width / 2 - 3 - Math.floor(corner / 2) * 60);
      }
      const out = kind === SignKind.Blade ? w / 2 + 0.3 : thick / 2 + 0.15;
      const pos: [number, number, number] = [
        slot.x + right[0] * along + normal[0] * out,
        yc,
        slot.z + right[2] * along + normal[2] * out,
      ];
      const col = slotPalette(rng, slot);
      const col2 = slotPalette(rng, slot);
      const lightbox = kind !== SignKind.Frame && rng.chance(0.25);
      const sign: Sign = {
        pos,
        kind,
        // A blade's text faces along the wall (its "right" is the wall normal).
        right: kind === SignKind.Blade ? normal : right,
        normal: kind === SignKind.Blade ? [-right[0], 0, -right[2]] : normal,
        width: w,
        height: h,
        colorA: packColor(col[0], col[1], col[2]),
        colorB: packColor(col2[0], col2[1], col2[2]),
        glyphs: brandGlyphs(
          rng,
          kind === SignKind.Blade || kind === SignKind.Column,
        ),
        lightbox,
        thickness: thick,
      };
      if (!place(sign)) continue;
      signs.push(sign);
      const area = Math.sqrt(w * h);
      const intensity = (lightbox ? 4 : 3) * Math.min(2.5, area / 6);
      const lp: [number, number, number] = [
        slot.x + right[0] * along + normal[0] * (out + 3 + w * 0.2),
        yc,
        slot.z + right[2] * along + normal[2] * (out + 3 + w * 0.2),
      ];
      slotLights.push({
        pos: lp,
        radius: 14 + area * 1.9,
        color: [col[0] * intensity, col[1] * intensity, col[2] * intensity],
      });
    }
    // Merge neighbouring signs' lights (sorted by height, groups of three)
    // so stacked signs don't add up to a pastel wash.
    slotLights.sort((a, b) => a.pos[1] - b.pos[1]);
    for (let g = 0; g < slotLights.length; g += 3) {
      const grp = slotLights.slice(g, g + 3);
      const k = 1 / grp.length;
      const pos: [number, number, number] = [0, 0, 0];
      const color: [number, number, number] = [0, 0, 0];
      let radius = 0;
      for (const l of grp) {
        for (let c = 0; c < 3; c++) {
          pos[c] += l.pos[c] * k;
          color[c] += l.color[c] * (grp.length > 1 ? 0.55 : 1);
        }
        radius = Math.max(radius, l.radius);
      }
      lights.push({pos, radius: radius * 1.15, color});
    }
  }
  // Street-level projecting signs (ART_BIBLE.md 7): small blades above
  // the shop canopies, 3 sizes, staggered so neighbours never share a
  // height. 3-5 per 30 m in Market, x0.7 in Slum, half in Core; one shared
  // light per facade so their glow rakes across the wet walls.
  const srng = new Rng(seed, 4343);
  const streetRate = [0.5, 0.35, 0.7, 1, 0.2];
  const sizes = [1.2, 2.0, 3.0];
  for (const slot of slots) {
    if (slot.y > 6 || slot.width < 6) continue;
    const n = Math.round(
      (slot.width / 30) * srng.range(3, 5) * streetRate[slot.district],
    );
    if (n <= 0) continue;
    const right: [number, number, number] = [slot.nz, 0, -slot.nx];
    const normal: [number, number, number] = [slot.nx, 0, slot.nz];
    let lastLevel = -1;
    let first: [number, number, number] | null = null;
    for (let k = 0; k < n; k++) {
      let level = srng.int(0, 3);
      if (level === lastLevel) level = (level + 1) % 3;
      lastLevel = level;
      const h = sizes[srng.int(0, 3)];
      const w = srng.range(0.8, 1.4);
      const along =
        ((k + 0.5) / n - 0.5) * (slot.width - 3) + srng.range(-0.8, 0.8);
      const yc = 5.2 + level * 1.4 + h / 2;
      const out = w / 2 + 0.3;
      // One deliberate accent sign per slum tenement (ART_BIBLE.md 15.2b).
      const acc = k === 0 ? slotAccent(slot) : null;
      const col = acc ?? slotPalette(srng, slot);
      const col2 = slotPalette(srng, slot);
      const sign: Sign = {
        pos: [
          slot.x + right[0] * along + normal[0] * out,
          yc,
          slot.z + right[2] * along + normal[2] * out,
        ],
        kind: SignKind.Blade,
        right: normal,
        normal: [-right[0], 0, -right[2]],
        width: w,
        height: h,
        colorA: packColor(col[0], col[1], col[2]),
        colorB: packColor(col2[0], col2[1], col2[2]),
        glyphs: brandGlyphs(srng, true),
        lightbox: srng.chance(0.4),
        thickness: 0.4,
      };
      if (!place(sign)) continue;
      first ??= col;
      signs.push(sign);
    }
    if (first) {
      const i = 2.2 * Math.min(2, n / 3);
      lights.push({
        pos: [slot.x + normal[0] * 3, 7, slot.z + normal[2] * 3],
        radius: 10 + slot.width * 0.3,
        color: [first[0] * i, first[1] * i, first[2] * i],
      });
    }
  }

  // Warm street lamps along the avenues (light the canyon floors).
  const N = CITY_RADIUS_SUPERS;
  for (let a = -N; a <= N; a++) {
    for (let s = -N * SUPER; s < N * SUPER; s += 55) {
      for (const side of [-1, 1]) {
        const off = side * (AVENUE_W / 2 - 4);
        const c: [number, number, number] = rng.chance(0.7)
          ? [5, 2.6, 1.0]
          : [2.2, 3.4, 5];
        lights.push({
          pos: warp3([a * SUPER + off, 9, s + rng.range(0, 20)]),
          radius: 55,
          color: c,
        });
        lights.push({
          pos: warp3([s + rng.range(0, 20), 9, a * SUPER + off]),
          radius: 55,
          color: c,
        });
      }
    }
  }
  return {signs, lights};
}

export function packSigns(signs: Sign[]): ArrayBuffer {
  const buf = new ArrayBuffer(Math.max(1, signs.length) * SIGN_BYTES);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  signs.forEach((s, i) => {
    const o = i * 16;
    f.set(s.pos, o);
    u[o + 3] =
      s.kind | (s.lightbox ? 0x100 : 0) | (Math.min(8, s.glyphs.length) << 16);
    f.set(s.right, o + 4);
    f[o + 7] = s.width;
    f.set(s.normal, o + 8);
    f[o + 11] = s.height;
    u[o + 12] = s.colorA;
    u[o + 13] = s.colorB;
    let lo = 0;
    let hi = 0;
    s.glyphs.forEach((g, j) => {
      if (j < 4) lo |= (g & 255) << (j * 8);
      else hi |= (g & 255) << ((j - 4) * 8);
    });
    u[o + 14] = lo >>> 0;
    u[o + 15] = hi >>> 0;
  });
  return buf;
}
