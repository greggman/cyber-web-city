// Kitbash detail meshes for building facades (Megacity-style greebles).
//
// Each mesh is in a wall frame: x along the wall, y up, z out of the wall
// (z = 0 is the wall surface). "Scaled" meshes are unit-sized on the axes
// the instance scales (see DETAIL_TYPES); fixed meshes are in meters.
// Vertex: position(3) normal(3) uv(2) part(1, u32 bits) = 9 floats.
//
// Parts select the material in details.wgsl:
//   0 body (instance color)   1 dark metal   2 emissive (accent)
//   3 glass                   4 fabric (accent, striped)
//   5 parapet (glass or body, per instance)

export const DETAIL_VERTEX_FLOATS = 9;

export const enum Part {
  Body = 0,
  Dark = 1,
  Emissive = 2,
  Glass = 3,
  Fabric = 4,
  Parapet = 5,
  Module = 6,
}

/** Detail types; order must match the constants in details.wgsl. */
export const DETAIL_TYPES = [
  {name: 'ledge', cap: 160000},
  {name: 'fin', cap: 90000},
  {name: 'pipe', cap: 40000},
  {name: 'ac', cap: 160000},
  {name: 'balcony', cap: 160000},
  {name: 'awning', cap: 50000},
  {name: 'cage', cap: 80000},
  {name: 'vent', cap: 50000},
  {name: 'canopy', cap: 20000},
  {name: 'module', cap: 30000},
] as const;

export interface DetailMesh {
  vertices: number[];
  indices: number[];
}

class B {
  v: number[] = [];
  i: number[] = [];
  private u32 = new Uint32Array(1);
  private f32 = new Float32Array(this.u32.buffer);

  vert(p: number[], n: number[], uv: number[], part: Part) {
    this.u32[0] = part;
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1], this.f32[0]);
    return this.v.length / DETAIL_VERTEX_FLOATS - 1;
  }

  /** Quad a,b,c,d counter-clockwise seen from the normal side. */
  quad(
    a: number[],
    b: number[],
    c: number[],
    d: number[],
    n: number[],
    part: Part,
  ) {
    const uv = (p: number[]) => [p[0] + p[2], p[1]];
    const ia = this.vert(a, n, uv(a), part);
    const ib = this.vert(b, n, uv(b), part);
    const ic = this.vert(c, n, uv(c), part);
    const id = this.vert(d, n, uv(d), part);
    this.i.push(ia, ib, ic, ia, ic, id);
  }

  /** Axis-aligned box; the back face (z = z0) is skipped when it touches the wall. */
  box(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    part: Part,
  ) {
    // +z front
    this.quad(
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
      [0, 0, 1],
      part,
    );
    // +x
    this.quad(
      [x1, y0, z1],
      [x1, y0, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [1, 0, 0],
      part,
    );
    // -x
    this.quad(
      [x0, y0, z0],
      [x0, y0, z1],
      [x0, y1, z1],
      [x0, y1, z0],
      [-1, 0, 0],
      part,
    );
    // +y
    this.quad(
      [x0, y1, z1],
      [x1, y1, z1],
      [x1, y1, z0],
      [x0, y1, z0],
      [0, 1, 0],
      part,
    );
    // -y
    this.quad(
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y0, z1],
      [x0, y0, z1],
      [0, -1, 0],
      part,
    );
    if (z0 > 1e-4) {
      this.quad(
        [x1, y0, z0],
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
        [0, 0, -1],
        part,
      );
    }
  }

  /** Cylinder along y. */
  cylY(
    cx: number,
    cz: number,
    r: number,
    y0: number,
    y1: number,
    sides: number,
    part: Part,
  ) {
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * Math.PI * 2;
      const a1 = ((k + 1) / sides) * Math.PI * 2;
      const p = (a: number, y: number) => [
        cx + Math.cos(a) * r,
        y,
        cz + Math.sin(a) * r,
      ];
      const n0 = [Math.cos(a0), 0, Math.sin(a0)];
      const n1 = [Math.cos(a1), 0, Math.sin(a1)];
      const i0 = this.vert(p(a0, y0), n0, [k / sides, y0], part);
      const i1 = this.vert(p(a1, y0), n1, [(k + 1) / sides, y0], part);
      const i2 = this.vert(p(a1, y1), n1, [(k + 1) / sides, y1], part);
      const i3 = this.vert(p(a0, y1), n0, [k / sides, y1], part);
      this.i.push(i0, i2, i1, i0, i3, i2);
    }
  }

  /** Flat disc facing +z. */
  discZ(
    cx: number,
    cy: number,
    z: number,
    r: number,
    sides: number,
    part: Part,
  ) {
    const c = this.vert([cx, cy, z], [0, 0, 1], [0.5, 0.5], part);
    const ring: number[] = [];
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      ring.push(
        this.vert(
          [cx + Math.cos(a) * r, cy + Math.sin(a) * r, z],
          [0, 0, 1],
          [0, 0],
          part,
        ),
      );
    }
    for (let k = 0; k < sides; k++) this.i.push(c, ring[k], ring[k + 1]);
  }

  mesh(): DetailMesh {
    return {vertices: this.v, indices: this.i};
  }
}

