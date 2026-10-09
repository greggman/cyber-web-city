// Base meshes for building segments. Every mesh is unit sized: x and z in
// [-0.5, 0.5], y in [0, 1]. The vertex shader scales by the segment size and
// applies taper and twist.
//
// Vertex layout (8 floats): position.xyz, normal.xyz, facade.xy where the
// facade coordinate in meters along the wall is facade.x*size.x + facade.y*size.z.

export const VERTEX_FLOATS = 8;
export const VERTEX_STRIDE = VERTEX_FLOATS * 4;

export const enum Shape {
  Box = 0,
  BoxTwist = 1,
  Cylinder = 2,
  Hex = 3,
  Oct = 4,
  Sphere = 5,
  Wedge = 6,
}
export const SHAPE_COUNT = 7;

export interface MeshData {
  name: string;
  vertices: number[];
  indices: number[];
}

class Builder {
  vertices: number[] = [];
  indices: number[] = [];
  vertex(p: number[], n: number[], f: number[]) {
    this.vertices.push(p[0], p[1], p[2], n[0], n[1], n[2], f[0], f[1]);
    return this.vertices.length / VERTEX_FLOATS - 1;
  }
  quad(a: number, b: number, c: number, d: number) {
    // a b c d counter-clockwise when viewed from the front.
    this.indices.push(a, b, c, a, c, d);
  }
  mesh(name: string): MeshData {
    return {name, vertices: this.vertices, indices: this.indices};
  }
}

/**
 * Prism with `sides` faces (flat shaded when `smooth` is false) and `slices`
 * vertical subdivisions (for twisting). Includes top and bottom caps.
 */
function prism(
  name: string,
  sides: number,
  slices: number,
  smooth: boolean,
  angleOffset: number,
): MeshData {
  const b = new Builder();
  const pt = (i: number): [number, number] => {
    const a = angleOffset + (i / sides) * Math.PI * 2;
    // Scale so a 4-sided prism exactly fills the unit square.
    const r = sides === 4 ? Math.SQRT1_2 : 0.5;
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  // Approximate perimeter param for facade coordinates on round shapes:
  // circumference = pi * (sx + sz) / 2 for an ellipse-ish shape.
  for (let i = 0; i < sides; i++) {
    const [x0, z0] = pt(i);
    const [x1, z1] = pt(i + 1);
    let fn = [z1 - z0, 0, -(x1 - x0)];
    const l = Math.hypot(fn[0], fn[2]);
    fn = [fn[0] / l, 0, fn[2] / l];
    const rows: number[][] = [];
    for (let s = 0; s <= slices; s++) {
      const y = s / slices;
      const row: number[] = [];
      for (const [k, [x, z]] of [
        [0, [x0, z0]],
        [1, [x1, z1]],
      ] as [number, [number, number]][]) {
        const n = smooth ? [x * 2, 0, z * 2] : fn;
        let f: number[];
        if (sides === 4) {
          // Facade u in meters along this face: use x for z-facing faces, z otherwise.
          f =
            Math.abs(fn[2]) > 0.5
              ? [x * Math.sign(fn[2]), 0]
              : [0, -z * Math.sign(fn[0])];
        } else {
          const a = ((i + k) / sides) * Math.PI * 2;
          const circ = (Math.PI * 0.5) / (Math.PI * 2);
          f = [-a * circ, -a * circ];
        }
        row.push(b.vertex([x, y, z], n, f));
      }
      rows.push(row);
    }
    for (let s = 0; s < slices; s++) {
      b.quad(rows[s][1], rows[s][0], rows[s + 1][0], rows[s + 1][1]);
    }
  }
  // Caps (facade coords unused on caps; store planar xz for roof patterns).
  for (const [y, ny] of [
    [1, 1],
    [0, -1],
  ]) {
    const c = b.vertex([0, y, 0], [0, ny, 0], [0, 0]);
    const ring: number[] = [];
    for (let i = 0; i <= sides; i++) {
      const [x, z] = pt(i);
      ring.push(b.vertex([x, y, z], [0, ny, 0], [x, z]));
    }
    for (let i = 0; i < sides; i++) {
      if (ny > 0) {
        b.indices.push(c, ring[i + 1], ring[i]);
      } else {
        b.indices.push(c, ring[i], ring[i + 1]);
      }
    }
  }
  return b.mesh(name);
}

function sphere(name: string, seg: number, rings: number): MeshData {
  const b = new Builder();
  const grid: number[][] = [];
  for (let r = 0; r <= rings; r++) {
    const v = r / rings;
    const phi = v * Math.PI;
    const row: number[] = [];
    for (let s = 0; s <= seg; s++) {
      const u = s / seg;
      const th = u * Math.PI * 2;
      const n = [
        Math.sin(phi) * Math.cos(th),
        -Math.cos(phi),
        Math.sin(phi) * Math.sin(th),
      ];
      const a = th * 0.25;
      row.push(
        b.vertex([n[0] * 0.5, 0.5 + n[1] * 0.5, n[2] * 0.5], n, [-a, -a]),
      );
    }
    grid.push(row);
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      b.quad(grid[r][s], grid[r + 1][s], grid[r + 1][s + 1], grid[r][s + 1]);
    }
  }
  return b.mesh(name);
}

