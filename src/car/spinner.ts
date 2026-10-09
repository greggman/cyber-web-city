// The player's flying car: an original Blade Runner-style police "spinner".
// Convention: meters, +X right, +Y up, nose toward -Z, y = 0 is the ground.
import {NurbsCurve, loft, revolve, type NurbsSurface} from '../nurbs/nurbs';
import type {Model, Part} from '../nurbs/model';
import {add, cross, normalize, scale, sub, type Vec3} from '../math/vec';
import {keyed, steps, orient, ruled, superBox, pipe, conform} from './parts';

export const SPINNER_DRIVER_EYE: Vec3 = [-0.4, 1.4, 0.3];

// Key stations along the car.
const zN = -2.7; // nose
const zC0 = -1.1; // cowl (windshield base)
const zC1 = 1.75; // rear of canopy
const zT = 2.62; // tail

const keel = keyed([
  [-2.8, 0.48],
  [-2.4, 0.41],
  [-1.8, 0.38],
  [1.6, 0.38],
  [2.3, 0.42],
  [2.7, 0.48],
]);
const bottomW = keyed([
  [-2.8, 0.62],
  [-2.2, 0.66],
  [-1.2, 0.76],
  [0.3, 0.78],
  [1.2, 0.7],
  [2.2, 0.66],
  [2.7, 0.64],
]);
const flareW = keyed([
  [-2.8, 0.8],
  [-2.3, 0.9],
  [-1.4, 0.94],
  [-0.6, 0.96],
  [0.5, 0.97],
  [1.3, 1.03],
  [2.0, 1.1],
  [2.5, 1.09],
  [2.7, 1.04],
]);
const shoulderY = keyed([
  [-2.8, 0.92],
  [-2.2, 1.0],
  [-1.0, 1.1],
  [0.4, 1.12],
  [1.3, 1.2],
  [2.0, 1.31],
  [2.3, 1.32],
  [2.7, 1.24],
]);
const ledge = keyed([
  [-2.8, 0.15],
  [-1.6, 0.17],
  [-1.0, 0.14],
  [0.3, 0.12],
  [1.3, 0.16],
  [2.0, 0.28],
  [2.7, 0.26],
]);
const drop = keyed([
  [-2.8, 0.03],
  [-1.0, 0.03],
  [1.3, 0.05],
  [2.0, 0.16],
  [2.7, 0.15],
]);
const crown = keyed([
  [-2.8, 0.0],
  [-2.0, 0.03],
  [-1.0, 0.04],
  [1.2, 0.03],
  [2.7, 0.02],
]);
const bubble = keyed([
  [zC0, 0],
  [-0.85, 0.2],
  [-0.42, 0.45],
  [0.05, 0.6],
  [0.55, 0.61],
  [0.95, 0.52],
  [1.35, 0.3],
  [zC1, 0],
]);
// Height of the flare's lower lip, as a fraction keel -> shoulder.
const flareEdge = keyed([
  [-2.8, 0.45],
  [-2.2, 0.5],
  [-1.2, 0.6],
  [0.3, 0.6],
  [1.2, 0.5],
  [2.0, 0.42],
  [2.7, 0.42],
]);

const edgeX = (z: number) => flareW(z) - ledge(z);
const edgeY = (z: number) => shoulderY(z) - drop(z);
const FLOOR = 0.52;

/** Point on the flare's lower lip (where the lower and upper hull meet). */
function lip(z: number): Vec3 {
  const yk = keel(z);
  return [flareW(z) - 0.035, yk + flareEdge(z) * (shoulderY(z) - yk), z];
}

/** Right half lower hull section: keel (x = 0) to the flare lip. */
function lowerSection(z: number): NurbsCurve {
  const yk = keel(z);
  const bw = bottomW(z);
  const l = lip(z);
  const dy = l[1] - yk;
  return NurbsCurve.fromPoints([
    [0, yk, z],
    [0.55 * bw, yk, z],
    [0.95 * bw, yk + 0.004, z],
    [bw + 0.03, yk + 0.08 * dy, z],
    [bw + 0.06, yk + 0.6 * dy, z],
    [l[0] - 0.08, l[1] - 0.01, z],
    l,
  ]);
}

/** Right half upper hull section: flare lip up to the edge line. */
function upperSection(z: number): NurbsCurve {
  const sw = flareW(z);
  const ys = shoulderY(z);
  const l = lip(z);
  const ex = edgeX(z);
  const ey = edgeY(z);
  const dy = ys - l[1];
  return NurbsCurve.fromPoints([
    l,
    [sw + 0.005, l[1] + 0.012, z],
    [sw + 0.012, l[1] + 0.5 * dy, z],
    [sw + 0.005, ys - 0.03, z],
    [sw - 0.03, ys, z],
    [ex + 0.04, ey + 0.005, z],
    [ex, ey, z],
  ]);
}

// Shape of top sections (hood/canopy/deck) from +edge to -edge.
const TOP_XF = [1.012, 0.97, 0.8, 0.5, 0, -0.5, -0.8, -0.97, -1.012];
const TOP_CF = [-0.3, 0.25, 0.7, 0.95, 1, 0.95, 0.7, 0.25, -0.3];
const CAN_XF = [1.012, 1.0, 0.9, 0.55, 0, -0.55, -0.9, -1.0, -1.012];
const CAN_YF = [-0.02, 0.5, 0.9, 1.0, 1.0, 1.0, 0.9, 0.5, -0.02];