function ledge(): DetailMesh {
  // Unit box (scaled: length, thickness, depth); a thin drip lip underneath.
  const b = new B();
  b.box(-0.5, 0.5, -0.5, 0.5, 0, 1, Part.Body);
  b.box(-0.5, 0.5, -0.62, -0.5, 0.82, 1, Part.Dark);
  return b.mesh();
}

function fin(): DetailMesh {
  const b = new B();
  b.box(-0.5, 0.5, 0, 1, 0, 1, Part.Body);
  // Recessed light slot on the front edge (lit on some buildings).
  b.box(-0.18, 0.18, 0, 1, 1, 1.03, Part.Emissive);
  return b.mesh();
}

function pipe(): DetailMesh {
  // Unit: diameter 1 (x/z scale), height 1 (y scale), touching the wall.
  const b = new B();
  b.cylY(0, 0.6, 0.5, 0, 1, 8, Part.Dark);
  // Collars every ~1/6 of the run.
  for (let k = 1; k < 6; k++)
    b.cylY(0, 0.6, 0.62, k / 6 - 0.008, k / 6 + 0.008, 8, Part.Body);
  return b.mesh();
}

function ac(): DetailMesh {
  // Window-mounted air conditioner on brackets (meters).
  const b = new B();
  b.box(-0.45, 0.45, 0, 0.62, 0.05, 0.6, Part.Body);
  // Grille panel with slats.
  b.box(-0.41, 0.12, 0.07, 0.55, 0.6, 0.61, Part.Dark);
  for (let k = 0; k < 6; k++) {
    const y = 0.1 + k * 0.075;
    b.box(-0.41, 0.12, y, y + 0.025, 0.61, 0.64, Part.Body);
  }
  // Fan with hub.
  b.discZ(0.27, 0.31, 0.61, 0.15, 14, Part.Dark);
  b.discZ(0.27, 0.31, 0.615, 0.04, 8, Part.Body);
  b.box(0.12, 0.42, 0.3, 0.32, 0.611, 0.62, Part.Body);
  // Status light.
  b.box(0.36, 0.41, 0.07, 0.1, 0.6, 0.62, Part.Emissive);
  // Brackets.
  for (const x of [-0.36, 0.36]) {
    b.box(x - 0.025, x + 0.025, -0.06, 0, 0, 0.62, Part.Dark);
    b.box(x - 0.02, x + 0.02, -0.4, -0.06, 0, 0.05, Part.Dark);
  }
  return b.mesh();
}

function balcony(): DetailMesh {
  // Unit x (scaled to the cell), meters in y/z.
  const b = new B();
  b.box(-0.5, 0.5, -0.12, 0.08, 0, 1.3, Part.Body);
  b.box(-0.5, 0.5, 0.08, 1.02, 1.22, 1.3, Part.Parapet);
  b.box(-0.5, -0.47, 0.08, 1.02, 0, 1.3, Part.Parapet);
  b.box(0.47, 0.5, 0.08, 1.02, 0, 1.3, Part.Parapet);
  b.box(-0.5, 0.5, 1.02, 1.07, 1.2, 1.33, Part.Dark);
  // Soffit light.
  b.box(-0.3, 0.3, -0.14, -0.12, 0.5, 0.8, Part.Emissive);
  return b.mesh();
}

