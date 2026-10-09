// NURBS curves and surfaces (no libraries). Algorithms follow Piegl & Tiller,
// "The NURBS Book": basis functions with derivatives (A2.2/A2.3), rational
// curve/surface evaluation via homogeneous coordinates.
//
// Parameters are exposed in a normalized [0, 1] domain for convenience; the
// knot vectors can be anything.

import {
  add,
  cross,
  dot,
  length,
  normalize,
  scale,
  sub,
  type Vec3,
} from '../math/vec';

export type {Vec3};

/** Index of the knot span containing u (A2.1). */
export function findSpan(n: number, p: number, u: number, U: number[]): number {
  if (u >= U[n + 1]) return n;
  if (u <= U[p]) return p;
  let lo = p;
  let hi = n + 1;
  let mid = (lo + hi) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

/** Nonzero basis functions and their derivatives up to order nd (A2.3). */
export function basisDerivs(
  span: number,
  u: number,
  p: number,
  nd: number,
  U: number[],
): number[][] {
  const ndu: number[][] = Array.from({length: p + 1}, () =>
    new Array(p + 1).fill(0),
  );
  const left = new Array(p + 1).fill(0);
  const right = new Array(p + 1).fill(0);
  ndu[0][0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const temp = ndu[r][j - 1] / ndu[j][r];
      ndu[r][j] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j][j] = saved;
  }
  const ders: number[][] = Array.from({length: nd + 1}, () =>
    new Array(p + 1).fill(0),
  );
  for (let j = 0; j <= p; j++) ders[0][j] = ndu[j][p];
  const a: number[][] = [new Array(p + 1).fill(0), new Array(p + 1).fill(0)];
  for (let r = 0; r <= p; r++) {
    let s1 = 0;
    let s2 = 1;
    a[0][0] = 1;
    for (let k = 1; k <= nd; k++) {
      let d = 0;
      const rk = r - k;
      const pk = p - k;
      if (r >= k) {
        a[s2][0] = a[s1][0] / ndu[pk + 1][rk];
        d = a[s2][0] * ndu[rk][pk];
      }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? k - 1 : p - r;
      for (let j = j1; j <= j2; j++) {
        a[s2][j] = (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][rk + j];
        d += a[s2][j] * ndu[rk + j][pk];
      }
      if (r <= pk) {
        a[s2][k] = -a[s1][k - 1] / ndu[pk + 1][r];
        d += a[s2][k] * ndu[r][pk];
      }
      ders[k][r] = d;
      [s1, s2] = [s2, s1];
    }
  }
  let r = p;
  for (let k = 1; k <= nd; k++) {
    for (let j = 0; j <= p; j++) ders[k][j] *= r;
    r *= p - k;
  }
  return ders;
}

/** Clamped uniform knot vector for n control points of degree p. */
export function clampedKnots(n: number, p: number): number[] {
  const m = n + p + 1;
  const U: number[] = [];
  const inner = n - p;
  for (let i = 0; i < m; i++) {
    if (i <= p) U.push(0);
    else if (i >= n) U.push(1);
    else U.push((i - p) / inner);
  }
  return U;
}

/** Clamped knot vector following parameter values by averaging (eq. 9.8). */
function averagedKnots(params: number[], p: number): number[] {
  const n = params.length;
  const U: number[] = new Array(p + 1).fill(0);
  for (let j = 1; j < n - p; j++) {
    let s = 0;
    for (let i = j; i < j + p; i++) s += params[i];
    U.push(s / p);
  }
  for (let i = 0; i <= p; i++) U.push(1);
  return U;
}

/** Solves a dense linear system A x = b (Gaussian elimination, partial pivot). */
function solve(A: number[][], b: number[][]): number[][] {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...b[i]]);
  const w = b[0].length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    }
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-14) throw new Error('singular interpolation matrix');
    for (let k = c; k < n + w; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let k = c; k < n + w; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map(row => row.slice(n));
}

export class NurbsCurve {
  constructor(
    readonly degree: number,
    readonly points: Vec3[],
    readonly weights: number[] = points.map(() => 1),
    readonly knots: number[] = clampedKnots(points.length, degree),
  ) {
    if (knots.length !== points.length + degree + 1) {
      throw new Error(
        `bad knot vector: ${knots.length} knots for ${points.length} points of degree ${degree}`,
      );
    }
    if (weights.length !== points.length) {
      throw new Error('weights and points must have the same length');
    }
  }