function wedge(name: string): MeshData {
  // Triangular prism: a building with a sloped face (z from -0.5 at full
  // height to +0.5 at zero height).
  const b = new Builder();
  const P = (x: number, y: number, z: number) => [x, y, z];
  const quadFace = (ps: number[][], n: number[], fs: number[][]) => {
    const ids = ps.map((p, i) => b.vertex(p, n, fs[i]));
    b.quad(ids[0], ids[1], ids[2], ids[3]);
  };
  const s = Math.SQRT1_2;
  // back (-z), full height
  quadFace(
    [P(0.5, 0, -0.5), P(-0.5, 0, -0.5), P(-0.5, 1, -0.5), P(0.5, 1, -0.5)],
    [0, 0, -1],
    [
      [-0.5, 0],
      [0.5, 0],
      [0.5, 0],
      [-0.5, 0],
    ],
  );
  // slope
  quadFace(
    [P(-0.5, 0, 0.5), P(0.5, 0, 0.5), P(0.5, 1, -0.5), P(-0.5, 1, -0.5)],
    [0, s, s],
    [
      [-0.5, 0],
      [0.5, 0],
      [0.5, 0],
      [-0.5, 0],
    ],
  );
  // bottom
  quadFace(
    [P(-0.5, 0, -0.5), P(0.5, 0, -0.5), P(0.5, 0, 0.5), P(-0.5, 0, 0.5)],
    [0, -1, 0],
    [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ],
  );
  // sides (triangles)
  for (const x of [-0.5, 0.5]) {
    const n = [Math.sign(x), 0, 0];
    const f = (z: number) => [0, z * -Math.sign(x)];
    const a = b.vertex(P(x, 0, -0.5), n, f(-0.5));
    const c = b.vertex(P(x, 0, 0.5), n, f(0.5));
    const d = b.vertex(P(x, 1, -0.5), n, f(-0.5));
    if (x > 0) b.indices.push(a, d, c);
    else b.indices.push(a, c, d);
  }
  return b.mesh(name);
}

export interface ShapeLods {
  shape: Shape;
  /** LOD meshes, highest detail first. */
  meshes: MeshData[];
  /** Max projected-size ratio (radius / distance) at which each LOD is used. */
  lodRatios: number[];
}

export function buildShapeLibrary(): ShapeLods[] {
  const q = Math.PI / 4;
  return [
    {shape: Shape.Box, meshes: [prism('box', 4, 1, false, q)], lodRatios: [0]},
    {
      shape: Shape.BoxTwist,
      meshes: [
        prism('box-twist-24', 4, 24, false, q),
        prism('box-twist-8', 4, 8, false, q),
      ],
      lodRatios: [0.05, 0],
    },
    {
      shape: Shape.Cylinder,
      meshes: [
        prism('cyl-48', 48, 1, true, 0),
        prism('cyl-24', 24, 1, true, 0),
        prism('cyl-10', 10, 1, true, 0),
      ],
      lodRatios: [0.08, 0.02, 0],
    },
    {shape: Shape.Hex, meshes: [prism('hex', 6, 1, false, 0)], lodRatios: [0]},
    {
      shape: Shape.Oct,
      meshes: [prism('oct', 8, 1, false, Math.PI / 8)],
      lodRatios: [0],
    },
    {
      shape: Shape.Sphere,
      meshes: [
        sphere('sphere-48', 48, 24),
        sphere('sphere-24', 24, 12),
        sphere('sphere-10', 10, 6),
      ],
      lodRatios: [0.08, 0.02, 0],
    },
    {shape: Shape.Wedge, meshes: [wedge('wedge')], lodRatios: [0]},
  ];
}
