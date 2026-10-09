// The player's flying car: an original Blade Runner-style police "spinner".
// Convention: meters, +X right, +Y up, nose toward -Z, y = 0 is the ground.
//
// Construction overview
// - The body is a set of lofts driven by smooth z-profiles (keyed()): a dark
//   lower hull and a painted upper flank meeting at a crisp crease (the flare
//   lip), and full-width top panels (hood, canopy, rear deck) spanning the
//   "edge line" between the flanks.
// - The rear thrusters are lofted out of the lower quarter panels: each pod
//   section leaves the hull with a fillet, wraps the duct circle and fillets
//   back into the underside of the haunch flare.
// - The tail is raked by a smooth shear applied to everything near the end.
import {NurbsCurve, loft, revolve, type NurbsSurface} from '../nurbs/nurbs';
import type {Model, Part} from '../nurbs/model';
import {add, cross, normalize, scale, sub, type Vec3} from '../math/vec';
import {
  keyed,
  steps,
  orient,
  ruled,
  superBox,
  pipe,
  conform,
  surfaceLine,
  paramWhere,
  roundRect,
} from './parts';

export const SPINNER_DRIVER_EYE: Vec3 = [-0.4, 1.3, -0.05];

// Key stations along the car (final frame).
const zN = -2.7; // nose
const zC0 = -1.35; // A-pillar base / windshield base
const zC1 = 1.5; // rear end of the glass bubble
const zT = 2.38; // tail (before the rake)
const RAKE = Math.tan((17 * Math.PI) / 180);
/** The cabin (interior, seats, eye) was laid out 0.35 m further back. */
const CAB = 0.35;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Ducktail: the top of the tail kicks up slightly. */
const kick = (z: number) => 0.04 * smooth(zT - 0.3, zT, z);

/**
 * Profiles below are keyed in a "design" frame (nose -2.7, A-pillar -1.0,
 * canopy end 1.85, tail 2.6); fwd() maps it to the final frame with the
 * cabin moved forward, a shorter hood and a shorter deck.
 */
const FWD: [number, number][] = [
  [-2.7, -2.7],
  [-1.0, -1.35],
  [1.85, 1.5],
  [2.6, 2.38],
];
function fwd(z: number): number {
  for (let i = 0; i < FWD.length - 1; i++) {
    const [a0, b0] = FWD[i];
    const [a1, b1] = FWD[i + 1];
    if (z <= a1 || i === FWD.length - 2) {
      return b0 + ((z - a0) * (b1 - b0)) / (a1 - a0);
    }
  }
  return z;
}
const K = (keys: [number, number][]) =>
  keyed(keys.map(([z, v]) => [fwd(z), v] as [number, number]));

const keel = K([
  [-2.7, 0.44],
  [-2.3, 0.39],
  [-1.8, 0.37],
  [1.7, 0.37],
  [2.2, 0.44],
  [2.6, 0.56],
]);
const bottomW = K([
  [-2.7, 0.6],
  [-2.2, 0.66],
  [-1.2, 0.74],
  [0.3, 0.76],
  [1.2, 0.7],
  [2.0, 0.66],
  [2.6, 0.64],
]);
const flareW = K([
  [-2.7, 0.8],
  [-2.3, 0.9],
  [-1.4, 0.94],
  [-0.6, 0.96],
  [0.5, 0.98],
  [1.2, 1.05],
  [1.8, 1.16],
  [2.2, 1.18],
  [2.6, 1.13],
]);
/** Beltline / edge line height: a steady wedge from nose to haunch. */
const beltY = K([
  [-2.7, 0.78],
  [-2.0, 0.86],
  [-1.0, 0.95],
  [0.0, 1.0],
  [1.0, 1.07],
  [1.8, 1.14],
  [2.2, 1.1],
  [2.6, 0.99],
]);
/** How far the fender/haunch top rises above the edge line. */
const rise = K([
  [-2.7, 0.03],
  [-1.0, 0.03],
  [0.5, 0.03],
  [1.2, 0.06],
  [1.8, 0.12],
  [2.6, 0.08],
]);
const ledge = K([
  [-2.7, 0.14],
  [-1.6, 0.16],
  [-1.0, 0.13],
  [0.3, 0.12],
  [1.2, 0.17],
  [1.8, 0.3],
  [2.6, 0.28],
]);
const crown = K([
  [-2.7, 0.0],
  [-2.0, 0.03],
  [-1.0, 0.04],
  [1.8, 0.03],
  [2.6, 0.02],
]);
/** Canopy height over the edge line: a long fastback taper to the deck. */
const bubble = K([
  [-1.0, 0],
  [-0.75, 0.2],
  [-0.35, 0.44],
  [0.1, 0.59],
  [0.55, 0.6],
  [1.0, 0.47],
  [1.45, 0.22],
  [1.85, 0],
]);
// Height of the flare's lower lip, as a fraction keel -> shoulder.
const flareEdge = K([
  [-2.7, 0.45],
  [-2.2, 0.5],
  [-1.2, 0.58],
  [0.3, 0.58],
  [1.2, 0.56],
  [2.6, 0.55],
]);

const edgeX = (z: number) => flareW(z) - ledge(z);
const edgeY = (z: number) => beltY(z) + kick(z);
const shoulderY = (z: number) => edgeY(z) + rise(z);
const FLOOR = 0.5;

// Rear thruster pods (fused into the quarter panels).
const POD_X = 0.9;
const POD_Y = 0.68;
const POD_R = 0.26;
const POD_Z0 = fwd(1.3);
const podR = K([
  [1.3, 0],
  [1.75, POD_R * 0.9],
  [2.1, POD_R],
  [2.6, POD_R * 0.98],
]);
/** Exhaust duct radius at the tail. */
const R_HOLE = 0.185;

/** Point on the flare's lower lip (where the lower and upper hull meet). */
function lip(z: number): Vec3 {
  const yk = keel(z);
  return [flareW(z) - 0.035, yk + flareEdge(z) * (shoulderY(z) - yk), z];
}

/** Right half lower hull section (no pod): keel (x = 0) to the flare lip. */
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

/**
 * Right half lower hull points, keel to lip, with the thruster pod grown
 * out of it: between A (belly) and B (flare underside) the plain section
 * blends into a curve that fillets out of the hull, wraps the duct circle
 * and fillets back. Same point count at every z so the loft is smooth.
 */
function lowerPoints(z: number): Vec3[] {
  const ls = lowerSection(z);
  const lx = lip(z)[0];
  const xA = Math.min(POD_X - 1.1 * POD_R, 0.8 * lx);
  const xB = Math.min(POD_X + 0.1, lx - 0.03);
  const tA = paramWhere(ls, p => p[0] - xA);
  const tB = paramWhere(ls, p => p[0] - xB);
  const w = smooth(POD_Z0, POD_Z0 + 0.45, z);
  const pts: Vec3[] = [];
  for (let i = 0; i < 4; i++) pts.push(ls.evaluate((tA * i) / 4));
  const A = ls.evaluate(tA);
  const B = ls.evaluate(tB);
  const r = Math.max(podR(z) * 1.04, 0.01);
  const c = (deg: number): Vec3 => {
    const a = (deg * Math.PI) / 180;
    return [POD_X + r * Math.cos(a), POD_Y + r * Math.sin(a), z];
  };
  const f = 0.13;
  const pod = NurbsCurve.fromPoints([
    A,
    add(A, scale(ls.tangent(tA), f)),
    c(-90),
    c(-45),
    c(0),
    c(30),
    add(B, scale(ls.tangent(tB), f)),
    B,
  ]);
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const h = ls.evaluate(tA + (tB - tA) * t);
    pts.push(w > 0 ? add(h, scale(sub(pod.evaluate(t), h), w)) : h);
  }
  for (let i = 1; i <= 3; i++) pts.push(ls.evaluate(tB + ((1 - tB) * i) / 3));
  return pts;
}

