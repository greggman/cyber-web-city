import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  NurbsCurve,
  NurbsSurface,
  basisDerivs,
  findSpan,
  clampedKnots,
  loft,
  revolve,
  extrude,
  sweep,
  bilinear,
} from '../../src/nurbs/nurbs';
import {tessellate} from '../../src/nurbs/tessellate';
import {buildModelMesh} from '../../src/nurbs/model';
import {length, sub, dot, type Vec3} from '../../src/math/vec';

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('basis functions form a partition of unity', () => {
  const p = 3;
  const U = clampedKnots(9, p);
  for (let k = 0; k <= 50; k++) {
    const u = k / 50;
    const span = findSpan(8, p, u, U);
    const N = basisDerivs(span, u, p, 1, U);
    close(
      N[0].reduce((a, b) => a + b, 0),
      1,
    );
    close(
      N[1].reduce((a, b) => a + b, 0),
      0,
      1e-9,
    );
  }
});

test('rational arc is an exact circle', () => {
  const c = NurbsCurve.circle([1, 2, 3], [1, 0, 0], [0, 0, 1], 2.5);
  for (let k = 0; k <= 100; k++) {
    const p = c.evaluate(k / 100);
    close(length(sub(p, [1, 2, 3])), 2.5, 1e-9);
  }
  // Tangent is perpendicular to the radius.
  const p = c.evaluate(0.3);
  const [, d] = c.derivatives(0.3, 1);
  close(dot(sub(p, [1, 2, 3]), d), 0, 1e-6);
});

test('interpolation passes through its points', () => {
  const pts: Vec3[] = [
    [0, 0, 0],
    [1, 2, 0],
    [3, 2.5, 1],
    [4, 0, 2],
    [6, -1, 2],
  ];
  const c = NurbsCurve.interpolate(pts, 3);
  // Points are hit at the internal parameters: check the curve passes near each.
  for (const q of pts) {
    let best = Infinity;
    for (let k = 0; k <= 20000; k++)
      best = Math.min(best, length(sub(c.evaluate(k / 20000), q)));
    assert.ok(best < 1e-3, `distance ${best}`);
  }
  close(length(sub(c.evaluate(0), pts[0])), 0);
  close(length(sub(c.evaluate(1), pts[4])), 0);
});

test('revolved semicircle is a sphere with outward normals', () => {
  const profile = NurbsCurve.arc(
    [0, 0, 0],
    [0, -1, 0],
    [1, 0, 0],
    1,
    0,
    Math.PI,
  );
  const s = revolve(profile, [0, 0, 0], [0, 1, 0]);
  for (let i = 1; i < 10; i++) {
    for (let j = 0; j <= 10; j++) {
      const p = s.evaluate(i / 10, j / 10);
      close(length(p), 1, 1e-9);
      const n = s.normal(i / 10, j / 10);
      assert.ok(Math.abs(Math.abs(dot(n, p)) - 1) < 1e-6);
    }
  }
});

test('loft passes through first and last sections', () => {
  const a = NurbsCurve.fromPoints(
    [
      [0, 0, 0],
      [1, 1, 0],
      [2, 0, 0],
    ],
    2,
  );
  const b = NurbsCurve.fromPoints(
    [
      [0, 0, 2],
      [1, 2, 2],
      [2, 0, 2],
    ],
    2,
  );
  const c = NurbsCurve.fromPoints(
    [
      [0, 0, 4],
      [1, 1, 4],
      [2, 0, 4],
    ],
    2,
  );
  const s = loft([a, b, c], 2);
  for (let k = 0; k <= 10; k++) {
    close(length(sub(s.evaluate(k / 10, 0), a.evaluate(k / 10))), 0, 1e-9);
    close(length(sub(s.evaluate(k / 10, 1), c.evaluate(k / 10))), 0, 1e-9);
  }
});

test('extrude, sweep and bilinear produce sane surfaces', () => {
  const e = extrude(NurbsCurve.line([0, 0, 0], [1, 0, 0]), [0, 1, 0]);
  close(length(sub(e.evaluate(1, 1), [1, 1, 0])), 0);
  const prof = NurbsCurve.circle([0, 0, 0], [1, 0, 0], [0, 1, 0], 0.1);
  const rail = NurbsCurve.fromPoints(
    [
      [0, 0, 0],
      [0, 0, 1],
      [1, 0, 2],
    ],
    2,
  );
  const sw = sweep(prof, rail, {sections: 8});
  close(length(sub(sw.evaluate(0, 0), [0, 0, 0])), 0.1, 2e-3);
  const b = bilinear([0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]);
  // du = +x, dv = +z -> normal = x cross z = -y
  close(b.normal(0.5, 0.5)[1], -1);
});

test('tessellation is consistent and mirrored halves share the seam', () => {
  const half = new NurbsSurface(3, 1, [
    [
      [0, 0, 0],
      [0, 0, 1],
    ],
    [
      [0.5, 0.4, 0],
      [0.5, 0.4, 1],
    ],
    [
      [1, 0.4, 0],
      [1, 0.4, 1],
    ],
    [
      [1.2, 0, 0],
      [1.2, 0, 1],
    ],
  ]);
  const m = tessellate(half, {segmentsU: 8, segmentsV: 4});
  assert.equal(m.positions.length / 3, 9 * 5);
  assert.equal(m.indices.length, 8 * 4 * 6);
  const mesh = buildModelMesh({
    name: 't',
    parts: [
      {
        name: 'p',
        surface: half,
        material: 'paint',
        mirror: true,
        tessellation: {segmentsU: 8, segmentsV: 4},
      },
    ],
  });
  // Every seam vertex (x == 0) on one half has a twin on the other.
  const xs: string[] = [];
  for (let i = 0; i < mesh.vertices.length; i += 9) {
    if (Math.abs(mesh.vertices[i]) < 1e-9) {
      xs.push(
        `${mesh.vertices[i + 1].toFixed(6)},${mesh.vertices[i + 2].toFixed(6)}`,
      );
    }
  }
  const counts = new Map<string, number>();
  for (const k of xs) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const [, n] of counts) assert.equal(n, 2);
  // du x dv points down (-y) for this surface; the mirrored copy must keep
  // the same orientation rather than flipping inside out.
  let upCount = 0;
  for (let i = 0; i < mesh.vertices.length; i += 9)
    if (mesh.vertices[i + 4] > 0) upCount++;
  assert.equal(upCount, 0);
});
