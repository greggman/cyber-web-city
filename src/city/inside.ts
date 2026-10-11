// Point-in-building queries over the whole city (rotated, tapered boxes),
// with a spatial hash. Used to keep signs out of walls and other pieces.
import {SegmentList, Style} from './segments';
import {Shape} from './meshes';

const CELL = 32;

export function makeInsideTest(
  segs: SegmentList,
): (x: number, y: number, z: number, margin?: number) => number {
  const grid = new Map<number, number[]>();
  // Flat per-segment data (segs.get() allocates; this is queried millions
  // of times): x, z, y0, y1, half sx, half sz, taper, cos, sin, round.
  const F = 10;
  const d = new Float64Array(segs.count * F);
  const key = (cx: number, cz: number) => (cx + 8192) * 16384 + (cz + 8192);
  for (let i = 0; i < segs.count; i++) {
    const g = segs.get(i);
    if (
      g.style === Style.Ground ||
      g.style === Style.Water ||
      g.shape > Shape.Oct
    )
      continue;
    d.set(
      [
        g.x,
        g.z,
        g.y,
        g.y + g.sy,
        g.sx / 2,
        g.sz / 2,
        g.taper,
        Math.cos(-g.rotY),
        Math.sin(-g.rotY),
        g.shape >= Shape.Cylinder ? 1 : 0,
      ],
      i * F,
    );
    const r = Math.hypot(g.sx, g.sz) * 0.5 * Math.max(1, g.taper);
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
  /** Returns the index of a segment containing the point (grown by
   * `margin` m), or -1. */
  return (x, y, z, margin = 0) => {
    const list = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return -1;
    for (const i of list) {
      const o = i * F;
      const y0 = d[o + 2];
      const y1 = d[o + 3];
      if (y < y0 - margin || y > y1 + margin) continue;
      const h = Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
      const tp = 1 + (d[o + 6] - 1) * h;
      const dx = x - d[o];
      const dz = z - d[o + 1];
      const lx = d[o + 7] * dx - d[o + 8] * dz;
      const lz = d[o + 8] * dx + d[o + 7] * dz;
      const hx = d[o + 4] * tp + margin;
      const hz = d[o + 5] * tp + margin;
      if (d[o + 9] > 0) {
        if (Math.hypot(lx / hx, lz / hz) <= 1) return i;
      } else if (Math.abs(lx) <= hx && Math.abs(lz) <= hz) {
        return i;
      }
    }
    return -1;
  };
}

export interface Repel {
  /** Push acceleration (m/s^2), summed over nearby buildings. */
  push: [number, number, number];
  /** Distance to the nearest building surface (negative inside) and the
   * outward normal there. */
  dist: number;
  normal: [number, number, number];
}

/**
 * A soft repel field around the buildings for user-flown cars: within
 * `range` m of a wall the car is pushed out along the wall's normal,
 * harder the closer (and much harder inside). Boxes approximate every
 * shape; that's plenty for "don't fly through buildings".
 */
export function makeRepelField(
  segs: SegmentList,
  range = 9,
): (x: number, y: number, z: number) => Repel {
  const CELL2 = 48;
  const grid = new Map<number, number[]>();
  const key = (cx: number, cz: number) => (cx + 8192) * 16384 + (cz + 8192);
  const F = 10;
  const d = new Float64Array(segs.count * F);
  for (let i = 0; i < segs.count; i++) {
    const g = segs.get(i);
    if (g.style === Style.Ground || g.style === Style.Water) continue;
    if (g.shape > Shape.Oct || g.sx < 0.5 || g.sz < 0.5) continue;
    d.set(
      [
        g.x,
        g.z,
        g.y,
        g.y + g.sy,
        g.sx / 2,
        g.sz / 2,
        g.taper,
        Math.cos(-g.rotY),
        Math.sin(-g.rotY),
        1,
      ],
      i * F,
    );
    const r = Math.hypot(g.sx, g.sz) * 0.5 * Math.max(1, g.taper) + range;
    for (
      let cx = Math.floor((g.x - r) / CELL2);
      cx <= Math.floor((g.x + r) / CELL2);
      cx++
    ) {
      for (
        let cz = Math.floor((g.z - r) / CELL2);
        cz <= Math.floor((g.z + r) / CELL2);
        cz++
      ) {
        const k = key(cx, cz);
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(i);
      }
    }
  }
  return (x, y, z) => {
    const out: Repel = {push: [0, 0, 0], dist: Infinity, normal: [0, 1, 0]};
    const list = grid.get(key(Math.floor(x / CELL2), Math.floor(z / CELL2)));
    if (!list) return out;
    for (const i of list) {
      const o = i * F;
      if (d[o + 9] === 0) continue;
      const y0 = d[o + 2];
      const y1 = d[o + 3];
      const h = Math.min(1, Math.max(0, (y - y0) / Math.max(y1 - y0, 1e-3)));
      const tp = 1 + (d[o + 6] - 1) * h;
      const c = d[o + 7];
      const s = d[o + 8];
      const dx = x - d[o];
      const dz = z - d[o + 1];
      const l = [c * dx - s * dz, y - (y0 + y1) / 2, s * dx + c * dz];
      const he = [d[o + 4] * tp, (y1 - y0) / 2, d[o + 5] * tp];
      const q = l.map((v, k) => Math.abs(v) - he[k]);
      const qo = q.map(v => Math.max(v, 0));
      const outD = Math.hypot(qo[0], qo[1], qo[2]);
      const inD = Math.min(Math.max(q[0], q[1], q[2]), 0);
      const dist = outD + inD;
      if (dist > range) continue;
      // Outward normal in local space.
      let n: number[];
      if (outD > 0) {
        n = qo.map((v, k) => (Math.sign(l[k]) * v) / outD);
      } else {
        const k = q[0] >= q[1] && q[0] >= q[2] ? 0 : q[1] >= q[2] ? 1 : 2;
        n = [0, 0, 0];
        n[k] = Math.sign(l[k]) || 1;
      }
      // Back to world (inverse of the rotation above).
      const nw: [number, number, number] = [
        c * n[0] + s * n[2],
        n[1],
        -s * n[0] + c * n[2],
      ];
      const t = Math.max(0, (range - dist) / range);
      const k = (dist < 0 ? 120 : 45) * t * t;
      out.push[0] += nw[0] * k;
      out.push[1] += nw[1] * k;
      out.push[2] += nw[2] * k;
      if (dist < out.dist) {
        out.dist = dist;
        out.normal = nw;
      }
    }
    return out;
  };
}