/** Full-width lower hull section: left lip -> keel -> right lip. */
function lowerFull(z: number): NurbsCurve {
  const r = lowerPoints(z);
  const l = r
    .slice(1)
    .reverse()
    .map(([x, y, zz]) => [-x, y, zz] as Vec3);
  return NurbsCurve.interpolate([...l, ...r]);
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

/** Rakes the tail: shears points near the end forward with height. */
function rake([x, y, z]: Vec3): Vec3 {
  const t = smooth(zT - 0.5, zT - 0.02, z);
  const th = TUMBLE * Math.max(0, y - tailStripY());
  return [x, y, z - t * (RAKE * (y - 0.45) + th)];
}
const TUMBLE = Math.tan((8 * Math.PI) / 180);
/** Height of the tail light strip (pre-rake). */
const tailStripY = () => edgeY(zT) - 0.075;

// Materials.
const PAINT: Vec3 = [0.085, 0.105, 0.14]; // deep blue-grey gunmetal
const PAINT2: Vec3 = [0.045, 0.05, 0.06]; // charcoal lower tone
const DARK: Vec3 = [0.03, 0.032, 0.036];
const TRIM: Vec3 = [0.2, 0.21, 0.23];
const FASCIA: Vec3 = [0.06, 0.065, 0.072];
const LEATHER: Vec3 = [0.075, 0.03, 0.022];
const HEAD: Vec3 = [6, 5, 4];
const TAIL: Vec3 = [10, 0.5, 0.2];
const LIFT: Vec3 = [9, 3.2, 0.7];
const AMBER: Vec3 = [8, 3.2, 0.4];
const CYAN: Vec3 = [0.4, 5, 7];

const REV = (u: number, v = 32) => ({segmentsU: u, segmentsV: v});

type Mat = Partial<Part> & Pick<Part, 'material'>;

/** Small rounded box part. */
function box(
  name: string,
  c: Vec3,
  h: Vec3,
  m: Mat,
  opts: {
    e?: number;
    seg?: number;
    mirror?: boolean;
    x?: Vec3;
    y?: Vec3;
    z?: Vec3;
  } = {},
): Part {
  const seg = opts.seg ?? 8;
  return {
    name,
    surface: superBox(c, h, opts.e ?? 0.3, {
      x: opts.x,
      y: opts.y,
      z: opts.z,
      nu: 9,
      nv: 13,
    }),
    mirror: opts.mirror ?? false,
    tessellation: {segmentsU: seg, segmentsV: seg + 4},
    ...m,
  };
}

/** Revolve a (radius, axial) profile around an axis through c. */
function revAxis(
  c: Vec3,
  axis: Vec3,
  radial: Vec3,
  pts: [number, number][],
): NurbsSurface {
  return revolve(
    NurbsCurve.fromPoints(
      pts.map(([r, a]) => add(c, add(scale(radial, r), scale(axis, a)))),
    ),
    c,
    axis,
  );
}

/** Belly lift duct: ring lip, duct wall, louvres and a warm downward glow. */
function liftDuct(z: number, r: number): Part[] {
  const y = keel(z);
  const c: Vec3 = [0, y, z];
  const up: Vec3 = [0, 1, 0];
  const out: Vec3 = [1, 0, 0];
  const parts: Part[] = [
    {
      name: 'lift-ring',
      surface: orient(
        revAxis(c, up, out, [
          [r - 0.03, 0.02],
          [r - 0.035, -0.008],
          [r + 0.01, -0.012],
          [r + 0.045, 0.0],
        ]),
        [0, -1, 0],
        0.5,
        0,
      ),
      material: 'metal',
      color: TRIM,
      tessellation: REV(4, 40),
    },
    {
      name: 'lift-wall',
      surface: orient(
        revAxis(c, up, out, [
          [r - 0.03, 0.02],
          [r - 0.03, 0.05],
        ]),
        [-1, 0, 0],
        0.5,
        0,
      ),
      material: 'metal',
      color: DARK,
      tessellation: REV(1, 40),
    },
    {
      name: 'lift-ring-glow',
      surface: orient(
        revAxis(c, up, out, [
          [r - 0.03, 0.045],
          [r - 0.03, 0.075],
        ]),
        [-1, 0, 0],
        0.5,
        0,
      ),
      material: 'emissive',
      emissive: scale(LIFT, 1.3),
      tessellation: REV(1, 40),
    },
    {
      name: 'lift-wall',
      surface: orient(
        revAxis(c, up, out, [
          [r - 0.03, 0.075],
          [r - 0.03, 0.11],
        ]),
        [-1, 0, 0],
        0.5,
        0,
      ),
      material: 'metal',
      color: DARK,
      tessellation: REV(1, 40),
    },
    {
      name: 'lift-glow',
      surface: orient(
        revAxis(c, up, out, [
          [r - 0.03, 0.11],
          [0.5 * r, 0.115],
          [0, 0.12],
        ]),
        [0, -1, 0],
        0.5,
        0,
      ),
      material: 'emissive',
      emissive: LIFT,
      tessellation: REV(3, 32),
    },
    {
      // Downward lift glow cone (additive; v runs duct -> tip).
      name: 'lift-cone',
      surface: orient(
        revAxis(c, up, out, [
          [r - 0.04, 0.0],
          [r * 1.0, -0.03],
          [r * 1.03, -0.07],
          [r * 1.04, -0.12],
          [r * 1.0, -0.18],
          [r * 0.92, -0.25],
          [r * 0.5, -0.55],
          [0.02, -0.85],
        ]).transposed(),
        [1, 0, 0],
        0,
        0.2,
      ),
      material: 'glow',
      emissive: [5, 1.8, 0.4],
      tessellation: {segmentsU: 28, segmentsV: 10},
    },
    {
      // 3 cm orange ring facing down, just inside the lip.
      name: 'lift-ring-glow',
      surface: orient(
        revAxis(c, up, out, [
          [r - 0.03, 0.03],
          [r - 0.045, 0.03],
          [r - 0.06, 0.03],
        ]),
        [0, -1, 0],
        0.5,
        0,
      ),
      material: 'emissive',
      emissive: scale(LIFT, 1.2),
      tessellation: REV(1, 40),
    },
    {
      name: 'lift-hub',
      surface: superBox([0, y + 0.07, z], [0.07, 0.045, 0.07], 0.6, {
        nu: 7,
        nv: 11,
      }),
      material: 'metal',
      color: DARK,
      tessellation: {segmentsU: 6, segmentsV: 10},
    },
  ];
  for (let i = -3; i <= 3; i++) {
    const zz = z + i * r * 0.27;
    const half = Math.sqrt(Math.max(0, (r - 0.04) ** 2 - (i * r * 0.27) ** 2));
    parts.push(
      box(
        'lift-louvre',
        [0, y + 0.03, zz],
        [half, 0.03, 0.006],
        {material: 'metal', color: DARK},
        {e: 0.25, seg: 4},
      ),
    );
    // Glowing louvre edge.
    parts.push(
      box(
        'lift-louvre-glow',
        [0, y + 0.002, zz],
        [half * 0.95, 0.003, 0.0065],
        {material: 'emissive', emissive: scale(LIFT, 0.8)},
        {e: 0.3, seg: 3},
      ),
    );
  }
  return parts;
}

// The interior is laid out in a cabin frame CAB m behind the final one.
const cEdgeX = (z: number) => edgeX(z - CAB);
const cEdgeY = (z: number) => edgeY(z - CAB);
const cZ0 = zC0 + CAB;
const cZ1 = zC1 + CAB;

function interior(all: Part[]) {
  const parts: Part[] = [];
  // Cockpit tub: sill and door cards, then the floor, hanging off the edge
  // line (two lofts sharing the boundary column).
  const tubZ = steps(cZ0 - 0.06, cZ1 + 0.04, 14);
  const doorCard = loft(
    tubZ.map(z => {
      const ex = cEdgeX(z);
      const ey = cEdgeY(z);
      return NurbsCurve.fromPoints([
        [ex + 0.01, ey - 0.01, z],
        [ex - 0.03, ey - 0.005, z],
        [ex - 0.06, ey - 0.06, z],
        [ex - 0.075, ey - 0.22, z],
        [ex - 0.05, FLOOR + 0.12, z],
        [ex - 0.06, FLOOR + 0.03, z],
      ]);
    }),
  );
  const floor = loft(
    tubZ.map(z => {
      const ex = cEdgeX(z);
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
    tessellation: {segmentsU: 10, segmentsV: 24},
  });
  parts.push({
    name: 'floor',
    surface: orient(floor, [0, 1, 0], 0.6, 0.5),
    material: 'rubber',
    color: [0.025, 0.025, 0.028],
    mirror: true,
    tessellation: {segmentsU: 4, segmentsV: 20},
  });
  // Door armrests.
  parts.push(
    box(
      'armrest',
      [cEdgeX(0.2) - 0.11, 0.84, 0.18],
      [0.36, 0.028, 0.045],
      {material: 'leather', color: LEATHER},
      {x: [0, 0, 1], y: [0, 1, 0], z: [1, 0, 0], seg: 10, mirror: true},
    ),
  );

  // Bulkhead behind the seats and a parcel shelf under the fastback glass.
  const bz = 1.0;
  const shelfY = 0.98;
  parts.push({
    name: 'rear-bulkhead',
    surface: orient(
      loft(
        [
          NurbsCurve.fromPoints([
            [cEdgeX(bz) - 0.08, FLOOR, bz + 0.06],
            [0.36, FLOOR, bz + 0.06],
            [0, FLOOR, bz + 0.06],
          ]),
          NurbsCurve.fromPoints([
            [cEdgeX(bz) - 0.07, shelfY, bz],
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
  // Dashboard: one loft swept across the cabin; its ends wrap back and down
  // into the door cards like a curved cowl.
  const xe = cEdgeX(-0.6) - 0.07;
  const dashSecs = steps(-1, 1, 10).map(s => {
    const x = s * xe;
    const w = Math.pow(Math.abs(s), 3);
    const zs = 0.32 * w;
    const ys = -0.06 * w;
    const yt = 0.85 + ys;
    const zf = -1.02 + zs * 0.4;
    const zl = -0.62 + zs;
    return NurbsCurve.fromPoints([
      [x, yt - 0.34, zf + 0.12],
      [x, yt - 0.3, zl - 0.1],
      [x, yt - 0.12, zl - 0.015],
      [x, yt - 0.02, zl],
      [x, yt + 0.005, zl - 0.04],
      [x, yt, zf + 0.25],
      [x, yt - 0.04, zf],
    ]);
  });
  const dash = loft(dashSecs);
  parts.push({
    name: 'dash',
    surface: orient(dash, [0, 1, 0], 0.75, 0.5),
    material: 'leather',
    color: [0.035, 0.032, 0.032],
    tessellation: {segmentsU: 20, segmentsV: 30},
  });
  // Cowl: the dash top continues up and forward to the hood's rear lip at
  // the windscreen base (without it the firewall showed as a black band
  // between hood and dash from the driver's seat). Cabin frame: z + CAB.
  {
    const top = topSection(zC0).points.map(
      q => [q[0], q[1] - 0.015, q[2] + CAB + 0.005] as Vec3,
    );
    const ex = Math.max(...top.map(q => Math.abs(q[0])));
    const bottom = top.map(
      q => [q[0] * Math.min(1, (xe - 0.02) / ex), 0.845, -1.02 + 0.15] as Vec3,
    );
    parts.push({
      name: 'dash-cowl',
      surface: orient(
        loft([NurbsCurve.fromPoints(bottom), NurbsCurve.fromPoints(top)], 1),
        [0, 1, 0.4],
      ),
      material: 'leather',
      color: [0.035, 0.032, 0.032],
      tessellation: {segmentsU: 20, segmentsV: 2},
    });
  }
  parts.push(
    box(
      'dash-accent',
      [0, 0.72, -0.6],
      [0.6, 0.004, 0.004],
      {material: 'emissive', emissive: [0.3, 1.6, 2.4]},
      {seg: 6},
    ),
  );
  parts.push(
    box(
      'dash-vent',
      [0.5, 0.79, -0.62],
      [0.1, 0.026, 0.008],
      {material: 'metal', color: [0.02, 0.02, 0.022]},
      {seg: 6, mirror: true},
    ),
  );

  // Screens on one arc around the driver's eye, all facing it with the
  // same tilt, carried by a curved housing.
  const eye = add(SPINNER_DRIVER_EYE, [0, 0, CAB]);
  const R = 0.82;
  const sy = 0.875;
  const deg = Math.PI / 180;
  const frame = (th: number) => {
    const c: Vec3 = [eye[0] + R * Math.sin(th), sy, eye[2] - R * Math.cos(th)];
    const n = normalize(sub(eye, c));
    const X = normalize(cross([0, 1, 0], n));
    const Y = cross(n, X);
    return {c, n, X, Y};
  };
  const screens: [string, number, number, number][] = [
    ['gauges', -3, 0.21, 1],
    ['nav', 12, 0.22, 0],
    ['comms', 27, 0.19, 2],
  ];
  const sh = 0.104;
  for (const [name, th, w, id] of screens) {
    const {c, n, X, Y} = frame(th * deg);
    const p = (a: number, b: number): Vec3 =>
      add(c, add(scale(X, a * w), scale(Y, b * sh)));
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
      emissive: [1, 1, 1],
    });
  }
  // Housing: rounded section swept along the arc, closed at both ends.
  const hs: NurbsCurve[] = [];
  const ths = [-16.5, -16, -14.5, ...steps(-11.5, 37.5, 6), 40.5, 42, 42.5];
  ths.forEach((t, i) => {
    const {c, n, Y} = frame(t * deg);
    const endScale =
      i === 0 || i === ths.length - 1
        ? 0.05
        : i === 1 || i === ths.length - 2
          ? 0.75
          : 1;
    const cc = add(sub(c, scale(n, 0.042)), scale(Y, -0.01));
    hs.push(roundRect(cc, n, Y, 0.028 * endScale, (sh / 2 + 0.022) * endScale));
  });
  parts.push({
    name: 'screen-housing',
    surface: orient(loft(hs, 3), [0, 1, 0], 0.0, 0.5),
    material: 'carbon',
    tessellation: {segmentsU: 16, segmentsV: 36},
  });

  // Center console between the seats.
  parts.push({
    name: 'console',
    surface: superBox([0, 0.64, -0.1], [0.5, 0.14, 0.12], 0.3, {
      x: [0, 0, 1],
      y: [0, 1, 0],
      z: [-1, 0, 0],
      nu: 11,
      nv: 13,
    }),
    material: 'carbon',
    tessellation: {segmentsU: 18, segmentsV: 16},
  });
  for (let i = 0; i < 3; i++) {
    parts.push(
      box(
        'console-button',
        [-0.05 + i * 0.05, 0.785, -0.35],
        [0.014, 0.006, 0.014],
        {
          material: 'emissive',
          emissive: i === 1 ? [3, 0.4, 0.2] : [0.4, 2, 2.5],
        },
        {seg: 4},
      ),
    );
  }
  parts.push({
    name: 'throttle',
    surface: pipe(
      [
        [0.0, 0.76, 0.05],
        [0.0, 0.84, 0.0],
        [0.0, 0.88, -0.01],
      ],
      0.012,
    ),
    material: 'chrome',
    tessellation: {segmentsU: 8, segmentsV: 6},
  });
  parts.push(
    box(
      'throttle-knob',
      [0, 0.895, -0.012],
      [0.03, 0.025, 0.03],
      {material: 'rubber'},
      {
        e: 0.5,
        seg: 6,
      },
    ),
  );

  // Flight yoke.
  const yz = -0.24;
  const yy = 0.81;
  parts.push({
    name: 'yoke-column',
    surface: pipe(
      [
        [-0.4, 0.76, -0.62],
        [-0.4, 0.785, -0.45],
        [-0.4, yy, yz - 0.02],
      ],
      0.024,
    ),
    material: 'metal',
    color: DARK,
    tessellation: {segmentsU: 10, segmentsV: 8},
  });
  parts.push({
    name: 'column-shroud',
    surface: superBox([-0.4, 0.765, -0.5], [0.045, 0.035, 0.14], 0.35, {
      nu: 9,
      nv: 13,
      taperY: 0.8,
      taperZ: 0.8,
      x: [0, 0, 1],
      y: [0, 1, 0],
      z: [-1, 0, 0],
    }),
    material: 'plastic',
    color: [0.03, 0.03, 0.033],
    tessellation: {segmentsU: 10, segmentsV: 14},
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
    tessellation: {segmentsU: 8, segmentsV: 36},
  });
  parts.push(
    box('yoke-hub', [-0.4, yy, yz], [0.045, 0.028, 0.025], {
      material: 'metal',
      color: TRIM,
    }),
  );

  // Seats: bucket with side and thigh bolsters and stitched seam creases.
  for (const sx of [-0.4, 0.4]) {
    const hz = 0.52;
    const cush: Vec3 = [sx, FLOOR + 0.14, hz - 0.14];
    parts.push({
      name: 'seat-cushion',
      surface: superBox(cush, [0.17, 0.065, 0.24], 0.3, {nu: 11, nv: 15}),
      material: 'leather',
      color: LEATHER,
      tessellation: {segmentsU: 12, segmentsV: 18},
    });
    for (const side of [-1, 1]) {
      parts.push({
        name: 'seat-thigh-bolster',
        surface: superBox(
          [sx + side * 0.19, FLOOR + 0.16, hz - 0.15],
          [0.045, 0.075, 0.24],
          0.4,
          {nu: 9, nv: 11},
        ),
        material: 'leather',
        color: [0.055, 0.022, 0.016],
        tessellation: {segmentsU: 8, segmentsV: 12},
      });
    }
    const t = 0.3; // recline
    const Y: Vec3 = [0, Math.cos(t), Math.sin(t)];
    const Z: Vec3 = [0, -Math.sin(t), Math.cos(t)];
    const back = add([sx, FLOOR + 0.2, hz + 0.12], scale(Y, 0.32));
    const backS = superBox(back, [0.17, 0.33, 0.065], 0.3, {
      y: Y,
      z: Z,
      nu: 11,
      nv: 15,
    });
    parts.push({
      name: 'seat-back',
      surface: backS,
      material: 'leather',
      color: LEATHER,
      tessellation: {segmentsU: 12, segmentsV: 18},
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
      tessellation: {segmentsU: 12, segmentsV: 16},
    });
    for (const side of [-1, 1]) {
      parts.push({
        name: 'seat-bolster',
        surface: superBox(
          add(
            add([sx + side * 0.19, FLOOR + 0.2, hz + 0.1], scale(Y, 0.26)),
            scale(Z, -0.035),
          ),
          [0.045, 0.26, 0.08],
          0.4,
          {y: Y, z: Z, nu: 9, nv: 11},
        ),
        material: 'leather',
        color: [0.055, 0.022, 0.016],
        tessellation: {segmentsU: 8, segmentsV: 12},
      });
    }
    // Seam creases: two vertical channels on the back, two on the cushion.
    const front = scale(Z, -0.066);
    for (const dx of [-0.07, 0.07]) {
      parts.push({
        name: 'seat-seam',
        surface: pipe(
          [-0.26, 0, 0.26].map(b =>
            add(add(add(back, [dx, 0, 0]), scale(Y, b)), front),
          ),
          0.004,
        ),
        material: 'rubber',
        tessellation: {segmentsU: 4, segmentsV: 4},
      });
      parts.push({
        name: 'seat-seam',
        surface: pipe(
          [-0.2, 0, 0.2].map(b => add(cush, [dx, 0.064, b])),
          0.004,
        ),
        material: 'rubber',
        tessellation: {segmentsU: 4, segmentsV: 4},
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
      tessellation: {segmentsU: 10, segmentsV: 12},
    });
  }
  for (const p of parts) {
    all.push({
      ...p,
      surface: p.surface.transform(([x, y, z]) => [x, y, z - CAB]),
    });
  }
}

/** Recessed exhaust: chamfered lip, deep duct, stators, cone, hot core. */
function exhaust(): Part[] {
  const nc: Vec3 = [POD_X, POD_Y, zT];
  const ax: Vec3 = [0, 0, 1];
  const ex: Vec3 = [1, 0, 0];
  const rh = R_HOLE;
  const depth = 0.3;
  const rev = (pts: [number, number][]) => revAxis(nc, ax, ex, pts);
  const parts: Part[] = [
    {
      // Chamfered lip ring sitting on the tail panel, covering the hole edge.
      name: 'exhaust-lip',
      surface: orient(
        rev([
          [rh + 0.05, 0.0],
          [rh + 0.042, 0.02],
          [rh - 0.025, 0.026],
          [rh - 0.035, 0.0],
          [rh - 0.035, -0.03],
        ]),
        [0, 0, 1],
        0.3,
        0,
      ),
      material: 'metal',
      color: TRIM,
      mirror: true,
      tessellation: REV(6, 32),
    },
    {
      name: 'exhaust-duct',
      surface: orient(
        rev([
          [rh - 0.035, -0.03],
          [rh * 0.8, -depth * 0.5],
          [rh * 0.78, -depth],
        ]),
        [-1, 0, 0],
        0.5,
        0,
      ),
      material: 'metal',
      color: [0.05, 0.05, 0.055],
      roughness: 0.35,
      mirror: true,
      tessellation: REV(4, 32),
    },
    {
      name: 'exhaust-cone',
      surface: orient(
        rev([
          [rh * 0.34, -depth],
          [rh * 0.3, -depth * 0.6],
          [rh * 0.14, -depth * 0.3],
          [0, -depth * 0.22],
        ]),
        [0, 0, 1],
        0.6,
        0,
      ),
      material: 'metal',
      color: [0.16, 0.16, 0.17],
      mirror: true,
      tessellation: REV(8, 32),
    },
  ];
  // Radial emissive gradient on the back wall: hot blue-white core out to a
  // dim rim.
  const rings: [number, number, Vec3][] = [
    [0.0, 0.42, [5, 9, 16]],
    [0.42, 0.62, [2.2, 4.5, 11]],
    [0.62, 0.8, [0.8, 1.8, 5]],
    [0.8, 0.985, [0.15, 0.35, 1.2]],
  ];
  for (const [r0, r1, e] of rings) {
    parts.push({
      name: 'exhaust-glow',
      surface: orient(
        rev([
          [rh * 0.8 * r1, -depth],
          [rh * 0.8 * (r0 + r1) * 0.5, -depth - 0.002],
          [rh * 0.8 * r0, -depth - 0.004],
        ]),
        [0, 0, 1],
        0.5,
        0,
      ),
      material: 'emissive',
      emissive: e,
      mirror: true,
      tessellation: REV(1, 28),
    });
  }
  // Stator vanes.
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.2;
    const R: Vec3 = [Math.cos(a), Math.sin(a), 0];
    const T: Vec3 = [-Math.sin(a), Math.cos(a), 0];
    const rm = (rh * 0.35 + rh * 0.78) / 2;
    parts.push(
      box(
        'exhaust-stator',
        add(nc, [R[0] * rm, R[1] * rm, -depth * 0.55]),
        [(rh * 0.45) / 2, 0.006, 0.05],
        {material: 'metal', color: [0.1, 0.1, 0.11]},
        {x: R, y: T, z: ax, seg: 4, mirror: true},
      ),
    );
  }
  return parts;
}

export function buildSpinner(): Model {
  const parts: Part[] = [];

  // Lift duct positions (holes are cut in the belly for them).
  const ducts: [number, number][] = [
    [-1.85, 0.36],
    [0.25, 0.38],
  ];

  // Main hull: a full-width lower loft (belly, flanks below the crease and
  // the fused thruster pods) and the painted upper flanks. Both share the
  // flare lip column exactly, so the two-tone crease is a clean break.
  const hullZ = [
    ...steps(zN, -2.4, 4),
    ...steps(-2.2, zC0, 4),
    ...steps(-1.0, POD_Z0, 4),
    ...steps(POD_Z0 + 0.15, zT, 8),
  ];
  const hullTessV = 50;
  const upper = loft(hullZ.map(upperSection));
  const lower = orient(loft(hullZ.map(lowerFull)), [0, -1, 0], 0.5, 0.5);
  parts.push({
    name: 'hull-upper',
    surface: upper,
    material: 'paint',
    color: PAINT,
    mirror: true,
    tessellation: {segmentsU: 12, segmentsV: hullTessV},
  });
  const inDuct = (p: Vec3) =>
    ducts.some(([z, r]) => Math.hypot(p[0], p[2] - z) < r - 0.02);
  const ductV = ducts.map(([z, r]) => [
    vAtZ(lower, 0.5, z - r - 0.05),
    vAtZ(lower, 0.5, z + r + 0.05),
  ]);
  parts.push({
    name: 'hull-lower',
    surface: lower,
    material: 'paint',
    color: PAINT2,
    roughness: 0.45,
    tessellation: {
      segmentsU: 52,
      segmentsV: hullTessV,
      keep: (u, v) =>
        !ductV.some(([a, b]) => v > a && v < b) ||
        !inDuct(lower.evaluate(u, v)),
    },
  });
  for (const [z, r] of ducts) parts.push(...liftDuct(z, r));

  // Belly detail: two keel strakes, cross panel lines and access hatches.
  for (const x of [-0.52, 0.52]) {
    parts.push({
      name: 'keel-strake',
      surface: pipe(
        steps(-2.25, zT - 0.6, 10).map(z => [x, keel(z) - 0.004, z] as Vec3),
        0.016,
      ),
      material: 'metal',
      color: TRIM,
      tessellation: {segmentsU: 5, segmentsV: 28},
    });
  }
  const bellyCache = new Map<number, NurbsCurve>();
  const bellyU = (z: number, x: number) => {
    let c = bellyCache.get(z);
    if (!c) bellyCache.set(z, (c = lowerFull(z)));
    return paramWhere(c, p => p[0] - x);
  };
  for (const z of [-2.35, -1.2, -0.55, 0.85, 1.5]) {
    const v = vAtZ(lower, 0.5, z);
    parts.push({
      name: 'belly-line',
      surface: surfaceLine(
        lower,
        steps(bellyU(z, -0.6), bellyU(z, 0.6), 6).map(
          u => [u, v] as [number, number],
        ),
        0.004,
      ),
      material: 'rubber',
      tessellation: {segmentsU: 4, segmentsV: 12},
    });
  }
  for (const [z0, z1, x0, x1] of [
    [-1.05, -0.7, -0.4, -0.12],
    [-1.05, -0.7, 0.12, 0.4],
    [1.0, 1.35, -0.3, 0.3],
  ]) {
    const v0 = vAtZ(lower, 0.5, z0);
    const v1 = vAtZ(lower, 0.5, z1);
    const zm = (z0 + z1) / 2;
    const ua = bellyU(zm, x0);
    const ub = bellyU(zm, x1);
    parts.push({
      name: 'belly-hatch',
      surface: conform(lower, ua, ub, v0, v1, 0.003, {nu: 4, nv: 4}),
      material: 'metal',
      color: [0.012, 0.012, 0.014],
      roughness: 0.6,
      tessellation: {segmentsU: 2, segmentsV: 2},
    });
    // Light edge groove around the hatch and an amber warning stripe.
    const e = 0.004;
    parts.push({
      name: 'hatch-edge',
      surface: surfaceLine(
        lower,
        [
          [ua - e, v0],
          [ub + e, v0],
          [ub + e, v1],
          [ua - e, v1],
          [ua - e, v0 + 0.001],
        ],
        0.006,
        -0.002,
      ),
      material: 'metal',
      color: [0.45, 0.46, 0.48],
      tessellation: {segmentsU: 4, segmentsV: 24},
    });
    parts.push({
      name: 'hatch-stripe',
      surface: conform(
        lower,
        ua + (ub - ua) * 0.15,
        ub - (ub - ua) * 0.15,
        v0 + (v1 - v0) * 0.12,
        v0 + (v1 - v0) * 0.2,
        0.005,
        {nu: 3, nv: 3},
      ),
      material: 'emissive',
      emissive: [3, 1.1, 0.1],
      tessellation: {segmentsU: 2, segmentsV: 1},
    });
    for (const [bx, bz] of [
      [x0 + 0.03, z0 + 0.03],
      [x1 - 0.03, z0 + 0.03],
      [x0 + 0.03, z1 - 0.03],
      [x1 - 0.03, z1 - 0.03],
    ]) {
      parts.push(
        box(
          'hatch-bolt',
          [bx, keel(bz) - 0.006, bz],
          [0.012, 0.005, 0.012],
          {material: 'metal', color: TRIM},
          {e: 0.5, seg: 3},
        ),
      );
    }
  }

  // Pod seam: a dark trim bead turns the pod / flare fold into a seam.
  parts.push({
    name: 'pod-seam',
    surface: pipe(
      steps(POD_Z0 + 0.3, zT - 0.01, 8).map(z => lowerPoints(z)[15]),
      0.012,
    ),
    material: 'metal',
    color: TRIM,
    mirror: true,
    tessellation: {segmentsU: 6, segmentsV: 20},
  });

  // Pod details: red side marker, orange lift strip, exhaust assembly.
  parts.push(
    box(
      'pod-marker',
      [POD_X + podR(zT - 0.35) * 1.04 + 0.002, POD_Y + 0.03, zT - 0.35],
      [0.004, 0.018, 0.08],
      {material: 'emissive', emissive: TAIL},
      {seg: 4, mirror: true},
    ),
  );
  parts.push(
    box(
      'pod-lift',
      [POD_X, POD_Y - POD_R * 1.04 - 0.002, zT - 0.45],
      [0.07, 0.006, 0.28],
      {material: 'emissive', emissive: LIFT},
      {seg: 6, mirror: true},
    ),
  );
  parts.push(...exhaust());
  // Blue-white exhaust plumes (additive glow volumes; v runs from the
  // nozzle to the tip).
  {
    const nc: Vec3 = [POD_X, POD_Y, zT - 0.02];
    parts.push({
      name: 'exhaust-plume',
      surface: orient(
        revAxis(
          nc,
          [0, 0, 1],
          [1, 0, 0],
          [
            [R_HOLE * 0.8, 0],
            [R_HOLE * 0.75, 0.18],
            [R_HOLE * 0.4, 0.38],
            [0.01, 0.5],
          ],
        ).transposed(),
        [1, 0, 0],
        0,
        0.2,
      ),
      material: 'glow',
      emissive: [1.5, 3, 6],
      mirror: true,
      tessellation: {segmentsU: 24, segmentsV: 8},
    });
  }

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
  const canopy = orient(
    loft(canZ.map(z => topSection(z, bubble(z)))),
    [0, 1, 0],
  );
  parts.push({
    name: 'canopy',
    surface: canopy,
    material: 'glass',
    color: [0.85, 0.9, 1.0],
    doubleSided: true,
    tessellation: {segmentsU: 28, segmentsV: 32},
  });
  const deck = orient(
    loft(steps(zC1, zT, 6).map(z => topSection(z))),
    [0, 1, 0],
  );
  parts.push({
    name: 'deck',
    surface: deck,
    material: 'paint',
    color: PAINT,
    tessellation: panelTess,
  });

  // Buttress sails: thick (4.4 cm) painted fins swept along the lower rear
  // corners of the glass and down the deck to the haunches, with a bright
  // highlight edge along their inner top.
  const vS = vAtZ(canopy, 0.0, fwd(0.7));
  const sailW = (t: number) => 0.17 * Math.sin(Math.min(1, t) * Math.PI * 0.5);
  const sailSt: [NurbsSurface, number, number, number][] = [];
  for (const b of steps(0, 1, 8))
    sailSt.push([canopy, vS + (1 - vS) * b, sailW(b), 1]);
  for (const b of steps(0.2, 1, 4))
    sailSt.push([deck, 0.72 * b, 0.17 - 0.09 * b, 1]);
  sailSt.push([deck, 0.75, 0.07, 0.15]);
  for (const side of [0, 1]) {
    const uu = (w: number) => (side === 0 ? w : 1 - w);
    const secs: NurbsCurve[] = [];
    const edge: Vec3[] = [];
    sailSt.forEach(([S, v, w0, k], i) => {
      const w = Math.max(w0, 0.012);
      const E = S.evaluate(uu(0.004), v);
      const I = S.evaluate(uu(w), v);
      const n = S.normal(uu(w / 2), v);
      const X = normalize(sub(I, E));
      const hx = (Math.hypot(...sub(I, E)) / 2) * (i === 0 ? 0.3 : 1);
      const hy = 0.022 * (i === 0 ? 0.2 : k);
      const C = add(scale(add(E, I), 0.5), scale(n, hy + 0.002));
      secs.push(roundRect(C, X, n, Math.max(hx * k, 0.004), hy));
      if (i > 1 && i < sailSt.length - 1) {
        edge.push(add(add(C, scale(X, hx * 0.92)), scale(n, hy * 0.9)));
      }
    });
    parts.push({
      name: 'sail',
      surface: orient(loft(secs), [0, 1, 0], 0, 0.5),
      material: 'paint',
      color: PAINT,
      tessellation: {segmentsU: 12, segmentsV: 22},
    });
    parts.push({
      name: 'sail-edge',
      surface: pipe(edge, 0.005),
      material: 'chrome',
      tessellation: {segmentsU: 5, segmentsV: 24},
    });
  }

  // Deck lid louvres.
  parts.push({
    name: 'deck-vent',
    surface: conform(deck, 0.34, 0.66, 0.3, 0.75, 0.003, {
      nu: 6,
      nv: 25,
      bump: (_a, b) => 0.008 * Math.abs(Math.sin(b * Math.PI * 6)),
    }),
    material: 'metal',
    color: DARK,
    tessellation: {segmentsU: 4, segmentsV: 48},
  });

  // Body-colour tonneau under the fastback glass, from the seat bulkhead to
  // the deck lid, with a raised centre spine.
  {
    const z0 = fwd(1.0);
    const y0 = 0.98;
    const ts = steps(0, 1, 6);
    const end = topSection(zC1);
    const secs = ts.map(t => {
      const z = z0 + (zC1 - z0) * t;
      const ex = edgeX(z) - 0.07 * (1 - t);
      const spine = 0.05 * (1 - t * t);
      return NurbsCurve.fromPoints(
        TOP_XF.map((xf, i) => {
          const e = end.points[i];
          const yStart =
            y0 + (i === 4 ? spine : i === 3 || i === 5 ? spine * 0.3 : 0);
          const y = yStart + (e[1] - y0) * t + (i === 4 ? spine * t : 0);
          return [xf * ex, i === 4 ? y : yStart + (e[1] - y0) * t, z] as Vec3;
        }),
      );
    });
    parts.push({
      name: 'tonneau',
      surface: orient(loft(secs), [0, 1, 0]),
      material: 'paint',
      color: PAINT,
      tessellation: {segmentsU: 16, segmentsV: 14},
    });
  }

  // Glass rim: a dark seal all round the base of the bubble, plus a thin
  // bright edge just inside it (reads as the glass thickness).
  const railZ = steps(zC0 + 0.01, zC1 - 0.01, 10);
  for (const [off, r, mat] of [
    [0.004, 0.013, {material: 'rubber'}],
    [0.03, 0.005, {material: 'chrome'}],
  ] as const) {
    parts.push({
      name: 'canopy-seal',
      surface: pipe(
        railZ.map(
          z =>
            [edgeX(z) + 0.004 - off, edgeY(z) + 0.004 + off * 0.5, z] as Vec3,
        ),
        r,
      ),
      mirror: true,
      tessellation: {segmentsU: 6, segmentsV: 40},
      ...(mat as Mat),
    });
  }
  parts.push({
    name: 'canopy-seal',
    surface: pipe(
      offsetSection(topSection(zC0), 0.004, 14, [0, 0.6, zC0], 0.02, 0.98),
      0.013,
      {up: [0, 0, 1]},
    ),
    material: 'rubber',
    tessellation: {segmentsU: 6, segmentsV: 30},
  });

  // Firewall closing the cabin under the cowl. Its top follows the hood's
  // crowned section (a straight top left a see-through slit under the
  // hood's arch, visible from the cockpit between hood and dash).
  const fz = zC0 - 0.02;
  const fwTop = topSection(fz).points.map(
    p => [p[0], p[1] - 0.012, p[2]] as Vec3,
  );
  parts.push({
    name: 'firewall',
    surface: orient(
      loft(
        [
          NurbsCurve.fromPoints(fwTop.map(p => [p[0], FLOOR, p[2]] as Vec3)),
          NurbsCurve.fromPoints(fwTop),
        ],
        1,
      ),
      [0, 0, 1],
    ),
    material: 'plastic',
    color: [0.02, 0.02, 0.022],
    tessellation: {segmentsU: 1, segmentsV: 1},
  });

  // Slim 2.5 cm roll hoop inside the glass behind the seats; a low smoked
  // light bar on the roof above it.
  const hoopZ = fwd(0.85);
  const hoopC = topSection(hoopZ, bubble(hoopZ));
  parts.push({
    name: 'roll-hoop',
    surface: pipe(
      offsetSection(hoopC, -0.025, 16, [0, 1.0, hoopZ], 0.04, 0.96),
      0.0125,
      {up: [0, 0, 1]},
    ),
    material: 'metal',
    color: TRIM,
    tessellation: {segmentsU: 6, segmentsV: 40},
  });
  // Beacon: a 0.30 x 0.06 m smoked lens set flush into the top of the hoop
  // under the glass, with the amber / cyan emitters inside it.
  const topY = hoopC.evaluate(0.5)[1];
  const by = topY - 0.035;
  for (const [x, col] of [
    [0.07, AMBER],
    [-0.07, CYAN],
  ] as const) {
    parts.push(
      box(
        'beacon',
        [x, by, hoopZ],
        [0.06, 0.016, 0.018],
        {material: 'emissive', emissive: scale(col, 0.9)},
        {seg: 6},
      ),
    );
  }
  parts.push(
    box(
      'beacon-lens',
      [0, by, hoopZ],
      [0.15, 0.03, 0.032],
      {material: 'tinted-glass', doubleSided: true},
      {e: 0.2, seg: 12},
    ),
  );
  parts.push(
    box(
      'beacon-housing',
      [0, by - 0.032, hoopZ],
      [0.16, 0.008, 0.036],
      {material: 'metal', color: TRIM},
      {e: 0.2, seg: 10, y: [0, 1, 0], z: [0, 0, 1]},
    ),
  );

  // Hood: a smooth power dome blended into the panel, two small vents.
  parts.push({
    name: 'hood-dome',
    surface: conform(hood, 0.3, 0.7, 0.3, 0.95, 0.0008, {
      nu: 9,
      nv: 11,
      bump: (a, b) =>
        0.04 *
        Math.pow(Math.sin(Math.PI * a), 2) *
        Math.pow(Math.sin(Math.PI * Math.min(1, b * 1.3)), 2),
    }),
    material: 'paint',
    color: PAINT,
    tessellation: {segmentsU: 16, segmentsV: 18},
  });
  for (const [u0, u1] of [
    [0.13, 0.24],
    [0.76, 0.87],
  ]) {
    parts.push({
      name: 'hood-vent',
      surface: conform(hood, u0, u1, 0.55, 0.85, 0.003, {
        nu: 5,
        nv: 19,
        bump: (_a, b) => 0.007 * Math.abs(Math.sin(b * Math.PI * 5)),
      }),
      material: 'metal',
      color: DARK,
      tessellation: {segmentsU: 4, segmentsV: 36},
    });
  }

  // Haunch intakes ahead of the thrusters.
  const hv0 = vAtZ(upper, 0.5, fwd(1.3));
  const hv1 = vAtZ(upper, 0.5, fwd(1.75));
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
    tessellation: {segmentsU: 28, segmentsV: 6},
  });

  // Panel-line grooves: hood shut lines, door cuts, deck lid. (The two-tone
  // crease itself is the shared lip edge of the hull lofts.)
  const groove = (
    s: NurbsSurface,
    uv: [number, number][],
    mirror = false,
    seg = 24,
  ): void => {
    parts.push({
      name: 'panel-line',
      surface: surfaceLine(s, uv),
      material: 'rubber',
      mirror,
      tessellation: {segmentsU: 4, segmentsV: seg},
    });
  };
  const line = (
    a: number,
    b: number,
    n: number,
    f: (t: number) => [number, number],
  ) => steps(a, b, n).map(f);
  groove(
    hood,
    line(0.03, 0.97, 6, v => [0.07, v]),
  );
  groove(
    hood,
    line(0.03, 0.97, 6, v => [0.93, v]),
  );
  groove(
    hood,
    line(0.07, 0.93, 6, u => [u, 0.03]),
  );
  groove(
    deck,
    line(0.2, 0.8, 6, u => [u, 0.15]),
  );
  groove(
    deck,
    line(0.2, 0.8, 6, u => [u, 0.88]),
  );
  groove(
    deck,
    line(0.15, 0.88, 4, v => [0.2, v]),
  );
  groove(
    deck,
    line(0.15, 0.88, 4, v => [0.8, v]),
  );
  for (const z of [zC0 + 0.05, fwd(1.2)]) {
    const v = vAtZ(upper, 0.5, z);
    groove(
      upper,
      line(0.04, 0.85, 5, u => [u, v]),
      true,
      10,
    );
  }

  // Nose fascia and tail panel: planar caps ruled horizontally from the
  // half outline to the center plane (no pole, so shading stays flat).
  const capFrom = (pts: Vec3[], dir: number): NurbsSurface => {
    const outline = NurbsCurve.interpolate(pts);
    return orient(
      ruled(
        outline.transform(([, y, zz]) => [0, y, zz]),
        outline,
      ),
      [0, 0, dir],
      0.5,
      0.5,
    );
  };
  {
    const pts: Vec3[] = [...lowerPoints(zN)];
    const us = upperSection(zN);
    for (let i = 1; i <= 10; i++) pts.push(us.evaluate(i / 10));
    const ts = topSection(zN);
    for (let i = 1; i <= 8; i++) pts.push(ts.evaluate(0.5 * (i / 8)));
    parts.push({
      name: 'nose-fascia',
      surface: capFrom(pts, -1),
      material: 'plastic',
      color: FASCIA,
      roughness: 0.5,
      mirror: true,
      tessellation: {segmentsU: 48, segmentsV: 1},
    });
  }
  // Tail: painted above the light strip, black below it, the lower part with
  // the exhaust holes cut out (hidden under the lip rings).
  const ys = tailStripY();
  const usT = upperSection(zT);
  const tS = paramWhere(usT, p => p[1] - ys);
  {
    const lowPts: Vec3[] = [...lowerPoints(zT)];
    for (let i = 1; i <= 4; i++) lowPts.push(usT.evaluate((tS * i) / 4));
    const upPts: Vec3[] = [];
    for (let i = 0; i <= 6; i++)
      upPts.push(usT.evaluate(tS + ((1 - tS) * i) / 6));
    const ts = topSection(zT);
    for (let i = 1; i <= 8; i++) upPts.push(ts.evaluate(0.5 * (i / 8)));
    parts.push({
      name: 'tail-upper',
      surface: capFrom(upPts, 1),
      material: 'paint',
      color: PAINT,
      mirror: true,
      tessellation: {segmentsU: 24, segmentsV: 1},
    });
    const low = capFrom(lowPts, 1);
    // Both halves explicitly (trim functions see their own surface).
    for (const half of [low, low.mirrorX()]) {
      parts.push({
        name: 'tail-lower',
        surface: half,
        material: 'plastic',
        color: FASCIA,
        roughness: 0.5,
        tessellation: {
          segmentsU: 36,
          segmentsV: 18,
          keep: (u, v) => {
            // Ruled horizontally: y depends on u only.
            const p = half.evaluate(u, 1);
            if (Math.abs(p[1] - POD_Y) > R_HOLE + 0.02) return true;
            const q = half.evaluate(u, v);
            return Math.hypot(Math.abs(q[0]) - POD_X, q[1] - POD_Y) > R_HOLE;
          },
        },
      });
    }
  }
  // The light strip wraps 0.25 m around each rear quarter.
  const vWrap = vAtZ(upper, tS, zT - 0.25);
  parts.push({
    name: 'tail-wrap-bezel',
    surface: conform(upper, tS - 0.07, tS + 0.07, vWrap - 0.01, 1, 0.003, {
      nu: 4,
      nv: 5,
    }),
    material: 'metal',
    color: DARK,
    mirror: true,
    tessellation: {segmentsU: 3, segmentsV: 8},
  });
  parts.push({
    name: 'tail-wrap',
    surface: conform(upper, tS - 0.035, tS + 0.035, vWrap, 1, 0.006, {
      nu: 4,
      nv: 5,
    }),
    material: 'emissive',
    color: [1, 0.05, 0.02],
    emissive: TAIL,
    mirror: true,
    tessellation: {segmentsU: 2, segmentsV: 8},
  });
  // Bridge around the tail corner joining the strip and the wrap.
  {
    const P = upper.evaluate(tS, 1);
    const n = upper.normal(tS, 1);
    const Q = upper.evaluate(tS, vAtZ(upper, tS, zT - 0.06));
    const nq = upper.normal(tS, vAtZ(upper, tS, zT - 0.06));
    const bridge = [
      [P[0] - 0.16, ys, zT + 0.012],
      [P[0] - 0.06, ys, zT + 0.012],
      add(add(P, scale(n, 0.008)), [0, 0, 0.008]),
      add(Q, scale(nq, 0.008)),
    ] as Vec3[];
    parts.push({
      name: 'tail-wrap-bridge',
      surface: pipe(bridge, 0.016),
      material: 'emissive',
      color: [1, 0.05, 0.02],
      emissive: TAIL,
      mirror: true,
      tessellation: {segmentsU: 6, segmentsV: 10},
    });
  }

  // Diffuser: four fins under the tail between the exhausts, rising with
  // the belly and continuing up the black lower tail face as ribs.
  for (const x of [0.15, 0.42]) {
    const zs = steps(zT - 0.55, zT + 0.01, 4);
    parts.push({
      name: 'diffuser-fin',
      surface: orient(
        loft(
          [
            NurbsCurve.fromPoints(zs.map(z => [x, keel(z) + 0.01, z] as Vec3)),
            NurbsCurve.fromPoints(
              zs.map(
                z =>
                  [
                    x,
                    keel(z) - 0.12 * smooth(zT - 0.55, zT - 0.15, z),
                    z,
                  ] as Vec3,
              ),
            ),
          ],
          1,
        ),
        [1, 0, 0],
      ),
      material: 'metal',
      color: TRIM,
      mirror: true,
      doubleSided: true,
      tessellation: {segmentsU: 8, segmentsV: 2},
    });
    const y0 = keel(zT) - 0.12;
    const y1 = ys - 0.09;
    parts.push(
      box(
        'diffuser-rib',
        [x, (y0 + y1) / 2, zT + 0.012],
        [0.012, (y1 - y0) / 2, 0.022],
        {material: 'metal', color: TRIM},
        {e: 0.3, seg: 4, mirror: true},
      ),
    );
  }

  // Nose: slim full-width light bar, slim grille, chin blade tied to the
  // body with two strakes, headlamps wrapping into the fenders.
  parts.push(
    box(
      'light-bar',
      [0, 0.745, zN - 0.012],
      [0.64, 0.012, 0.014],
      {material: 'emissive', emissive: HEAD},
      {e: 0.2, seg: 10},
    ),
  );
  parts.push(
    box(
      'grille',
      [0, 0.62, zN - 0.006],
      [0.4, 0.05, 0.01],
      {material: 'metal', color: [0.015, 0.015, 0.017]},
      {e: 0.2, seg: 10},
    ),
  );
  for (let i = 0; i < 3; i++) {
    parts.push(
      box(
        'grille-slat',
        [0, 0.59 + i * 0.03, zN - 0.016],
        [0.38, 0.004, 0.006],
        {material: 'metal', color: TRIM},
        {seg: 4},
      ),
    );
  }
  parts.push(
    box(
      'bumper',
      [0, 0.47, zN - 0.04],
      [0.68, 0.03, 0.08],
      {material: 'metal', color: TRIM},
      {e: 0.3, seg: 16},
    ),
  );
  parts.push(
    box(
      'chin-strake',
      [0.3, 0.505, zN + 0.0],
      [0.025, 0.05, 0.1],
      {material: 'metal', color: TRIM},
      {e: 0.3, seg: 6, mirror: true},
    ),
  );
  // Headlamp clusters: a dark recessed bezel on the corner of the fascia,
  // and a lamp strip wrapping around onto the fender side.
  const nl = lip(zN);
  const nu = upperSection(zN).evaluate(0.65);
  const lampY = (nl[1] + nu[1]) / 2;
  parts.push(
    box(
      'headlamp-bezel',
      [nu[0] - 0.13, lampY, zN - 0.004],
      [0.13, 0.05, 0.01],
      {material: 'plastic', color: [0.012, 0.012, 0.014]},
      {e: 0.2, seg: 10, mirror: true},
    ),
  );
  for (const dx of [-0.2, -0.09]) {
    parts.push(
      box(
        'headlamp',
        [nu[0] + dx + 0.02, lampY, zN - 0.012],
        [0.045, 0.028, 0.006],
        {material: 'emissive', emissive: HEAD},
        {seg: 6, mirror: true},
      ),
    );
  }
  const uL0 = paramWhere(upperSection(zN), p => p[1] - (lampY - 0.03));
  const uL1 = paramWhere(upperSection(zN), p => p[1] - (lampY + 0.03));
  const vW = vAtZ(upper, 0.5, zN + 0.3);
  parts.push({
    name: 'lamp-wrap-bezel',
    surface: conform(upper, uL0 - 0.04, uL1 + 0.04, 0, vW + 0.02, 0.003, {
      nu: 4,
      nv: 5,
    }),
    material: 'plastic',
    color: [0.012, 0.012, 0.014],
    mirror: true,
    tessellation: {segmentsU: 3, segmentsV: 6},
  });
  parts.push({
    name: 'lamp-wrap',
    surface: conform(upper, uL0, uL1, 0, vW * 0.55, 0.006, {nu: 4, nv: 4}),
    material: 'emissive',
    emissive: HEAD,
    mirror: true,
    tessellation: {segmentsU: 2, segmentsV: 4},
  });
  parts.push({
    name: 'side-marker',
    surface: conform(upper, uL0, uL1, vW * 0.62, vW, 0.006, {nu: 4, nv: 4}),
    material: 'emissive',
    emissive: AMBER,
    mirror: true,
    tessellation: {segmentsU: 2, segmentsV: 4},
  });

  // Tail: full-width saturated red strip and an upkicked lip.
  const tailTop = edgeY(zT);
  parts.push(
    box(
      'tail-light',
      [0, ys, zT + 0.008],
      [flareW(zT) - 0.06, 0.02, 0.012],
      {material: 'emissive', color: [1, 0.05, 0.02], emissive: TAIL},
      {e: 0.2, seg: 10},
    ),
  );
  parts.push(
    box(
      'tail-light-bezel',
      [0, ys, zT + 0.002],
      [flareW(zT) - 0.04, 0.032, 0.01],
      {material: 'metal', color: DARK},
      {e: 0.2, seg: 10},
    ),
  );
  parts.push(
    box(
      'tail-lip',
      [0, tailTop + 0.014, zT - 0.02],
      [0.84, 0.008, 0.055],
      {material: 'paint', color: PAINT},
      {
        e: 0.3,
        seg: 10,
        x: [1, 0, 0],
        y: normalize([0, 1, 0.5]),
        z: normalize([0, -0.5, 1]),
      },
    ),
  );

  // Rear deck antenna.
  const az = zT - 0.3;
  parts.push(
    box(
      'antenna-base',
      [-0.62, edgeY(az) + 0.03, az],
      [0.03, 0.03, 0.03],
      {material: 'metal', color: TRIM},
      {e: 0.4, seg: 6},
    ),
  );
  parts.push({
    name: 'antenna',
    surface: pipe(
      [
        [-0.62, edgeY(az) + 0.05, az],
        [-0.62, edgeY(az) + 0.3, az + 0.07],
        [-0.62, edgeY(az) + 0.52, az + 0.17],
      ],
      0.005,
    ),
    material: 'metal',
    color: DARK,
    tessellation: {segmentsU: 4, segmentsV: 6},
  });

  interior(parts);

  // Rake the tail back (a shear that only affects the last half meter).
  for (const p of parts) p.surface = p.surface.transform(rake);
  return {name: 'spinner', parts};
}
