// Modeling helpers for vehicles, built on top of the NURBS API.
//
// - keyed(): smooth monotone 1D profiles (z -> width/height) for lofted bodies.
// - net()/grid(): B-spline surfaces straight from a control net or a sampled
//   parametric function.
// - superBox(): superquadric "rounded boxes" for bulky industrial parts.
// - pipe(): circular tubes swept along a polyline.
// - conform(): a patch that hugs another surface at an offset (lights, vents,
//   panels and decals that sit exactly on a body).
// - orient()/outward(): flip a surface so its front face points a given way.
// - disc(), ruled(), pointCurve(): small building blocks for caps and fans.
import {NurbsCurve, NurbsSurface, clampedKnots, sweep} from '../nurbs/nurbs';
import {add, cross, dot, normalize, scale, sub, type Vec3} from '../math/vec';

/**
 * Monotone cubic (Fritsch-Carlson) interpolation through [x, y] keys, so
 * profiles never overshoot between keys. Clamped outside the key range.
 */
export function keyed(keys: [number, number][]): (x: number) => number {
  const n = keys.length;
  const xs = keys.map(k => k[0]);
  const ys = keys.map(k => k[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++)
    d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = [d[0]];
  for (let i = 1; i < n - 1; i++) {
    m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  }
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * m[i + 1]
    );
  };
}

/** Evenly spaced values from a to b inclusive (n intervals). */
export function steps(a: number, b: number, n: number): number[] {
  return Array.from({length: n + 1}, (_, i) => a + ((b - a) * i) / n);
}

/** B-spline surface whose control net is points[u][v] (clamped uniform). */
export function net(points: Vec3[][], degU = 3, degV = 3): NurbsSurface {
  const pu = Math.min(degU, points.length - 1);
  const pv = Math.min(degV, points[0].length - 1);
  return new NurbsSurface(
    pu,
    pv,
    points,
    undefined,
    clampedKnots(points.length, pu),
    clampedKnots(points[0].length, pv),
  );
}

/** Control net sampled from f(u, v) on an nu x nv grid. */
export function grid(
  nu: number,
  nv: number,
  f: (u: number, v: number) => Vec3,
  degU = 3,
  degV = 3,
): NurbsSurface {
  const pts: Vec3[][] = [];
  for (let i = 0; i < nu; i++) {
    const row: Vec3[] = [];
    for (let j = 0; j < nv; j++) row.push(f(i / (nu - 1), j / (nv - 1)));
    pts.push(row);
  }
  return net(pts, degU, degV);
}

/**
 * Returns s or s.flipped() so that the normal at (u, v) points along `dir`.
 */
export function orient(
  s: NurbsSurface,
  dir: Vec3,
  u = 0.5,
  v = 0.5,
): NurbsSurface {
  return dot(s.normal(u, v), dir) < 0 ? s.flipped() : s;
}

/** Orients a closed surface so its normals point away from `center`. */
export function outward(
  s: NurbsSurface,
  center: Vec3,
  u = 0.5,
  v = 0.37,
): NurbsSurface {
  return orient(s, sub(s.evaluate(u, v), center), u, v);
}

const spow = (x: number, e: number) => Math.sign(x) * Math.pow(Math.abs(x), e);

export interface Frame {
  /** Local axes (unit, orthogonal). Defaults to world axes. */
  x?: Vec3;
  y?: Vec3;
  z?: Vec3;
}

/**
 * Superquadric rounded box centered at c with half extents h (in the local
 * frame). `e` is the squareness (1 = ellipsoid, 0.1 = nearly a box). The
 * poles sit on the local +-X faces. `taper` scales y/z linearly along x
 * (from 1 at -X to `taper` at +X).
 */
export function superBox(
  c: Vec3,
  h: Vec3,
  e = 0.25,
  opts: Frame & {
    nu?: number;
    nv?: number;
    taperY?: number;
    taperZ?: number;
    e2?: number;
    /** B-spline degree (2 is cheaper to evaluate and plenty for small parts). */
    degree?: number;
  } = {},
): NurbsSurface {
  const X = opts.x ?? [1, 0, 0];
  const Y = opts.y ?? [0, 1, 0];
  const Z = opts.z ?? [0, 0, 1];
  const e2 = opts.e2 ?? e;
  const nu = opts.nu ?? 13;
  const nv = opts.nv ?? 21;
  const s = grid(
    nu,
    nv,
    (u, v) => {
      const phi = -Math.PI / 2 + Math.PI * u;
      const th = -Math.PI + 2 * Math.PI * v;
      const lx = spow(Math.sin(phi), e);
      const r = spow(Math.cos(phi), e);
      const t = (lx + 1) / 2;
      const ty = 1 + ((opts.taperY ?? 1) - 1) * t;
      const tz = 1 + ((opts.taperZ ?? 1) - 1) * t;
      const ly = r * spow(Math.cos(th), e2) * ty;
      const lz = r * spow(Math.sin(th), e2) * tz;
      return add(
        c,
        add(scale(X, lx * h[0]), add(scale(Y, ly * h[1]), scale(Z, lz * h[2]))),
      );
    },
    opts.degree ?? 2,
    opts.degree ?? 2,
  );
  return outward(s, c, 0.5, 0.37);
}

/**
 * Circular tube of radius r along a smooth curve through `rail` points.
 */