function awning(): DetailMesh {
  // Unit x, meters in y/z: sloped fabric awning with a valance.
  const b = new B();
  const top = [0, 0, 0.02];
  const lo = [0, -0.5, 0.9];
  // Perpendicular to the slope (dy -0.5, dz 0.88), facing up and out.
  const n = [0, 0.87, 0.49];
  b.quad(
    [-0.5, lo[1], lo[2]],
    [0.5, lo[1], lo[2]],
    [0.5, top[1], top[2]],
    [-0.5, top[1], top[2]],
    n,
    Part.Fabric,
  );
  b.quad(
    [0.5, lo[1], lo[2]],
    [-0.5, lo[1], lo[2]],
    [-0.5, top[1], top[2]],
    [0.5, top[1], top[2]],
    [0, -n[1], -n[2]],
    Part.Fabric,
  );
  b.box(-0.5, 0.5, -0.68, -0.5, 0.88, 0.92, Part.Fabric);
  return b.mesh();
}

function cage(): DetailMesh {
  // Window grille box (Kowloon style). Unit x/y (scaled to the window),
  // meters in z.
  const b = new B();
  b.box(-0.5, 0.5, -0.5, -0.46, 0, 0.45, Part.Dark);
  b.box(-0.5, 0.5, 0.46, 0.5, 0, 0.45, Part.Dark);
  b.box(-0.5, -0.47, -0.46, 0.46, 0.4, 0.45, Part.Dark);
  b.box(0.47, 0.5, -0.46, 0.46, 0.4, 0.45, Part.Dark);
  for (const x of [-0.3, -0.1, 0.1, 0.3])
    b.box(x - 0.012, x + 0.012, -0.46, 0.46, 0.42, 0.45, Part.Dark);
  b.box(-0.5, 0.5, -0.02, 0.02, 0.42, 0.45, Part.Dark);
  // Junk on the sill: a crate and a plant pot.
  b.box(-0.4, -0.15, -0.46, -0.3, 0.1, 0.35, Part.Body);
  b.box(0.15, 0.3, -0.46, -0.32, 0.12, 0.28, Part.Fabric);
  return b.mesh();
}

function vent(): DetailMesh {
  // Louvered exhaust box (meters).
  const b = new B();
  b.box(-0.6, 0.6, 0, 0.7, 0, 0.3, Part.Body);
  for (let k = 0; k < 5; k++) {
    const y = 0.08 + k * 0.12;
    b.box(-0.55, 0.55, y, y + 0.05, 0.3, 0.36, Part.Dark);
  }
  return b.mesh();
}

function canopy(): DetailMesh {
  // Shopfront canopy (unit x, meters) with a lit underside.
  const b = new B();
  b.box(-0.5, 0.5, -0.18, 0.18, 0, 1.7, Part.Dark);
  b.box(-0.47, 0.47, -0.2, -0.18, 0.15, 1.6, Part.Emissive);
  b.box(-0.5, 0.5, 0.18, 0.24, 1.55, 1.7, Part.Body);
  return b.mesh();
}

function moduleBox(): DetailMesh {
  // Bolted-on room module (unit; scaled w/h/depth); windows are drawn by
  // the shader from local meters.
  const b = new B();
  b.box(-0.5, 0.5, 0, 1, 0, 1, Part.Module);
  return b.mesh();
}

export function buildDetailMeshes(): DetailMesh[] {
  const ledgeMesh = ledge();
  const finMesh = fin();
  return [
    ledgeMesh,
    finMesh,
    pipe(),
    ac(),
    balcony(),
    awning(),
    cage(),
    vent(),
    canopy(),
    moduleBox(),
  ];
}