  get domain(): [number, number] {
    return [this.knots[this.degree], this.knots[this.points.length]];
  }

  private param(t: number): number {
    const [a, b] = this.domain;
    return a + (b - a) * Math.min(1, Math.max(0, t));
  }

  /** Point and derivatives up to order nd at normalized t in [0, 1]. */
  derivatives(t: number, nd = 1): Vec3[] {
    const u = this.param(t);
    const p = this.degree;
    const n = this.points.length - 1;
    const span = findSpan(n, p, u, this.knots);
    const N = basisDerivs(span, u, p, nd, this.knots);
    const [a, b] = this.domain;
    // Homogeneous derivatives.
    const Aw: Vec3[] = [];
    const w: number[] = [];
    for (let k = 0; k <= nd; k++) {
      let x = 0;
      let y = 0;
      let z = 0;
      let ww = 0;
      for (let j = 0; j <= p; j++) {
        const i = span - p + j;
        const wi = this.weights[i];
        const c = N[k][j] * wi;
        x += c * this.points[i][0];
        y += c * this.points[i][1];
        z += c * this.points[i][2];
        ww += c;
      }
      Aw.push([x, y, z]);
      w.push(ww);
    }
    // Rational derivatives (A4.2).
    const CK: Vec3[] = [];
    for (let k = 0; k <= nd; k++) {
      let v = Aw[k];
      for (let i = 1; i <= k; i++) {
        v = sub(v, scale(CK[k - i], binom(k, i) * w[i]));
      }
      CK.push(scale(v, 1 / w[0]));
    }
    // Chain rule for the normalized parameter.
    const s = b - a;
    return CK.map((v, k) => scale(v, Math.pow(s, k)));
  }

  evaluate(t: number): Vec3 {
    return this.derivatives(t, 0)[0];
  }

  tangent(t: number): Vec3 {
    return normalize(this.derivatives(t, 1)[1]);
  }

  /** Approximate arc length by sampling. */
  length(samples = 64): number {
    let L = 0;
    let prev = this.evaluate(0);
    for (let i = 1; i <= samples; i++) {
      const p = this.evaluate(i / samples);
      L += length(sub(p, prev));
      prev = p;
    }
    return L;
  }

  /** Samples n+1 points uniformly in parameter. */
  sample(n: number): Vec3[] {
    return Array.from({length: n + 1}, (_, i) => this.evaluate(i / n));
  }

  transform(fn: (p: Vec3) => Vec3): NurbsCurve {
    return new NurbsCurve(
      this.degree,
      this.points.map(fn),
      this.weights,
      this.knots,
    );
  }

  reversed(): NurbsCurve {
    const k = this.knots;
    const a = k[0];
    const b = k[k.length - 1];
    return new NurbsCurve(
      this.degree,
      [...this.points].reverse(),
      [...this.weights].reverse(),
      k.map(x => a + b - x).reverse(),
    );
  }

  /** B-spline through the control polygon (clamped uniform knots). */
  static fromPoints(points: Vec3[], degree = 3): NurbsCurve {
    const p = Math.min(degree, points.length - 1);
    return new NurbsCurve(p, points);
  }

