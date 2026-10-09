// Neon signs on facades, and the static lights of the city (signs, street
// lamps). Brands are invented: random syllables, kana and CJK characters.
import {Rng} from '../math/random';
import type {LightDesc} from '../render/lightClusters';
import {NEON, type FacadeSlot} from './buildings';
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

function brandGlyphs(rng: Rng, vertical: boolean): number[] {
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

export function generateSigns(
  seed: number,
  slots: FacadeSlot[],
): {signs: Sign[]; lights: LightDesc[]} {
  const rng = new Rng(seed, 4242);
  const signs: Sign[] = [];
  const lights: LightDesc[] = [];
  const density = [0.5, 0.6, 0.95, 0.95, 0.3];
  for (const slot of slots) {
    if (slot.height < 8 || slot.width < 8) continue;
    const p = density[slot.district] * (slot.avenue ? 1 : 0.06);
    if (!rng.chance(p)) continue;
    const busy =
      slot.district === District.Slum || slot.district === District.Market;
    const count = busy ? rng.int(1, slot.avenue ? 5 : 2) : 1;
    // right x up = normal (right-handed), so text reads left to right.
    const right: [number, number, number] = [slot.nz, 0, -slot.nx];
    const normal: [number, number, number] = [slot.nx, 0, slot.nz];
    for (let k = 0; k < count; k++) {
      const kind = busy
        ? (rng.weighted([3, 4, 2, 1]) as SignKind)
        : (rng.weighted([5, 1, 2, 0.5]) as SignKind);
      let w: number;
      let h: number;
      let thick = 0.6;
      if (kind === SignKind.Flat) {
        w = Math.min(slot.width * 0.8, rng.range(10, busy ? 28 : 45));
        h = w * rng.range(0.18, 0.32);
      } else if (kind === SignKind.Blade) {
        w = rng.range(3, 6);
        h = rng.range(12, 42);
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
      const yc =
        slot.y +
        h / 2 +
        3 +
        Math.pow(rng.next(), 1.6) * Math.max(0, maxY - slot.y - h / 2 - 3);
      const along =
        rng.range(-0.5, 0.5) *
        Math.max(0, slot.width - (kind === SignKind.Blade ? 4 : w) - 4);
      const out = kind === SignKind.Blade ? w / 2 + 0.3 : thick / 2 + 0.15;
      const pos: [number, number, number] = [
        slot.x + right[0] * along + normal[0] * out,
        yc,
        slot.z + right[2] * along + normal[2] * out,
      ];
      const col = rng.pick(NEON);
      const col2 = rng.pick(NEON);
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
      signs.push(sign);
      const area = Math.sqrt(w * h);
      const intensity = (lightbox ? 3 : 2) * Math.min(2.5, area / 6);
      const lp: [number, number, number] = [
        slot.x + right[0] * along + normal[0] * (out + 3 + w * 0.2),
        yc,
        slot.z + right[2] * along + normal[2] * (out + 3 + w * 0.2),
      ];
      lights.push({
        pos: lp,
        radius: 14 + area * 1.6,
        color: [col[0] * intensity, col[1] * intensity, col[2] * intensity],
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
          pos: [a * SUPER + off, 9, s + rng.range(0, 20)],
          radius: 55,
          color: c,
        });
        lights.push({
          pos: [s + rng.range(0, 20), 9, a * SUPER + off],
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
