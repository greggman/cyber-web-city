// Adaptive tessellation of NURBS surfaces into indexed triangle meshes.
import {cross, dot, length, normalize, sub, type Vec3} from '../math/vec';
import type {NurbsSurface} from './nurbs';

export interface TessOptions {
  /** Fixed segment counts (override adaptive estimation). */
  segmentsU?: number;
  segmentsV?: number;
  /** Max angle (radians) between adjacent facet normals. Default ~7 degrees. */
  maxAngle?: number;
  /** Max edge length in meters. Default 0.25. */
  maxEdge?: number;
  /** Clamp for adaptive counts. */
  minSegments?: number;
  maxSegments?: number;
  /**
   * Trim: return false for parameter positions to cut away. Triangles whose
   * centroid is trimmed are dropped (use enough segments for clean edges).
   */
  keep?: (u: number, v: number) => boolean;
}

export interface TriMesh {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

function estimateSegments(
  s: NurbsSurface,
  alongU: boolean,
  maxAngle: number,
  maxEdge: number,
): number {
  const probes = 7;
  const samples = 32;
  let best = 1;
  for (let k = 0; k < probes; k++) {
    const w = k / (probes - 1);
    let len = 0;
    let turn = 0;
    let prevP: Vec3 | null = null;
    let prevT: Vec3 | null = null;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const d = alongU ? s.derivatives(t, w) : s.derivatives(w, t);
      const tan = normalize(alongU ? d.du : d.dv);
      if (prevP) len += length(sub(d.point, prevP));
      if (prevT && length(tan) > 0.5) {
        turn += Math.acos(Math.min(1, Math.max(-1, dot(prevT, tan))));
      }
      prevP = d.point;
      if (length(tan) > 0.5) prevT = tan;
    }
    best = Math.max(best, Math.ceil(turn / maxAngle), Math.ceil(len / maxEdge));
  }
  return best;
}

export function tessellate(s: NurbsSurface, opts: TessOptions = {}): TriMesh {
  const maxAngle = opts.maxAngle ?? (7 * Math.PI) / 180;
  const maxEdge = opts.maxEdge ?? 0.25;
  const lo = opts.minSegments ?? 2;
  const hi = opts.maxSegments ?? 96;
  const clampN = (n: number) => Math.max(lo, Math.min(hi, n));
  const nu =
    opts.segmentsU ?? clampN(estimateSegments(s, true, maxAngle, maxEdge));
  const nv =
    opts.segmentsV ?? clampN(estimateSegments(s, false, maxAngle, maxEdge));
  const mesh: TriMesh = {positions: [], normals: [], uvs: [], indices: []};
  for (let i = 0; i <= nu; i++) {
    for (let j = 0; j <= nv; j++) {
      const u = i / nu;
      const v = j / nv;
      const p = s.evaluate(u, v);
      const n = s.normal(u, v);
      mesh.positions.push(...p);
      mesh.normals.push(...n);
      mesh.uvs.push(u, v);
    }
  }
  const idx = (i: number, j: number) => i * (nv + 1) + j;
  const keep = opts.keep;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = idx(i, j);
      const b = idx(i + 1, j);
      const c = idx(i + 1, j + 1);
      const d = idx(i, j + 1);
      const tris = [
        [a, b, c, (i + 2 / 3) / nu, (j + 1 / 3) / nv],
        [a, c, d, (i + 1 / 3) / nu, (j + 2 / 3) / nv],
      ];
      for (const [x, y, z, cu, cv] of tris) {
        if (keep && !keep(cu, cv)) continue;
        // Skip degenerate triangles (e.g. at poles).
        const P = (k: number): Vec3 => [
          mesh.positions[k * 3],
          mesh.positions[k * 3 + 1],
          mesh.positions[k * 3 + 2],
        ];
        const area = length(cross(sub(P(y), P(x)), sub(P(z), P(x))));
        if (area < 1e-12) continue;
        mesh.indices.push(x, y, z);
      }
    }
  }
  return mesh;
}