  /** Global interpolation through points (centripetal parameterization). */
  static interpolate(points: Vec3[], degree = 3): NurbsCurve {
    const p = Math.min(degree, points.length - 1);
    const n = points.length;
    const d: number[] = [0];
    for (let i = 1; i < n; i++)
      d.push(d[i - 1] + Math.sqrt(length(sub(points[i], points[i - 1]))));
    const total = d[n - 1] || 1;
    const params = d.map(x => x / total);
    const U = averagedKnots(params, p);
    const A: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row = new Array(n).fill(0);
      const span = findSpan(n - 1, p, params[i], U);
      const N = basisDerivs(span, params[i], p, 0, U)[0];
      for (let j = 0; j <= p; j++) row[span - p + j] = N[j];
      A.push(row);
    }
    const P = solve(
      A,
      points.map(q => [...q]),
    ) as Vec3[];
    return new NurbsCurve(
      p,
      P,
      P.map(() => 1),
      U,
    );
  }

  /** Straight line segment. */
  static line(a: Vec3, b: Vec3): NurbsCurve {
    return new NurbsCurve(1, [a, b]);
  }

  /**
   * Exact circular arc (rational quadratic) centered at `center` in the plane
   * spanned by unit vectors xAxis and yAxis, from angle a0 to a1 (radians).
   */
  static arc(
    center: Vec3,
    xAxis: Vec3,
    yAxis: Vec3,
    radius: number,
    a0: number,
    a1: number,
  ): NurbsCurve {
    const theta = a1 - a0;
    const narcs = Math.max(
      1,
      Math.ceil(Math.abs(theta) / (Math.PI / 2) - 1e-9),
    );
    const dtheta = theta / narcs;
    const w1 = Math.cos(dtheta / 2);
    const pt = (a: number): Vec3 =>
      add(
        center,
        add(
          scale(xAxis, radius * Math.cos(a)),
          scale(yAxis, radius * Math.sin(a)),
        ),
      );
    const tan = (a: number): Vec3 =>
      add(scale(xAxis, -Math.sin(a)), scale(yAxis, Math.cos(a)));
    const pts: Vec3[] = [pt(a0)];
    const wts = [1];
    let angle = a0;
    for (let i = 1; i <= narcs; i++) {
      const a2 = angle + dtheta;
      const P0 = pt(angle);
      const T0 = tan(angle);
      const P2 = pt(a2);
      // Intersection of tangents: P0 + T0 * (r * tan(dθ/2)).
      const P1 = add(P0, scale(T0, radius * Math.tan(dtheta / 2)));
      pts.push(P1, P2);
      wts.push(w1, 1);
      angle = a2;
    }
    const U: number[] = [0, 0, 0];
    for (let i = 1; i < narcs; i++) U.push(i / narcs, i / narcs);
    U.push(1, 1, 1);
    return new NurbsCurve(2, pts, wts, U);
  }

  static circle(
    center: Vec3,
    xAxis: Vec3,
    yAxis: Vec3,
    radius: number,
  ): NurbsCurve {
    return NurbsCurve.arc(center, xAxis, yAxis, radius, 0, Math.PI * 2);
  }
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

export interface SurfaceDerivs {
  point: Vec3;
  du: Vec3;
  dv: Vec3;
}

export class NurbsSurface {
  /**
   * points[i][j]: i indexes the u direction, j the v direction.
   */
  constructor(
    readonly degreeU: number,
    readonly degreeV: number,
    readonly points: Vec3[][],
    readonly weights: number[][] = points.map(r => r.map(() => 1)),
    readonly knotsU: number[] = clampedKnots(points.length, degreeU),
    readonly knotsV: number[] = clampedKnots(points[0].length, degreeV),
  ) {
    const nu = points.length;
    const nv = points[0].length;
    if (points.some(r => r.length !== nv)) {
      throw new Error('surface control net rows must all have the same length');
    }
    if (
      knotsU.length !== nu + degreeU + 1 ||
      knotsV.length !== nv + degreeV + 1
    ) {
      throw new Error('bad surface knot vectors');
    }
  }

  get countU() {
    return this.points.length;
  }
  get countV() {
    return this.points[0].length;
  }