export function pipe(
  rail: Vec3[],
  r: number,
  opts: {sections?: number; up?: Vec3} = {},
): NurbsSurface {
  const railC = NurbsCurve.interpolate(rail, Math.min(3, rail.length - 1));
  const prof = NurbsCurve.circle([0, 0, 0], [1, 0, 0], [0, 1, 0], r);
  const s = sweep(prof, railC, {
    sections: opts.sections ?? Math.min(20, Math.max(4, rail.length * 2)),
    up: opts.up ?? [0, 1, 0],
  });
  // Normal should point away from the rail.
  const p = s.evaluate(0.3, 0.5);
  const q = railC.evaluate(0.5);
  return orient(s, sub(p, q), 0.3, 0.5);
}

/**
 * A patch that hugs surface `s` over [u0,u1] x [v0,v1], offset along the
 * surface normal by `off` (meters). `inset(u, v)` (0..1 in the patch) can
 * add extra offset to shape it (e.g. a raised lens). The patch's normal
 * follows s.
 */
export function conform(
  s: NurbsSurface,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  off: number,
  opts: {
    nu?: number;
    nv?: number;
    bump?: (u: number, v: number) => number;
  } = {},
): NurbsSurface {
  const nu = opts.nu ?? 8;
  const nv = opts.nv ?? 8;
  return grid(nu, nv, (a, b) => {
    const u = u0 + (u1 - u0) * a;
    const v = v0 + (v1 - v0) * b;
    const d = off + (opts.bump ? opts.bump(a, b) : 0);
    return add(s.evaluate(u, v), scale(s.normal(u, v), d));
  });
}

/** Revolve-free disc: a flat circle (pole at center) facing `n`. */
export function disc(c: Vec3, n: Vec3, r: number, r0 = 0): NurbsSurface {
  const N = normalize(n);
  const a: Vec3 = Math.abs(N[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const X = normalize(cross(a, N));
  const Y = cross(N, X);
  const outer = NurbsCurve.circle(c, X, Y, r);
  const inner = outer.transform(p => add(c, scale(sub(p, c), r0 / r)));
  const s = new NurbsSurface(
    2,
    1,
    outer.points.map((p, i) => [inner.points[i], p]),
    outer.weights.map(w => [w, w]),
    outer.knots,
    [0, 0, 1, 1],
  );
  return orient(s, N, 0.3, 0.5);
}

/** Ruled surface between two compatible curves (same degree/knots/count). */
export function ruled(a: NurbsCurve, b: NurbsCurve): NurbsSurface {
  return new NurbsSurface(
    a.degree,
    1,
    a.points.map((p, i) => [p, b.points[i]]),
    a.weights.map((w, i) => [w, b.weights[i]]),
    a.knots,
    [0, 0, 1, 1],
  );
}

/** Same structure as c but every point collapsed to p (for fans/caps). */
export function pointCurve(c: NurbsCurve, p: Vec3): NurbsCurve {
  return new NurbsCurve(
    c.degree,
    c.points.map(() => p),
    c.weights,
    c.knots,
  );
}

/**
 * Like conform(), but the patch is mapped through f(a, b) -> [u, v] so it
 * can be any shape in the surface's parameter space (wedges, tapers).
 */
export function conformMap(
  s: NurbsSurface,
  f: (a: number, b: number) => [number, number],
  off: number,
  nu = 6,
  nv = 6,
  bump?: (a: number, b: number) => number,
): NurbsSurface {
  return grid(nu, nv, (a, b) => {
    const [u, v] = f(a, b);
    const d = off + (bump ? bump(a, b) : 0);
    return add(s.evaluate(u, v), scale(s.normal(u, v), d));
  });
}

/**
 * A thin tube lying in a surface (half sunk), following a polyline in the
 * surface's (u, v) space: reads as a panel-line groove or a seam.
 */
export function surfaceLine(
  s: NurbsSurface,
  uv: [number, number][],
  r = 0.0035,
  sink = 0.0015,
): NurbsSurface {
  const pts = uv.map(([u, v]) =>
    add(s.evaluate(u, v), scale(s.normal(u, v), -sink)),
  );
  return pipe(pts, r);
}

/** Parameter t in [0, 1] where f(c(t)) first crosses zero (by bisection). */
export function paramWhere(c: NurbsCurve, f: (p: Vec3) => number): number {
  const n = 48;
  let prev = f(c.evaluate(0));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const cur = f(c.evaluate(t));
    if (Math.sign(cur) !== Math.sign(prev)) {
      let lo = (i - 1) / n;
      let hi = t;
      for (let k = 0; k < 30; k++) {
        const m = (lo + hi) / 2;
        if (Math.sign(f(c.evaluate(m))) === Math.sign(prev)) lo = m;
        else hi = m;
      }
      return (lo + hi) / 2;
    }
    prev = cur;
  }
  return 1;
}

/**
 * Closed rounded-rectangle curve (quadratic B-spline) centered at c in the
 * plane spanned by unit vectors X and Y, half sizes hx, hy. Starts and ends
 * at the middle of the +Y side.
 */
export function roundRect(
  c: Vec3,
  X: Vec3,
  Y: Vec3,
  hx: number,
  hy: number,
): NurbsCurve {
  const p = (a: number, b: number) =>
    add(c, add(scale(X, a * hx), scale(Y, b * hy)));
  return NurbsCurve.fromPoints(
    [
      p(0, 1),
      p(1, 1),
      p(1, 0),
      p(1, -1),
      p(0, -1),
      p(-1, -1),
      p(-1, 0),
      p(-1, 1),
      p(0, 1),
    ],
    2,
  );
}
