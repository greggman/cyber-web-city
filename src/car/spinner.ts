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
  conformMap,
  surfaceLine,
  paramWhere,
  roundRect,
} from './parts';

export const SPINNER_DRIVER_EYE: Vec3 = [-0.4, 1.32, 0.3];

// Key stations along the car.
const zN = -2.7; // nose
const zC0 = -1.0; // A-pillar base / windshield base
const zC1 = 1.85; // rear end of the glass bubble
const zT = 2.6; // tail (before the rake)
const RAKE = Math.tan((15 * Math.PI) / 180);

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Ducktail: the top of the tail kicks up slightly. */
const kick = (z: number) => 0.035 * smooth(zT - 0.35, zT, z);

const keel = keyed([
  [-2.7, 0.44],
  [-2.3, 0.39],
  [-1.8, 0.37],
  [1.6, 0.37],
  [2.2, 0.41],
  [2.6, 0.46],
]);
const bottomW = keyed([
  [-2.7, 0.6],
  [-2.2, 0.66],
  [-1.2, 0.74],
  [0.3, 0.76],
  [1.2, 0.7],
  [2.0, 0.66],
  [2.6, 0.64],
]);
const flareW = keyed([
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
const beltY = keyed([
  [-2.7, 0.78],
  [-2.0, 0.86],
  [-1.0, 0.95],
  [0.0, 1.0],
  [1.0, 1.07],
  [1.8, 1.15],
  [2.6, 1.14],
]);
/** How far the fender/haunch top rises above the edge line. */
const rise = keyed([
  [-2.7, 0.03],
  [-1.0, 0.03],
  [0.5, 0.03],
  [1.2, 0.06],
  [1.8, 0.12],
  [2.6, 0.1],
]);
const ledge = keyed([
  [-2.7, 0.14],
  [-1.6, 0.16],
  [-1.0, 0.13],
  [0.3, 0.12],
  [1.2, 0.17],
  [1.8, 0.3],
  [2.6, 0.28],
]);
const crown = keyed([
  [-2.7, 0.0],
  [-2.0, 0.03],
  [-1.0, 0.04],
  [1.8, 0.03],
  [2.6, 0.02],
]);
const bubble = keyed([
  [zC0, 0],
  [-0.75, 0.2],
  [-0.35, 0.44],
  [0.1, 0.59],
  [0.55, 0.6],
  [1.0, 0.5],
  [1.45, 0.28],
  [zC1, 0],
]);
// Height of the flare's lower lip, as a fraction keel -> shoulder.
const flareEdge = keyed([
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
const POD_Y = 0.66;
const POD_R = 0.26;
const POD_Z0 = 1.3;
const podR = keyed([
  [POD_Z0, 0],
  [1.75, POD_R * 0.9],
  [2.1, POD_R],
  [zT, POD_R * 0.97],
]);

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

interface PodSection {
  curve: NurbsCurve;
  tA: number;
  tB: number;
}

/**
 * Pod section at z: leaves the lower hull at A (on the belly) with a
 * fillet, wraps the duct circle and fillets into the flare underside at B.
 */
function podSection(z: number): PodSection {
  const ls = lowerSection(z);
  const tA = paramWhere(ls, p => p[0] - (POD_X - 1.1 * POD_R));
  const tB = paramWhere(ls, p => p[0] - (POD_X + 0.1));
  const A = ls.evaluate(tA);
  const B = ls.evaluate(tB);
  const tanA = ls.tangent(tA);
  const tanB = ls.tangent(tB);
  const r = podR(z) * 1.04;
  const c = (deg: number): Vec3 => {
    const a = (deg * Math.PI) / 180;
    return [POD_X + r * Math.cos(a), POD_Y + r * Math.sin(a), z];
  };
  const f = 0.13;
  const curve = NurbsCurve.fromPoints([
    A,
    add(A, scale(tanA, f)),
    c(-90),
    c(-45),
    c(0),
    c(30),
    add(B, scale(tanB, f)),
    B,
  ]);
  return {curve, tA, tB};
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
  const k = RAKE * smooth(zT - 0.5, zT - 0.02, z);
  return [x, y, z - k * (y - 0.45)];
}

// Materials.
const PAINT: Vec3 = [0.085, 0.105, 0.14]; // deep blue-grey gunmetal
const PAINT2: Vec3 = [0.045, 0.05, 0.06]; // charcoal lower tone
const DARK: Vec3 = [0.03, 0.032, 0.036];
const TRIM: Vec3 = [0.2, 0.21, 0.23];
const FASCIA: Vec3 = [0.06, 0.065, 0.072];
const LEATHER: Vec3 = [0.075, 0.03, 0.022];
const HEAD: Vec3 = [6, 5, 4];
const TAIL: Vec3 = [8, 0.4, 0.15];
const THRUST_BLUE: Vec3 = [0.5, 1.3, 3.2];
const THRUST_HOT: Vec3 = [4.5, 1.5, 0.35];
const LIFT: Vec3 = [6, 2.2, 0.5];
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
  }
  return parts;
}

function interior(parts: Part[]) {
  // Cockpit tub: sill and door cards, then the floor, hanging off the edge
  // line (two lofts sharing the boundary column).
  const tubZ = steps(zC0 - 0.06, zC1 + 0.04, 14);
  const doorCard = loft(
    tubZ.map(z => {
      const ex = edgeX(z);
      const ey = edgeY(z);
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
      [edgeX(0.2) - 0.11, 0.84, 0.18],
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
  parts.push(
    box(
      'shelf-light',
      [0, shelfY + 0.004, bz + 0.03],
      [0.6, 0.006, 0.012],
      {material: 'emissive', emissive: [0.3, 2.5, 3]},
      {seg: 6},
    ),
  );

  // Dashboard: one loft swept across the cabin; its ends wrap back and down
  // into the door cards like a curved cowl.
  const xe = edgeX(-0.6) - 0.07;
  const dashSecs = steps(-1, 1, 10).map(s => {
    const x = s * xe;
    const w = Math.pow(Math.abs(s), 3);
    const zs = 0.32 * w;
    const ys = -0.06 * w;
    const yt = 0.9 + ys;
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
  parts.push(
    box(
      'dash-accent',
      [0, 0.77, -0.6],
      [0.6, 0.004, 0.004],
      {material: 'emissive', emissive: [0.3, 1.6, 2.4]},
      {seg: 6},
    ),
  );
  parts.push(
    box(
      'dash-vent',
      [0.5, 0.84, -0.62],
      [0.1, 0.026, 0.008],
      {material: 'metal', color: [0.02, 0.02, 0.022]},
      {seg: 6, mirror: true},
    ),
  );

  // Screens on one arc around the driver's eye, all facing it with the
  // same tilt, carried by a curved housing.
  const eye = SPINNER_DRIVER_EYE;
  const R = 0.82;
  const sy = 0.93;
  const deg = Math.PI / 180;
  const frame = (th: number) => {
    const c: Vec3 = [eye[0] + R * Math.sin(th), sy, eye[2] - R * Math.cos(th)];
    const n = normalize(sub(eye, c));
    const X = normalize(cross([0, 1, 0], n));
    const Y = cross(n, X);
    return {c, n, X, Y};
  };
  const screens: [string, number, number, number][] = [
    ['gauges', -4, 0.26, 1],
    ['nav', 15, 0.28, 0],
    ['comms', 34, 0.24, 2],
  ];
  const sh = 0.13;
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
  const ths = [-21, -20.5, -19, ...steps(-15, 47, 6), 49, 50.5, 51];
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
  const yy = 0.86;
  parts.push({
    name: 'yoke-column',
    surface: pipe(
      [
        [-0.4, 0.8, -0.62],
        [-0.4, 0.83, -0.45],
        [-0.4, yy, yz - 0.02],
      ],
      0.024,
    ),
    material: 'metal',
    color: DARK,
    tessellation: {segmentsU: 10, segmentsV: 8},
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
}

export function buildSpinner(): Model {
  const parts: Part[] = [];

  // Lift duct positions (holes are cut in the belly for them).
  const ducts: [number, number][] = [
    [-1.75, 0.3],
    [0.55, 0.32],
  ];

  // Main hull: charcoal lower tub and painted upper flanks, two lofts that
  // share the flare lip line (a crisp crease, no gap).
  const hullZ = [
    ...steps(zN, -2.4, 4),
    ...steps(-2.2, zC0, 4),
    ...steps(-0.6, 1.2, 4),
    ...steps(1.45, zT, 7),
  ];
  const hullTessV = 50;
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
  // Belly holes for the lift ducts (tested on both mirror halves).
  const ductV = ducts.map(([z, r]) => [
    vAtZ(lower, 0.2, z - r - 0.05),
    vAtZ(lower, 0.2, z + r + 0.05),
  ]);
  const inDuct = (p: Vec3) =>
    ducts.some(([z, r]) => Math.hypot(p[0], p[2] - z) < r - 0.025);
  parts.push({
    name: 'hull-lower',
    surface: lower,
    material: 'paint',
    color: PAINT2,
    roughness: 0.45,
    mirror: true,
    tessellation: {
      segmentsU: 20,
      segmentsV: hullTessV,
      keep: (u, v) => {
        if (!ductV.some(([a, b]) => v > a && v < b)) return true;
        return !(
          inDuct(lower.evaluate(u, v)) || inDuct(lower.evaluate(1 - u, v))
        );
      },
    },
  });
  for (const [z, r] of ducts) parts.push(...liftDuct(z, r));

  // Rear thruster pods lofted out of the quarter panels.
  const podZ = steps(POD_Z0, zT, 9);
  const podSecs = podZ.map(podSection);
  const pod = orient(loft(podSecs.map(p => p.curve)), [1, 0, 0], 0.55, 0.8);
  parts.push({
    name: 'thruster-pod',
    surface: pod,
    material: 'paint',
    color: PAINT2,
    roughness: 0.45,
    mirror: true,
    tessellation: {segmentsU: 22, segmentsV: 20},
  });
  // Red side marker and a groove outlining the pod.
  parts.push({
    name: 'pod-marker',
    surface: conform(pod, 0.5, 0.58, 0.82, 0.93, 0.004, {nu: 4, nv: 4}),
    material: 'emissive',
    emissive: TAIL,
    mirror: true,
    tessellation: {segmentsU: 3, segmentsV: 4},
  });
  // Exhaust nozzle at the tail: dark ring, blue outer glow, hot core.
  const nc: Vec3 = [POD_X, POD_Y, zT];
  const back: Vec3 = [0, 0, 1];
  const rr = POD_R * 0.97;
  parts.push({
    name: 'nozzle',
    surface: orient(
      revAxis(
        nc,
        back,
        [1, 0, 0],
        [
          [rr * 1.0, -0.02],
          [rr * 0.99, 0.05],
          [rr * 0.84, 0.06],
          [rr * 0.78, 0.01],
        ],
      ),
      [0, 0, 1],
      0.4,
      0,
    ),
    material: 'metal',
    color: [0.12, 0.12, 0.13],
    mirror: true,
    tessellation: REV(6, 36),
  });
  parts.push({
    name: 'nozzle-glow',
    surface: orient(
      revAxis(
        nc,
        back,
        [1, 0, 0],
        [
          [rr * 0.79, 0.01],
          [rr * 0.55, 0.004],
          [rr * 0.32, 0.002],
        ],
      ),
      [0, 0, 1],
      0.5,
      0,
    ),
    material: 'emissive',
    emissive: THRUST_BLUE,
    mirror: true,
    tessellation: REV(4, 32),
  });
  parts.push({
    name: 'nozzle-core',
    surface: orient(
      revAxis(
        nc,
        back,
        [1, 0, 0],
        [
          [rr * 0.33, 0.002],
          [rr * 0.2, 0.012],
          [0, 0.03],
        ],
      ),
      [0, 0, 1],
      0.5,
      0,
    ),
    material: 'emissive',
    emissive: THRUST_HOT,
    mirror: true,
    tessellation: REV(3, 24),
  });
  parts.push(
    box(
      'pod-lift',
      [POD_X, POD_Y - POD_R * 1.0 + 0.01, 2.1],
      [0.07, 0.008, 0.3],
      {material: 'emissive', emissive: LIFT},
      {seg: 6, mirror: true},
    ),
  );

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
    tessellation: {segmentsU: 32, segmentsV: 36},
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

  // Glass rim: a dark seal all round the base of the bubble, plus a thin
  // bright edge just inside it (reads as the glass thickness).
  const railZ = steps(zC0 + 0.01, zC1 - 0.01, 18);
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
  for (const z of [zC0, zC1]) {
    parts.push({
      name: 'canopy-seal',
      surface: pipe(
        offsetSection(topSection(z), 0.004, 14, [0, 0.6, z], 0.02, 0.98),
        0.013,
        {
          up: [0, 0, 1],
        },
      ),
      material: 'rubber',
      tessellation: {segmentsU: 6, segmentsV: 30},
    });
  }

  // One slim roll hoop inside the glass behind the seats; a low smoked
  // light bar sits on the glass above it.
  const hoopZ = canZ[13];
  const hoopC = topSection(hoopZ, bubble(hoopZ));
  parts.push({
    name: 'roll-hoop',
    surface: pipe(
      offsetSection(hoopC, -0.03, 16, [0, 1.0, hoopZ], 0.04, 0.96),
      0.015,
      {
        up: [0, 0, 1],
      },
    ),
    material: 'metal',
    color: TRIM,
    tessellation: {segmentsU: 8, segmentsV: 40},
  });
  const topY = hoopC.evaluate(0.5)[1];
  parts.push(
    box(
      'beacon-base',
      [0, topY + 0.008, hoopZ],
      [0.21, 0.01, 0.055],
      {material: 'metal', color: DARK},
      {
        e: 0.2,
        seg: 10,
      },
    ),
  );
  parts.push(
    box(
      'beacon-lens',
      [0, topY + 0.03, hoopZ],
      [0.2, 0.022, 0.045],
      {
        material: 'tinted-glass',
        doubleSided: true,
      },
      {e: 0.25, seg: 12},
    ),
  );
  for (const [x, col] of [
    [0.1, AMBER],
    [-0.1, CYAN],
  ] as const) {
    parts.push(
      box('beacon', [x, topY + 0.028, hoopZ], [0.08, 0.014, 0.03], {
        material: 'emissive',
        emissive: col,
      }),
    );
  }

  // Hood: a smooth power dome blended into the panel, two small vents.
  parts.push({
    name: 'hood-dome',
    surface: conform(hood, 0.3, 0.7, 0.35, 0.95, 0.0008, {
      nu: 9,
      nv: 11,
      bump: (a, b) =>
        0.045 *
        Math.pow(Math.sin(Math.PI * a), 2) *
        Math.pow(Math.sin(Math.PI * Math.min(1, b * 1.3)), 2),
    }),
    material: 'paint',
    color: PAINT,
    tessellation: {segmentsU: 16, segmentsV: 20},
  });
  for (const [u0, u1] of [
    [0.13, 0.24],
    [0.76, 0.87],
  ]) {
    parts.push({
      name: 'hood-vent',
      surface: conform(hood, u0, u1, 0.6, 0.85, 0.003, {
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
  const hv0 = vAtZ(upper, 0.5, 1.3);
  const hv1 = vAtZ(upper, 0.5, 1.75);
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

  // Panel-line grooves: hood shut lines, door cuts, deck lid, crease line.
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
  groove(
    hood,
    steps(0.03, 0.97, 6).map(v => [0.07, v] as [number, number]),
  );
  groove(
    hood,
    steps(0.03, 0.97, 6).map(v => [0.93, v] as [number, number]),
  );
  groove(
    hood,
    steps(0.07, 0.93, 6).map(u => [u, 0.03] as [number, number]),
  );
  groove(
    deck,
    steps(0.12, 0.88, 6).map(u => [u, 0.25] as [number, number]),
  );
  groove(
    deck,
    steps(0.12, 0.88, 6).map(u => [u, 0.88] as [number, number]),
  );
  groove(
    deck,
    steps(0.25, 0.88, 4).map(v => [0.12, v] as [number, number]),
  );
  groove(
    deck,
    steps(0.25, 0.88, 4).map(v => [0.88, v] as [number, number]),
  );
  for (const z of [-0.95, 1.2]) {
    const v = vAtZ(upper, 0.5, z);
    groove(
      upper,
      steps(0.04, 0.85, 5).map(u => [u, v] as [number, number]),
      true,
      10,
    );
  }
  groove(
    upper,
    steps(0.02, 0.98, 20).map(v => [0.025, v] as [number, number]),
    true,
    70,
  );

  // Nose fascia and tail panel: planar caps ruled horizontally from the
  // half outline to the center plane (no pole, so shading stays flat).
  const capOutline = (z: number, withPod: boolean): NurbsCurve => {
    const pts: Vec3[] = [];
    const ls = lowerSection(z);
    if (withPod) {
      const ps = podSection(z);
      for (let i = 0; i <= 6; i++) pts.push(ls.evaluate((ps.tA * i) / 6));
      for (let i = 1; i <= 16; i++) pts.push(ps.curve.evaluate(i / 16));
      for (let i = 1; i <= 4; i++)
        pts.push(ls.evaluate(ps.tB + ((1 - ps.tB) * i) / 4));
    } else {
      for (let i = 0; i <= 12; i++) pts.push(ls.evaluate(i / 12));
    }
    const us = upperSection(z);
    for (let i = 1; i <= 10; i++) pts.push(us.evaluate(i / 10));
    const ts = topSection(z);
    for (let i = 1; i <= 8; i++) pts.push(ts.evaluate(0.5 * (i / 8)));
    return NurbsCurve.interpolate(pts);
  };
  for (const [z, dir, name, withPod] of [
    [zN, -1, 'nose-fascia', false],
    [zT, 1, 'tail-panel', true],
  ] as const) {
    const outline = capOutline(z, withPod);
    parts.push({
      name,
      surface: orient(
        ruled(
          outline.transform(([, y, zz]) => [0, y, zz]),
          outline,
        ),
        [0, 0, dir],
        0.5,
        0.5,
      ),
      material: 'plastic',
      color: FASCIA,
      roughness: 0.5,
      mirror: true,
      tessellation: {segmentsU: 48, segmentsV: 1},
    });
  }

  // Nose: slim full-width light bar, slim grille, recessed wedge lamp
  // housings at the fender corners, a low bumper blade.
  parts.push(
    box(
      'light-bar',
      [0, 0.745, zN - 0.012],
      [0.64, 0.012, 0.014],
      {material: 'emissive', emissive: HEAD},
      {
        e: 0.2,
        seg: 10,
      },
    ),
  );
  parts.push(
    box(
      'grille',
      [0, 0.62, zN - 0.006],
      [0.4, 0.05, 0.01],
      {material: 'metal', color: [0.015, 0.015, 0.017]},
      {
        e: 0.2,
        seg: 10,
      },
    ),
  );
  for (let i = 0; i < 3; i++) {
    parts.push(
      box(
        'grille-slat',
        [0, 0.59 + i * 0.03, zN - 0.016],
        [0.38, 0.004, 0.006],
        {
          material: 'metal',
          color: TRIM,
        },
        {seg: 4},
      ),
    );
  }
  parts.push(
    box(
      'bumper',
      [0, 0.49, zN - 0.04],
      [0.68, 0.035, 0.07],
      {material: 'metal', color: TRIM},
      {
        e: 0.3,
        seg: 16,
      },
    ),
  );
  // Wedge housing wrapping the fender corner (front face + side).
  const v1 = vAtZ(upper, 0.5, zN + 0.42);
  const wedge = (a: number, b: number): [number, number] => {
    const taper = 1 - 0.75 * b;
    return [0.12 + (0.68 - 0.12) * (0.5 + (a - 0.5) * taper), b * v1];
  };
  parts.push({
    name: 'lamp-housing',
    surface: conformMap(upper, wedge, 0.003, 6, 6),
    material: 'plastic',
    color: [0.012, 0.012, 0.014],
    mirror: true,
    tessellation: {segmentsU: 6, segmentsV: 8},
  });
  parts.push({
    name: 'side-lamp',
    surface: conformMap(
      upper,
      (a, b) => {
        const [u, v] = wedge(0.3 + 0.4 * a, 0.12 + 0.5 * b);
        return [u, v];
      },
      0.006,
      4,
      5,
    ),
    material: 'emissive',
    emissive: AMBER,
    mirror: true,
    tessellation: {segmentsU: 3, segmentsV: 6},
  });
  const nl = lip(zN);
  const nu = upperSection(zN).evaluate(0.65);
  parts.push(
    box(
      'headlamp-bezel',
      [nu[0] - 0.13, (nl[1] + nu[1]) / 2, zN - 0.004],
      [0.13, 0.05, 0.01],
      {
        material: 'plastic',
        color: [0.012, 0.012, 0.014],
      },
      {e: 0.2, seg: 10, mirror: true},
    ),
  );
  for (const dx of [-0.2, -0.09]) {
    parts.push(
      box(
        'headlamp',
        [nu[0] + dx + 0.02, (nl[1] + nu[1]) / 2, zN - 0.012],
        [0.045, 0.028, 0.006],
        {
          material: 'emissive',
          emissive: HEAD,
        },
        {seg: 6, mirror: true},
      ),
    );
  }

  // Tail: full-width saturated red strip, small reversing lamps, lip.
  const tailTop = edgeY(zT);
  parts.push(
    box(
      'tail-light',
      [0, tailTop - 0.07, zT + 0.008],
      [flareW(zT) - 0.06, 0.018, 0.012],
      {
        material: 'emissive',
        emissive: TAIL,
      },
      {e: 0.2, seg: 10},
    ),
  );
  parts.push(
    box(
      'tail-light-bezel',
      [0, tailTop - 0.07, zT + 0.002],
      [flareW(zT) - 0.04, 0.03, 0.01],
      {
        material: 'metal',
        color: DARK,
      },
      {e: 0.2, seg: 10},
    ),
  );
  parts.push(
    box(
      'tail-lip',
      [0, tailTop + 0.012, zT - 0.02],
      [0.82, 0.008, 0.05],
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

  // Front amber markers, rear deck antenna.
  parts.push(
    box(
      'antenna-base',
      [-0.62, edgeY(2.25) + 0.03, 2.25],
      [0.03, 0.03, 0.03],
      {material: 'metal', color: TRIM},
      {
        e: 0.4,
        seg: 6,
      },
    ),
  );
  parts.push({
    name: 'antenna',
    surface: pipe(
      [
        [-0.62, edgeY(2.25) + 0.05, 2.25],
        [-0.62, edgeY(2.25) + 0.3, 2.32],
        [-0.62, edgeY(2.25) + 0.52, 2.42],
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