function topSection(z: number, h = 0): NurbsCurve {
  const ex = edgeX(z);
  const ey = edgeY(z);
  const c = crown(z);
  const w = Math.min(1, h / 0.22);
  return NurbsCurve.fromPoints(
    TOP_XF.map((xf, i) => {
      const x = (xf + (CAN_XF[i] - xf) * w) * ex;
      const y = ey + TOP_CF[i] * c * (1 - w) + h * CAN_YF[i];
      return [x, y, z] as Vec3;
    }),
  );
}

/** Points along a planar (z = const) section curve, offset outward. */
function offsetSection(
  c: NurbsCurve,
  off: number,
  n: number,
  center: Vec3,
  t0 = 0,
  t1 = 1,
): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    const p = c.evaluate(t);
    const tan = c.tangent(t);
    let nn: Vec3 = normalize([tan[1], -tan[0], 0]);
    const out = sub(p, center);
    if (nn[0] * out[0] + nn[1] * out[1] < 0) nn = scale(nn, -1);
    pts.push(add(p, scale(nn, off)));
  }
  return pts;
}

/** v such that s(u, v) has the given z (s must be monotone in z along v). */
function vAtZ(s: NurbsSurface, u: number, z: number): number {
  let lo = 0;
  let hi = 1;
  const inc = s.evaluate(u, 1)[2] > s.evaluate(u, 0)[2];
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (s.evaluate(u, m)[2] < z === inc) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

// Materials.
const PAINT: Vec3 = [0.085, 0.105, 0.14];
const DARK: Vec3 = [0.03, 0.032, 0.036];
const TRIM: Vec3 = [0.2, 0.21, 0.23];
const LOWER: Vec3 = [0.075, 0.08, 0.09];
const FASCIA: Vec3 = [0.12, 0.125, 0.135];
const LEATHER: Vec3 = [0.075, 0.03, 0.022];
const HEAD: Vec3 = [6, 5, 4];
const TAIL: Vec3 = [8, 0.5, 0.3];
const THRUST: Vec3 = [1.2, 2.8, 7];
const AMBER: Vec3 = [8, 3.2, 0.4];
const CYAN: Vec3 = [0.4, 5, 7];

const REV = (u: number, v = 40) => ({segmentsU: u, segmentsV: v});

/** Rear ducted thruster nacelle (axis along z). */
function nacelle(name: string, c: Vec3, R: number, L: number): Part[] {
  const [cx, cy, z0] = c;
  const z1 = z0 + L;
  const prof: [number, number][] = [
    [0.84, 1],
    [0.94, 0.75],
    [1.0, 0.35],
    [1.0, 0.08],
    [0.93, 0],
    [0.83, 0.02],
    [0.79, 0.12],
    [0.78, 0.6],
    [0.78, 0.97],
    [0.8, 1],
    [0.84, 1],
  ];
  const curve = NurbsCurve.fromPoints(
    prof.map(([r, a]) => [cx + r * R, cy, z0 + a * L] as Vec3),
  );
  const ax: Vec3 = [cx, cy, 0];
  const Z: Vec3 = [0, 0, 1];
  const rev = (pts: [number, number][]) =>
    revolve(
      NurbsCurve.fromPoints(
        pts.map(([r, a]) => [cx + r * R, cy, z0 + a * L] as Vec3),
      ),
      ax,
      Z,
    );
  const duct = orient(revolve(curve, ax, Z), [1, 0, 0], 0.3, 0);
  const lip = orient(
    rev([
      [1.005, 0.1],
      [1.03, 0.04],
      [0.95, -0.01],
      [0.85, 0.01],
    ]),
    [0, 0, -1],
    0.6,
    0,
  );
  const fan = rev([
    [0, 0.05],
    [0.2, 0.06],
    [0.32, 0.15],
    [0.8, 0.17],
  ]);
  const blades = rev([
    [0.3, 0.2],
    [0.55, 0.21],
    [0.8, 0.2],
  ]);
  const glow = rev([
    [0.79, 0.9],
    [0.5, 0.86],
    [0.2, 0.8],
    [0, 0.79],
  ]);
  const cone = orient(
    rev([
      [0, 1.02],
      [0.12, 1.0],
      [0.3, 0.9],
      [0.34, 0.8],
    ]),
    [0, 0, 1],
    0.3,
    0,
  );
  const nozzle = orient(
    rev([
      [0.79, 0.88],
      [0.74, 0.94],
      [0.79, 0.995],
    ]),
    [-1, 0, 0],
    0.5,
    0,
  );
  return [
    {
      name: `${name}-duct`,
      surface: duct,
      material: 'paint',
      color: PAINT,
      mirror: true,
      tessellation: REV(26, 36),
    },
    {
      name: `${name}-lip`,
      surface: lip,
      material: 'chrome',
      mirror: true,
      tessellation: REV(6, 44),
    },
    {
      name: `${name}-fan`,
      surface: orient(fan, [0, 0, -1], 0.5, 0.5),
      material: 'metal',
      color: [0.3, 0.31, 0.33],
      mirror: true,
      tessellation: REV(8, 36),
    },
    {
      name: `${name}-stator`,
      surface: orient(blades, [0, 0, -1], 0.5, 0.5),
      material: 'metal',
      color: DARK,
      mirror: true,
      tessellation: REV(3, 36),
    },
    {
      name: `${name}-glow`,
      surface: orient(glow, [0, 0, 1], 0.5, 0.5),
      material: 'emissive',
      emissive: THRUST,
      mirror: true,
      tessellation: REV(8, 36),
    },
    ...[0.3, 0.56].map((a): Part => ({
      name: `${name}-band`,
      surface: orient(
        rev([
          [0.995, a - 0.008],
          [1.016, a - 0.005],
          [1.016, a + 0.005],
          [0.995, a + 0.008],
        ]),
        [1, 0, 0],
        0.5,
        0,
      ),
      material: 'metal',
      color: TRIM,
      mirror: true,
      tessellation: REV(4, 36),
    })),
    {
      name: `${name}-hub`,
      surface: orient(
        rev([
          [0, -0.02],
          [0.1, -0.01],
          [0.2, 0.04],
          [0.22, 0.07],
        ]),
        [0, 0, -1],
        0.2,
        0,
      ),
      material: 'chrome',
      mirror: true,
      tessellation: REV(6, 24),
    },
    {
      name: `${name}-cone`,
      surface: cone,
      material: 'metal',
      color: [0.12, 0.12, 0.13],
      mirror: true,
      tessellation: REV(8, 32),
    },
    {
      name: `${name}-nozzle`,
      surface: nozzle,
      material: 'metal',
      color: DARK,
      mirror: true,
      tessellation: REV(4, 44),
    },
    {
      name: `${name}-lift`,
      surface: superBox(
        [cx, cy - R * 0.97, z0 + 0.55 * L],
        [0.5 * L * 0.6, 0.012, R * 0.3],
        0.3,
        {x: [0, 0, 1], y: [0, 1, 0], z: [-1, 0, 0], nu: 9, nv: 11},
      ),
      material: 'emissive',
      emissive: scale(THRUST, 0.7),
      mirror: true,
      tessellation: {segmentsU: 10, segmentsV: 12},
    },
    {
      name: `${name}-marker`,
      surface: superBox(
        [cx + R * 0.96, cy + 0.02, z1 - 0.3 * L],
        [0.08, 0.018, 0.02],
        0.3,
        {x: [0, 0, 1], y: [0, 1, 0], z: [-1, 0, 0], nu: 9, nv: 11},
      ),
      material: 'emissive',
      emissive: TAIL,
      mirror: true,
      tessellation: {segmentsU: 8, segmentsV: 10},
    },
  ];
}

/** Front pod: angular housing, headlights up front, lift glow below. */
function frontPod(c: Vec3, hz: number, hy: number, hx: number): Part[] {
  const [cx, cy, cz] = c;
  const fz = cz - hz;
  const bz = cz + hz;
  const box = (
    name: string,
    p: Vec3,
    h: Vec3,
    e: number,
    mat: Partial<Part> & Pick<Part, 'material'>,
    seg = 10,
  ): Part => ({
    name,
    surface: superBox(p, h, e, {nu: 9, nv: 13}),
    mirror: true,
    tessellation: {segmentsU: seg, segmentsV: seg + 4},
    ...mat,
  });
  return [
    {
      name: 'pod-shell',
      surface: superBox(c, [hz, hy, hx], 0.28, {
        x: [0, 0, 1],
        y: [0, 1, 0],
        z: [1, 0, 0],
        taperY: 0.8,
        taperZ: 0.9,
        e2: 0.32,
        nu: 13,
        nv: 21,
      }),
      material: 'paint',
      color: PAINT,
      mirror: true,
      tessellation: {segmentsU: 22, segmentsV: 28},
    },
    box(
      'pod-bezel',
      [cx, cy + 0.01, fz + 0.004],
      [0.14, 0.07, 0.014],
      0.25,
      {material: 'chrome'},
      12,
    ),
    box(
      'headlight',
      [cx - 0.065, cy + 0.01, fz - 0.006],
      [0.055, 0.045, 0.012],
      0.3,
      {
        material: 'emissive',
        emissive: HEAD,
      },
    ),
    box(
      'headlight',
      [cx + 0.065, cy + 0.01, fz - 0.006],
      [0.055, 0.045, 0.012],
      0.3,
      {
        material: 'emissive',
        emissive: HEAD,
      },
    ),
    box('pod-nozzle', [cx, cy, bz - 0.004], [0.12, 0.08, 0.02], 0.3, {
      material: 'metal',
      color: DARK,
    }),
    box('pod-glow', [cx, cy, bz + 0.012], [0.095, 0.055, 0.008], 0.3, {
      material: 'emissive',
      emissive: THRUST,
    }),
    box('pod-lift', [cx, cy - hy * 0.98, cz + 0.02], [0.1, 0.012, 0.28], 0.3, {
      material: 'emissive',
      emissive: scale(THRUST, 0.7),
    }),
    box(
      'side-marker',
      [cx + hx * 0.97, cy + 0.02, fz + 0.16],
      [0.02, 0.016, 0.07],
      0.3,
      {
        material: 'emissive',
        emissive: AMBER,
      },
    ),
  ];
}

function interior(parts: Part[]) {
  // Cockpit tub: sill and door cards, then the floor, hanging off the edge
  // line (two lofts sharing the boundary column).
  const tubZ = steps(zC0 - 0.06, zC1 + 0.06, 12);
  const doorCard = loft(
    tubZ.map(z => {
      const ex = edgeX(z);
      const ey = edgeY(z);
      return NurbsCurve.fromPoints([
        [ex + 0.01, ey - 0.01, z],
        [ex - 0.03, ey - 0.005, z],
        [ex - 0.06, ey - 0.06, z],
        [ex - 0.075, ey - 0.25, z],
        [ex - 0.05, FLOOR + 0.12, z],
        [ex - 0.06, FLOOR + 0.03, z],
      ]);
    }),
  );
  const floor = loft(
    tubZ.map(z => {
      const ex = edgeX(z);
      return NurbsCurve.fromPoints([
        [ex - 0.06, FLOOR + 0.03, z],
        [ex - 0.07, FLOOR, z],
        [0.5 * ex, FLOOR, z],
        [0, FLOOR, z],
      ]);
    }),
  );
  parts.push({
    name: 'door-card',
    surface: orient(doorCard, [-1, 0, 0], 0.6, 0.5),
    material: 'leather',
    color: [0.07, 0.068, 0.066],
    mirror: true,
    tessellation: {segmentsU: 10, segmentsV: 22},
  });
  parts.push({
    name: 'floor',
    surface: orient(floor, [0, 1, 0], 0.6, 0.5),
    material: 'rubber',
    color: [0.025, 0.025, 0.028],
    mirror: true,
    tessellation: {segmentsU: 4, segmentsV: 22},
  });
  // Bulkhead behind the seats and a parcel shelf under the fastback glass.
  const bz = 1.0;
  const shelfY = 1.02;
  parts.push({
    name: 'rear-bulkhead',
    surface: orient(
      loft(
        [
          NurbsCurve.fromPoints([
            [edgeX(bz) - 0.08, FLOOR, bz + 0.06],
            [0.36, FLOOR, bz + 0.06],
            [0, FLOOR, bz + 0.06],
          ]),
          NurbsCurve.fromPoints([
            [edgeX(bz) - 0.07, shelfY, bz],
            [0.4, shelfY, bz],
            [0, shelfY, bz],
          ]),
        ],
        1,
      ),
      [0, 0, -1],
    ),
    material: 'carbon',
    mirror: true,
  });
  const shelf = loft(
    steps(bz, zC1 + 0.04, 6).map(z =>
      NurbsCurve.fromPoints([
        [edgeX(z) - 0.065, shelfY, z],
        [0.5 * edgeX(z), shelfY, z],
        [0, shelfY, z],
      ]),
    ),
  );
  parts.push({
    name: 'parcel-shelf',
    surface: orient(shelf, [0, 1, 0]),
    material: 'plastic',
    color: [0.03, 0.03, 0.033],
    mirror: true,
    tessellation: {segmentsU: 2, segmentsV: 12},
  });
  parts.push({
    name: 'shelf-light',
    surface: superBox(
      [0, shelfY + 0.004, bz + 0.03],
      [0.6, 0.006, 0.012],
      0.3,
      {
        nu: 7,
        nv: 9,
      },
    ),
    material: 'emissive',
    emissive: [0.3, 2.5, 3],
    tessellation: {segmentsU: 6, segmentsV: 8},
  });
  // Door armrests with a pull handle.
  parts.push({
    name: 'armrest',
    surface: superBox(
      [edgeX(0.2) - 0.11, 0.86, 0.15],
      [0.38, 0.03, 0.045],
      0.35,
      {
        x: [0, 0, 1],
        y: [0, 1, 0],
        z: [1, 0, 0],
        nu: 9,
        nv: 13,
      },
    ),
    material: 'leather',
    color: LEATHER,
    mirror: true,
    tessellation: {segmentsU: 14, segmentsV: 16},
  });

  // Dashboard: main slab plus a hooded binnacle in front of the driver.
  parts.push({
    name: 'dash',
    surface: superBox([0, 0.84, -0.92], [0.82, 0.12, 0.26], 0.3, {
      nu: 13,
      nv: 17,
    }),
    material: 'plastic',
    color: [0.04, 0.04, 0.045],
    tessellation: {segmentsU: 28, segmentsV: 24},
  });
  parts.push({
    name: 'dash-pad',
    surface: superBox([0, 0.95, -0.82], [0.78, 0.03, 0.18], 0.25, {
      nu: 11,
      nv: 15,
    }),
    material: 'leather',
    color: [0.03, 0.025, 0.025],
    tessellation: {segmentsU: 24, segmentsV: 20},
  });
  const eye = SPINNER_DRIVER_EYE;
  const screen = (
    c: Vec3,
    w: number,
    h: number,
    id: number,
    tint: Vec3,
    name: string,
  ) => {
    const n = normalize(sub(eye, c));
    const X = normalize(cross([0, 1, 0], n));
    const Y = cross(n, X);
    const p = (a: number, b: number): Vec3 =>
      add(c, add(scale(X, a * w), scale(Y, b * h)));
    const s = loft(
      [
        NurbsCurve.line(p(-0.5, -0.5), p(0.5, -0.5)),
        NurbsCurve.line(p(-0.5, 0.5), p(0.5, 0.5)),
      ],
      1,
    );
    parts.push({
      name,
      surface: orient(s, n),
      material: 'screen',
      screenId: id,
      emissive: tint,
    });
    parts.push({
      name: `${name}-bezel`,
      surface: superBox(
        sub(c, scale(n, 0.016)),
        [w / 2 + 0.018, h / 2 + 0.018, 0.014],
        0.2,
        {x: X, y: Y, z: n, nu: 9, nv: 13},
      ),
      material: 'metal',
      color: DARK,
      tessellation: {segmentsU: 10, segmentsV: 16},
    });
  };
  screen([-0.4, 1.0, -0.68], 0.3, 0.11, 1, [1, 1, 1], 'gauges');
  screen([0.02, 0.99, -0.72], 0.26, 0.15, 0, [1, 1, 1], 'nav');
  screen([0.44, 0.98, -0.74], 0.22, 0.12, 2, [1, 1, 1], 'comms');
  // Dash face: a thin cyan accent line, air vents and a row of switches.
  const dashFaceZ = -0.92 + 0.26;
  const db = (
    name: string,
    c: Vec3,
    h: Vec3,
    m: Partial<Part> & Pick<Part, 'material'>,
    mirror = false,
  ) =>
    parts.push({
      name,
      surface: superBox(c, h, 0.3, {nu: 7, nv: 9}),
      mirror,
      tessellation: {segmentsU: 6, segmentsV: 8},
      ...m,
    });
  db('dash-accent', [0, 0.79, dashFaceZ + 0.004], [0.74, 0.004, 0.004], {
    material: 'emissive',
    emissive: [0.3, 1.6, 2.4],
  });
  db(
    'dash-vent',
    [0.66, 0.88, dashFaceZ + 0.002],
    [0.1, 0.028, 0.008],
    {
      material: 'metal',
      color: [0.02, 0.02, 0.022],
    },
    true,
  );
  for (let i = 0; i < 5; i++) {
    db(
      'switch',
      [0.12 + i * 0.05, 0.86, dashFaceZ + 0.006],
      [0.012, 0.008, 0.006],
      {
        material: 'emissive',
        emissive: i % 2 ? [3, 1.2, 0.2] : [0.3, 2, 2.5],
      },
    );
  }
  for (let i = 0; i < 3; i++) {
    db(
      'console-button',
      [-0.05 + i * 0.05, 0.805, -0.35],
      [0.014, 0.006, 0.014],
      {
        material: 'emissive',
        emissive: i === 1 ? [3, 0.4, 0.2] : [0.4, 2, 2.5],
      },
    );
  }

  // Center console between the seats.
  parts.push({
    name: 'console',
    surface: superBox([0, 0.66, -0.1], [0.55, 0.14, 0.12], 0.3, {
      x: [0, 0, 1],
      y: [0, 1, 0],
      z: [-1, 0, 0],
      nu: 11,
      nv: 13,
    }),
    material: 'carbon',
    tessellation: {segmentsU: 20, segmentsV: 18},
  });
  parts.push({
    name: 'throttle',
    surface: pipe(
      [
        [0.0, 0.78, 0.05],
        [0.0, 0.86, 0.0],
        [0.0, 0.9, -0.01],
      ],
      0.012,
    ),
    material: 'chrome',
    tessellation: {segmentsU: 8, segmentsV: 6},
  });
  parts.push({
    name: 'throttle-knob',
    surface: superBox([0, 0.915, -0.012], [0.03, 0.025, 0.03], 0.5, {
      nu: 7,
      nv: 9,
    }),
    material: 'rubber',
    tessellation: {segmentsU: 8, segmentsV: 10},
  });

  // Flight yoke.
  const yz = -0.33;
  const yy = 0.93;
  parts.push({
    name: 'yoke-column',
    surface: pipe(
      [
        [-0.4, 0.86, -0.78],
        [-0.4, 0.9, -0.55],
        [-0.4, yy, yz - 0.02],
      ],
      0.026,
    ),
    material: 'metal',
    color: DARK,
    tessellation: {segmentsU: 12, segmentsV: 8},
  });
  parts.push({
    name: 'yoke',
    surface: pipe(
      [
        [-0.57, yy + 0.1, yz + 0.02],
        [-0.585, yy + 0.04, yz + 0.01],
        [-0.53, yy - 0.01, yz],
        [-0.4, yy - 0.015, yz - 0.01],
        [-0.27, yy - 0.01, yz],
        [-0.215, yy + 0.04, yz + 0.01],
        [-0.23, yy + 0.1, yz + 0.02],
      ],
      0.016,
      {up: [0, 0, 1]},
    ),
    material: 'rubber',
    tessellation: {segmentsU: 10, segmentsV: 40},
  });
  parts.push({
    name: 'yoke-hub',
    surface: superBox([-0.4, yy, yz], [0.045, 0.028, 0.025], 0.3, {
      nu: 9,
      nv: 13,
    }),
    material: 'metal',
    color: TRIM,
    tessellation: {segmentsU: 10, segmentsV: 14},
  });

  // Seats.
  for (const sx of [-0.4, 0.4]) {
    const hz = 0.52;
    parts.push({
      name: 'seat-cushion',
      surface: superBox(
        [sx, FLOOR + 0.13, hz - 0.14],
        [0.23, 0.07, 0.25],
        0.3,
        {
          nu: 11,
          nv: 15,
        },
      ),
      material: 'leather',
      color: LEATHER,
      tessellation: {segmentsU: 14, segmentsV: 20},
    });
    const t = 0.3; // recline
    const Y: Vec3 = [0, Math.cos(t), Math.sin(t)];
    const Z: Vec3 = [0, -Math.sin(t), Math.cos(t)];
    const back = add([sx, FLOOR + 0.2, hz + 0.12], scale(Y, 0.32));
    parts.push({
      name: 'seat-back',
      surface: superBox(back, [0.21, 0.33, 0.065], 0.3, {
        y: Y,
        z: Z,
        nu: 11,
        nv: 15,
      }),
      material: 'leather',
      color: LEATHER,
      tessellation: {segmentsU: 14, segmentsV: 20},
    });
    parts.push({
      name: 'seat-shell',
      surface: superBox(add(back, scale(Z, 0.06)), [0.235, 0.36, 0.04], 0.25, {
        y: Y,
        z: Z,
        nu: 11,
        nv: 15,
      }),
      material: 'carbon',
      tessellation: {segmentsU: 14, segmentsV: 20},
    });
    for (const side of [-1, 1]) {
      parts.push({
        name: 'seat-bolster',
        surface: superBox(
          add(
            add([sx + side * 0.2, FLOOR + 0.2, hz + 0.1], scale(Y, 0.24)),
            scale(Z, -0.03),
          ),
          [0.04, 0.24, 0.075],
          0.4,
          {y: Y, z: Z, nu: 9, nv: 11},
        ),
        material: 'leather',
        color: [0.055, 0.022, 0.016],
        tessellation: {segmentsU: 10, segmentsV: 12},
      });
    }
    parts.push({
      name: 'headrest',
      surface: superBox(add(back, scale(Y, 0.44)), [0.12, 0.075, 0.06], 0.35, {
        y: Y,
        z: Z,
        nu: 9,
        nv: 13,
      }),
      material: 'leather',
      color: LEATHER,
      tessellation: {segmentsU: 10, segmentsV: 14},
    });
  }
}

export function buildSpinner(): Model {
  const parts: Part[] = [];

  // Main hull: a dark lower tub and the painted upper flanks, two lofts
  // sharing the flare lip line (identical boundary column, so no gap).
  const hullZ = [
    ...steps(zN, -2.4, 4),
    ...steps(-2.2, zC0, 4),
    ...steps(-0.6, 1.2, 4),
    ...steps(1.5, zT, 6),
  ];
  const hullTessV = 46;
  const upper = loft(hullZ.map(upperSection));
  const lower = loft(hullZ.map(lowerSection));
  parts.push({
    name: 'hull-upper',
    surface: upper,
    material: 'paint',
    color: PAINT,
    mirror: true,
    tessellation: {segmentsU: 16, segmentsV: hullTessV},
  });
  parts.push({
    name: 'hull-lower',
    surface: lower,
    material: 'metal',
    color: LOWER,
    roughness: 0.42,
    mirror: true,
    tessellation: {segmentsU: 16, segmentsV: hullTessV},
  });
  // Bright trim strip along the flare lip.
  const trimPts: Vec3[] = [];
  for (const v of steps(0.02, 0.98, 24)) {
    trimPts.push(add(upper.evaluate(0, v), [0.004, -0.002, 0]));
  }
  parts.push({
    name: 'lip-trim',
    surface: pipe(trimPts, 0.01),
    material: 'chrome',
    mirror: true,
    tessellation: {segmentsU: 6, segmentsV: 48},
  });

  // Hood, canopy, rear deck.
  const panelTess = {maxEdge: 0.1, segmentsU: 24};
  const hood = orient(
    loft(steps(zN, zC0, 8).map(z => topSection(z))),
    [0, 1, 0],
  );
  parts.push({
    name: 'hood',
    surface: hood,
    material: 'paint',
    color: PAINT,
    tessellation: panelTess,
  });
  const canZ = steps(zC0, zC1, 19);
  const canopy = loft(canZ.map(z => topSection(z, bubble(z))));
  parts.push({
    name: 'canopy',
    surface: orient(canopy, [0, 1, 0]),
    material: 'glass',
    // Slightly bright tint: a faint sheen so the bubble reads in flat light.
    color: [16, 18, 21],
    doubleSided: true,
    tessellation: {segmentsU: 30, segmentsV: 32},
  });
  const deck = orient(
    loft(steps(zC1, zT, 8).map(z => topSection(z))),
    [0, 1, 0],
  );
  parts.push({
    name: 'deck',
    surface: deck,
    material: 'paint',
    color: PAINT,
    tessellation: panelTess,
  });

  // Hood vents (louvered, conforming to the hood).
  for (const [u0, u1] of [
    [0.2, 0.34],
    [0.66, 0.8],
  ]) {
    parts.push({
      name: 'hood-vent',
      surface: conform(hood, u0, u1, 0.5, 0.86, 0.003, {
        nu: 6,
        nv: 25,
        bump: (_a, b) => 0.008 * Math.abs(Math.sin(b * Math.PI * 6)),
      }),
      material: 'metal',
      color: DARK,
      tessellation: {segmentsU: 6, segmentsV: 48},
    });
  }

  // Haunch side vents ahead of the rear nacelles.
  const hv0 = vAtZ(upper, 0.5, 1.3);
  const hv1 = vAtZ(upper, 0.5, 1.85);
  parts.push({
    name: 'haunch-vent',
    surface: conform(upper, 0.3, 0.62, hv0, hv1, 0.003, {
      nu: 13,
      nv: 6,
      bump: a => 0.007 * Math.abs(Math.sin(a * Math.PI * 4)),
    }),
    material: 'metal',
    color: DARK,
    mirror: true,
    tessellation: {segmentsU: 32, segmentsV: 8},
  });

  // Nose fascia and tail panel: planar caps ruled horizontally from the
  // half outline to the center plane (no pole, so shading stays flat).
  for (const [z, dir, name] of [
    [zN, -1, 'nose-fascia'],
    [zT, 1, 'tail-panel'],
  ] as const) {
    const pts: Vec3[] = [];
    const ls = lowerSection(z);
    for (let i = 0; i <= 12; i++) pts.push(ls.evaluate(i / 12));
    const us = upperSection(z);
    for (let i = 1; i <= 10; i++) pts.push(us.evaluate(i / 10));
    const ts = topSection(z);
    for (let i = 1; i <= 8; i++) pts.push(ts.evaluate(0.5 * (i / 8)));
    const outline = NurbsCurve.interpolate(pts);
    const fan = ruled(
      outline.transform(([, y, zz]) => [0, y, zz]),
      outline,
    );
    parts.push({
      name,
      surface: orient(fan, [0, 0, dir], 0.5, 0.5),
      material: 'plastic',
      color: FASCIA,
      roughness: 0.5,
      mirror: true,
      tessellation: {segmentsU: 40, segmentsV: 1},
    });
  }

  // Hood power bulge with an intake, and fender sensor pods.
  const bulgeZ = -1.75;
  const bulgeY = topSection(bulgeZ).evaluate(0.5)[1];
  parts.push({
    name: 'hood-bulge',
    surface: superBox([0, bulgeY - 0.01, bulgeZ], [0.55, 0.05, 0.2], 0.3, {
      x: [0, 0, -1],
      y: [0, 1, 0],
      z: [1, 0, 0],
      taperY: 0.15,
      taperZ: 0.7,
      nu: 13,
      nv: 17,
    }),
    material: 'paint',
    color: PAINT,
    tessellation: {segmentsU: 24, segmentsV: 24},
  });
  parts.push({
    name: 'bulge-intake',
    surface: superBox(
      [0, bulgeY + 0.0, bulgeZ + 0.53],
      [0.15, 0.022, 0.012],
      0.3,
      {
        nu: 9,
        nv: 13,
      },
    ),
    material: 'metal',
    color: DARK,
    tessellation: {segmentsU: 10, segmentsV: 14},
  });
  for (const z of [-2.25]) {
    const fy = shoulderY(z) - 0.005;
    const fx = flareW(z) - 0.07;
    parts.push({
      name: 'sensor-pod',
      surface: superBox([fx, fy + 0.025, z], [0.1, 0.03, 0.04], 0.4, {
        x: [0, 0, 1],
        y: [0, 1, 0],
        z: [1, 0, 0],
        nu: 9,
        nv: 13,
      }),
      material: 'metal',
      color: TRIM,
      mirror: true,
      tessellation: {segmentsU: 12, segmentsV: 14},
    });
    parts.push({
      name: 'sensor-lens',
      surface: superBox(
        [fx, fy + 0.025, z - 0.095],
        [0.022, 0.018, 0.012],
        0.5,
        {
          nu: 7,
          nv: 9,
        },
      ),
      material: 'emissive',
      emissive: [6, 0.6, 0.3],
      mirror: true,
      tessellation: {segmentsU: 6, segmentsV: 8},
    });
  }

  // Canopy rails along the glass base and the cowl.
  const railPts: Vec3[] = steps(zC0 + 0.02, zC1 - 0.02, 16).map(z => [
    edgeX(z) + 0.005,
    edgeY(z) + 0.004,
    z,
  ]);
  parts.push({
    name: 'canopy-rail',
    surface: pipe(railPts, 0.014),
    material: 'metal',
    color: TRIM,
    mirror: true,
    tessellation: {segmentsU: 6, segmentsV: 36},
  });
  parts.push({
    name: 'cowl-rail',
    surface: pipe(
      offsetSection(topSection(zC0), 0.0, 12, [0, 0.6, zC0], 0.02, 0.98),
      0.016,
      {up: [0, 0, 1]},
    ),
    material: 'metal',
    color: TRIM,
    tessellation: {segmentsU: 8, segmentsV: 32},
  });

  // Roll hoop with the roof beacon.
  const hoopZ = canZ[13];
  const hoopC = topSection(hoopZ, bubble(hoopZ));
  const hoopPts = offsetSection(hoopC, 0.03, 16, [0, 1.0, hoopZ]);
  parts.push({
    name: 'roll-hoop',
    surface: pipe(hoopPts, 0.035, {up: [0, 0, 1]}),
    material: 'metal',
    color: TRIM,
    tessellation: {segmentsU: 10, segmentsV: 48},
  });
  const archZ = canZ[5];
  parts.push({
    name: 'canopy-arch',
    surface: pipe(
      offsetSection(topSection(archZ, bubble(archZ)), 0.014, 16, [
        0,
        1.0,
        archZ,
      ]),
      0.018,
      {up: [0, 0, 1]},
    ),
    material: 'metal',
    color: TRIM,
    tessellation: {segmentsU: 8, segmentsV: 44},
  });
  parts.push({
    name: 'canopy-spine',
    surface: pipe(
      steps(archZ, hoopZ, 8).map(z =>
        add(topSection(z, bubble(z)).evaluate(0.5), [0, 0.016, 0]),
      ),
      0.016,
    ),
    material: 'metal',
    color: TRIM,
    tessellation: {segmentsU: 8, segmentsV: 24},
  });
  // Side frame bars tracing the bubble between the arch and the hoop.
  parts.push({
    name: 'canopy-bar',
    surface: pipe(
      steps(archZ, hoopZ, 8).map(
        z =>
          offsetSection(
            topSection(z, bubble(z)),
            0.012,
            1,
            [0, 1.0, z],
            0.2,
            0.2,
          )[0],
      ),
      0.013,
    ),
    material: 'metal',
    color: TRIM,
    mirror: true,
    tessellation: {segmentsU: 8, segmentsV: 24},
  });
  const topY = hoopC.evaluate(0.5)[1] + 0.055;
  parts.push({
    name: 'beacon-housing',
    surface: superBox([0, topY, hoopZ], [0.36, 0.028, 0.07], 0.25, {
      nu: 11,
      nv: 15,
    }),
    material: 'metal',
    color: DARK,
    tessellation: {segmentsU: 20, segmentsV: 20},
  });
  for (const [x, col] of [
    [0.2, AMBER],
    [-0.2, CYAN],
  ] as const) {
    parts.push({
      name: 'beacon',
      surface: superBox([x, topY + 0.03, hoopZ], [0.12, 0.025, 0.05], 0.3, {
        nu: 9,
        nv: 13,
      }),
      material: 'emissive',
      emissive: col,
      tessellation: {segmentsU: 10, segmentsV: 14},
    });
  }

  // Nose: bumper, grille, lamps and light bar.
  const nb = (
    name: string,
    c: Vec3,
    h: Vec3,
    e: number,
    m: Partial<Part> & Pick<Part, 'material'>,
    seg = 12,
    mirror = false,
  ) =>
    parts.push({
      name,
      surface: superBox(c, h, e, {nu: 9, nv: 13}),
      mirror,
      tessellation: {segmentsU: seg, segmentsV: seg + 4},
      ...m,
    });
  nb(
    'bumper',
    [0, 0.53, zN - 0.05],
    [0.7, 0.075, 0.1],
    0.3,
    {
      material: 'metal',
      color: TRIM,
    },
    28,
  );
  nb(
    'bumper-pad',
    [0.42, 0.53, zN - 0.13],
    [0.12, 0.05, 0.035],
    0.35,
    {
      material: 'rubber',
    },
    12,
    true,
  );
  // Center light array in a dark recessed frame.
  nb(
    'array-frame',
    [0, 0.7, zN - 0.004],
    [0.34, 0.075, 0.012],
    0.2,
    {material: 'metal', color: [0.02, 0.02, 0.022]},
    12,
  );
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 6; i++) {
      nb(
        'array-lamp',
        [-0.27 + i * 0.108, 0.665 + r * 0.07, zN - 0.014],
        [0.04, 0.022, 0.006],
        0.3,
        {
          material: 'emissive',
          emissive: r === 0 && (i === 0 || i === 5) ? AMBER : scale(HEAD, 0.6),
        },
        4,
      );
    }
  }
  nb(
    'lamp-bezel',
    [0.53, 0.71, zN - 0.006],
    [0.13, 0.065, 0.012],
    0.25,
    {
      material: 'chrome',
    },
    12,
    true,
  );
  nb(
    'lamp',
    [0.53, 0.71, zN - 0.016],
    [0.11, 0.048, 0.01],
    0.3,
    {
      material: 'emissive',
      emissive: HEAD,
    },
    10,
    true,
  );
  nb(
    'light-bar',
    [0, 0.855, zN - 0.012],
    [0.62, 0.015, 0.016],
    0.2,
    {
      material: 'emissive',
      emissive: HEAD,
    },
    10,
  );

  // Tail: light strip, twin lamps and a diffuser.
  nb(
    'tail-light',
    [0, 1.1, zT + 0.008],
    [0.72, 0.022, 0.016],
    0.2,
    {
      material: 'emissive',
      emissive: TAIL,
    },
    10,
  );
  nb(
    'tail-lamp',
    [0.5, 0.92, zT + 0.006],
    [0.16, 0.04, 0.012],
    0.3,
    {
      material: 'emissive',
      emissive: TAIL,
    },
    10,
    true,
  );
  nb(
    'tail-lamp-bezel',
    [0.5, 0.92, zT + 0.002],
    [0.18, 0.055, 0.012],
    0.25,
    {
      material: 'metal',
      color: TRIM,
    },
    10,
    true,
  );

  for (let i = 0; i < 4; i++) {
    nb(
      'tail-slat',
      [0, 0.64 + i * 0.045, zT + 0.012],
      [0.3, 0.01, 0.014],
      0.3,
      {
        material: 'metal',
        color: TRIM,
      },
      8,
    );
  }
  // Rear deck louvers and a whip antenna.
  parts.push({
    name: 'deck-louvers',
    surface: conform(deck, 0.32, 0.68, 0.3, 0.72, 0.003, {
      nu: 6,
      nv: 29,
      bump: (_a, b) => 0.009 * Math.abs(Math.sin(b * Math.PI * 7)),
    }),
    material: 'metal',
    color: DARK,
    tessellation: {segmentsU: 6, segmentsV: 56},
  });
  parts.push({
    name: 'antenna',
    surface: pipe(
      [
        [-0.62, edgeY(2.25) + 0.08, 2.25],
        [-0.62, edgeY(2.25) + 0.3, 2.32],
        [-0.62, edgeY(2.25) + 0.55, 2.42],
      ],
      0.006,
    ),
    material: 'metal',
    color: DARK,
    tessellation: {segmentsU: 5, segmentsV: 6},
  });
  nb(
    'antenna-base',
    [-0.62, edgeY(2.25) + 0.04, 2.25],
    [0.03, 0.04, 0.03],
    0.4,
    {
      material: 'metal',
      color: TRIM,
    },
    8,
  );

  // Raised strakes along the lower hull and door seams on the flanks.
  for (const u of [0.72, 0.86]) {
    parts.push({
      name: 'strake',
      surface: conform(lower, u - 0.015, u + 0.015, 0.12, 0.86, 0.002, {
        nu: 4,
        nv: 24,
        bump: a => 0.012 * Math.sin(Math.PI * a),
      }),
      material: 'metal',
      color: TRIM,
      mirror: true,
      tessellation: {segmentsU: 3, segmentsV: 40},
    });
  }
  for (const z of [-0.95, 1.05]) {
    const v = vAtZ(upper, 0.5, z);
    parts.push({
      name: 'door-seam',
      surface: pipe(
        steps(0.06, 0.82, 6).map(u => upper.evaluate(u, v)),
        0.005,
      ),
      material: 'rubber',
      mirror: true,
      tessellation: {segmentsU: 5, segmentsV: 12},
    });
  }

  // Belly lift glows.
  for (const z of [-1.6, 1.7]) {
    parts.push({
      name: 'belly-glow',
      surface: superBox([0, keel(z) - 0.006, z], [0.32, 0.008, 0.18], 0.3, {
        nu: 9,
        nv: 13,
      }),
      material: 'emissive',
      emissive: scale(THRUST, 0.5),
      tessellation: {segmentsU: 10, segmentsV: 14},
    });
  }

  // Thrusters.
  parts.push(...nacelle('rear-nacelle', [0.99, 0.7, 1.3], 0.26, 1.5));
  parts.push(...frontPod([0.86, 0.6, -2.3], 0.46, 0.15, 0.16));

  interior(parts);
  return {name: 'spinner', parts};
}
