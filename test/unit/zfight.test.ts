import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateCity} from '../../src/city/generate';
import {Shape} from '../../src/city/meshes';
import {Style} from '../../src/city/segments';

const STYLE_NAMES = [
  'GlassOffice',
  'Residential',
  'MetalPanel',
  'LedFacade',
  'Slum',
  'Monolith',
  'Podium',
  'Structure',
  'NeonRing',
  'Bridge',
  'Ground',
];

// Finds pairs of axis-aligned box segments whose faces are coplanar and
// overlap (visible z-fighting). Reports by style pair.
export function findCoplanar(seed: number) {
  const city = generateCity(seed);
  const segs = city.segments;
  type B = {
    i: number;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    z0: number;
    z1: number;
    style: number;
  };
  const boxes: B[] = [];
  for (let i = 0; i < segs.count; i++) {
    const s = segs.get(i);
    if (s.style === Style.Ground) continue;
    if (s.shape !== Shape.Box || s.taper !== 1 || s.twist !== 0) continue;
    const rot = ((s.rotY % Math.PI) + Math.PI) % Math.PI;
    const swap = Math.abs(rot - Math.PI / 2) < 1e-3;
    if (!swap && Math.abs(rot) > 1e-3 && Math.abs(rot - Math.PI) > 1e-3)
      continue;
    const hx = (swap ? s.sz : s.sx) / 2;
    const hz = (swap ? s.sx : s.sz) / 2;
    boxes.push({
      i,
      x0: s.x - hx,
      x1: s.x + hx,
      y0: s.y,
      y1: s.y + s.sy,
      z0: s.z - hz,
      z1: s.z + hz,
      style: s.style,
    });
  }
  const CELL = 200;
  const grid = new Map<string, B[]>();
  for (const b of boxes) {
    for (let cx = Math.floor(b.x0 / CELL); cx <= Math.floor(b.x1 / CELL); cx++)
      for (
        let cz = Math.floor(b.z0 / CELL);
        cz <= Math.floor(b.z1 / CELL);
        cz++
      ) {
        const k = `${cx},${cz}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(b);
      }
  }
  const eps = 0.001;
  const ov = (a0: number, a1: number, b0: number, b1: number) =>
    Math.min(a1, b1) - Math.max(a0, b0) > 0.5;
  const hits = new Map<string, number>();
  const examples: string[] = [];
  const seen = new Set<string>();
  for (const cell of grid.values()) {
    for (let a = 0; a < cell.length; a++) {
      for (let b = a + 1; b < cell.length; b++) {
        const A = cell[a];
        const B2 = cell[b];
        const key = A.i < B2.i ? `${A.i}-${B2.i}` : `${B2.i}-${A.i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let kind = '';
        // Same-facing coplanar faces that overlap.
        if (
          Math.abs(A.y1 - B2.y1) < eps &&
          ov(A.x0, A.x1, B2.x0, B2.x1) &&
          ov(A.z0, A.z1, B2.z0, B2.z1)
        )
          kind = 'top';
        else if (
          ov(A.y0, A.y1, B2.y0, B2.y1) &&
          (((Math.abs(A.x0 - B2.x0) < eps || Math.abs(A.x1 - B2.x1) < eps) &&
            ov(A.z0, A.z1, B2.z0, B2.z1)) ||
            ((Math.abs(A.z0 - B2.z0) < eps || Math.abs(A.z1 - B2.z1) < eps) &&
              ov(A.x0, A.x1, B2.x0, B2.x1)))
        )
          kind = 'side';
        if (!kind) continue;
        const k = `${kind}:${STYLE_NAMES[A.style] ?? A.style}/${STYLE_NAMES[B2.style] ?? B2.style}`;
        hits.set(k, (hits.get(k) ?? 0) + 1);
        if (examples.length < 10)
          examples.push(
            `${k} at (${A.x0.toFixed(0)},${A.y1.toFixed(0)},${A.z0.toFixed(0)})`,
          );
      }
    }
  }
  return {hits, examples, boxes: boxes.length};
}

test('no coplanar overlapping box faces (z-fighting)', () => {
  const r = findCoplanar(1);
  const total = [...r.hits.values()].reduce((a, b) => a + b, 0);
  if (total) console.log(r.boxes, Object.fromEntries(r.hits), r.examples);
  assert.ok(total < 20, `${total} coplanar face pairs`);
});
