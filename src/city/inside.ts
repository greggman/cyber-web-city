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
    if (g.style === Style.Ground || g.shape > Shape.Oct) continue;
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