  /** Point and first partial derivatives at normalized (u, v) in [0,1]^2. */
  derivatives(uN: number, vN: number): SurfaceDerivs {
    const pu = this.degreeU;
    const pv = this.degreeV;
    const U = this.knotsU;
    const V = this.knotsV;
    const nu = this.countU - 1;
    const nv = this.countV - 1;
    const ua = U[pu];
    const ub = U[nu + 1];
    const va = V[pv];
    const vb = V[nv + 1];
    const u = ua + (ub - ua) * Math.min(1, Math.max(0, uN));
    const v = va + (vb - va) * Math.min(1, Math.max(0, vN));
    const su = findSpan(nu, pu, u, U);
    const sv = findSpan(nv, pv, v, V);
    const Nu = basisDerivs(su, u, pu, 1, U);
    const Nv = basisDerivs(sv, v, pv, 1, V);
    // Homogeneous S, Su, Sv.
    const S = [0, 0, 0, 0];
    const Su = [0, 0, 0, 0];
    const Sv = [0, 0, 0, 0];
    for (let k = 0; k <= pu; k++) {
      const i = su - pu + k;
      for (let l = 0; l <= pv; l++) {
        const j = sv - pv + l;
        const w = this.weights[i][j];
        const P = this.points[i][j];
        const b00 = Nu[0][k] * Nv[0][l] * w;
        const b10 = Nu[1][k] * Nv[0][l] * w;
        const b01 = Nu[0][k] * Nv[1][l] * w;
        for (let c = 0; c < 3; c++) {
          S[c] += b00 * P[c];
          Su[c] += b10 * P[c];
          Sv[c] += b01 * P[c];
        }
        S[3] += b00;
        Su[3] += b10;
        Sv[3] += b01;
      }
    }
    const w = S[3];
    const point: Vec3 = [S[0] / w, S[1] / w, S[2] / w];
    const du: Vec3 = [0, 0, 0];
    const dv: Vec3 = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      du[c] = ((Su[c] - Su[3] * point[c]) / w) * (ub - ua);
      dv[c] = ((Sv[c] - Sv[3] * point[c]) / w) * (vb - va);
    }
    return {point, du, dv};
  }

  evaluate(u: number, v: number): Vec3 {
    return this.derivatives(u, v).point;
  }

  /**
   * Unit normal (du x dv). Falls back to nearby samples at degenerate points
   * such as the pole of a revolved surface.
   */
  normal(u: number, v: number): Vec3 {
    const d = this.derivatives(u, v);
    let n = cross(d.du, d.dv);
    if (length(n) < 1e-9) {
      const e = 1e-3;
      const uu = u < 0.5 ? u + e : u - e;
      const vv = v < 0.5 ? v + e : v - e;
      const d2 = this.derivatives(uu, vv);
      n = cross(d2.du, d2.dv);
    }
    return normalize(n);
  }

  transform(fn: (p: Vec3) => Vec3): NurbsSurface {
    return new NurbsSurface(
      this.degreeU,
      this.degreeV,
      this.points.map(r => r.map(fn)),
      this.weights,
      this.knotsU,
      this.knotsV,
    );
  }

  /** Swaps the u and v directions (flips the normal). */
  transposed(): NurbsSurface {
    const nu = this.countU;
    const nv = this.countV;
    const P: Vec3[][] = [];
    const W: number[][] = [];
    for (let j = 0; j < nv; j++) {
      P.push([]);
      W.push([]);
      for (let i = 0; i < nu; i++) {
        P[j].push(this.points[i][j]);
        W[j].push(this.weights[i][j]);
      }
    }
    return new NurbsSurface(
      this.degreeV,
      this.degreeU,
      P,
      W,
      this.knotsV,
      this.knotsU,
    );
  }

  /** Reverses the u direction (flips the normal). */
  flipped(): NurbsSurface {
    const k = this.knotsU;
    const a = k[0];
    const b = k[k.length - 1];
    return new NurbsSurface(
      this.degreeU,
      this.degreeV,
      [...this.points].reverse(),
      [...this.weights].reverse(),
      k.map(x => a + b - x).reverse(),
      this.knotsV,
    );
  }

  /** Mirror across the plane x = 0 (keeps normals facing outward). */
  mirrorX(): NurbsSurface {
    return this.transform(([x, y, z]) => [-x, y, z]).flipped();
  }
}

/** Raises every curve to a common control-point count by resampling. */
function compatible(
  curves: NurbsCurve[],
  count?: number,
  degree = 3,
): NurbsCurve[] {
  const same =
    curves.every(c => c.degree === curves[0].degree) &&
    curves.every(c => c.points.length === curves[0].points.length) &&
    curves.every(c =>
      c.knots.every((k, i) => Math.abs(k - curves[0].knots[i]) < 1e-12),
    );
  if (same && count === undefined) return curves;
  const n = count ?? Math.max(...curves.map(c => c.points.length), 8);
  return curves.map(c => {
    const samples = c.sample(Math.max(n - 1, 2) * 2);
    // Interpolate a subset to keep the count n.
    const pts: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      pts.push(samples[Math.round((i / (n - 1)) * (samples.length - 1))]);
    }
    return NurbsCurve.interpolate(pts, degree);
  });
}

/**
 * Skins a surface through a sequence of section curves (u runs along each
 * curve, v across the sections). Sections are made compatible automatically.
 * `degreeV` is the degree across the sections.
 */
export function loft(
  sections: NurbsCurve[],
  degreeV = 3,
  opts: {resample?: number} = {},
): NurbsSurface {
  if (sections.length < 2) throw new Error('loft needs at least 2 sections');
  const cs = compatible(sections, opts.resample);
  const nu = cs[0].points.length;
  const pv = Math.min(degreeV, cs.length - 1);
  // Interpolate across sections for each u control point (non-rational
  // across v; weights of sections are kept when all equal).
  const P: Vec3[][] = [];
  const W: number[][] = [];
  let knotsV: number[] = [];
  for (let i = 0; i < nu; i++) {
    const column = cs.map(c => c.points[i]);
    const curve = NurbsCurve.interpolate(column, pv);
    P.push(curve.points);
    W.push(cs.map(c => c.weights[i]));
    knotsV = curve.knots;
  }
  // Weights only stay exact if constant across sections.
  const weights = W.map(row =>
    row.every(w => w === row[0]) ? row.map(() => row[0]) : row.map(() => 1),
  );
  return new NurbsSurface(cs[0].degree, pv, P, weights, cs[0].knots, knotsV);
}

/**
 * Surface of revolution: revolves `profile` around the axis through `origin`
 * with unit direction `axis` by `angle` radians (exact rational arcs).
 * u runs along the profile, v around the axis.
 */
export function revolve(
  profile: NurbsCurve,
  origin: Vec3,
  axis: Vec3,
  angle = Math.PI * 2,
): NurbsSurface {
  const ax = normalize(axis);
  const P: Vec3[][] = [];
  const W: number[][] = [];
  let knotsV: number[] = [];
  for (let i = 0; i < profile.points.length; i++) {
    const q = profile.points[i];
    const rel = sub(q, origin);
    const along = dot(rel, ax);
    const center = add(origin, scale(ax, along));
    const radial = sub(q, center);
    const r = length(radial);
    const x = r > 1e-12 ? scale(radial, 1 / r) : perpendicular(ax);
    const y = cross(ax, x);
    const arc = NurbsCurve.arc(center, x, y, r, 0, angle);
    P.push(arc.points);
    W.push(arc.weights.map(w => w * profile.weights[i]));
    knotsV = arc.knots;
  }
  return new NurbsSurface(profile.degree, 2, P, W, profile.knots, knotsV);
}

function perpendicular(v: Vec3): Vec3 {
  const a: Vec3 = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(v, a));
}

/** Extrudes a curve along a vector (u along the curve, v along the vector). */
export function extrude(curve: NurbsCurve, dir: Vec3): NurbsSurface {
  const P = curve.points.map(p => [p, add(p, dir)]);
  const W = curve.weights.map(w => [w, w]);
  return new NurbsSurface(curve.degree, 1, P, W, curve.knots, [0, 0, 1, 1]);
}

/**
 * Sweeps a planar profile (defined in a local XY plane, Z = 0) along a rail.
 * The profile's X axis follows the rail's horizontal side vector computed
 * from `up`, Y follows the frame's up, Z the tangent. `scaleAlong(t)` scales
 * the profile along the rail. u runs along the profile, v along the rail.
 */
export function sweep(
  profile: NurbsCurve,
  rail: NurbsCurve,
  opts: {sections?: number; up?: Vec3; scaleAlong?: (t: number) => number} = {},
): NurbsSurface {
  const n = opts.sections ?? 12;
  const up0 = opts.up ?? [0, 1, 0];
  const sections: NurbsCurve[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const [p, d1] = rail.derivatives(t, 1);
    const T = normalize(d1);
    let X = cross(up0, T);
    if (length(X) < 1e-6) X = perpendicular(T);
    X = normalize(X);
    const Y = cross(T, X);
    const s = opts.scaleAlong ? opts.scaleAlong(t) : 1;
    sections.push(
      profile.transform(([x, y, z]) =>
        add(p, add(add(scale(X, x * s), scale(Y, y * s)), scale(T, z * s))),
      ),
    );
  }
  return loft(sections, 3);
}

/** Bilinear patch through four corners (p00 at u=0,v=0; p10 at u=1,v=0; ...). */
export function bilinear(
  p00: Vec3,
  p10: Vec3,
  p01: Vec3,
  p11: Vec3,
): NurbsSurface {
  return new NurbsSurface(1, 1, [
    [p00, p01],
    [p10, p11],
  ]);
}
