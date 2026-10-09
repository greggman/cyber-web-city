// Rooftop massing: the large pieces that make a skyline read from far away
// (mechanical penthouses, water-tank clusters, cooling towers, lattice
// masts, billboard frames). They're ordinary segments, so they get the
// city's LOD and culling. Small rooftop kitbash is generated on the GPU
// (details_emit.wgsl); this is the scale above it.
//
// Runs after the warp, in world space: positions follow each roof's final
// (warped, corridor-shrunk) pose.
import {Rng, hashCombine} from '../math/random';
import {Shape} from './meshes';
import {SegFlags, SegmentList, Style, packColor} from './segments';

const TANK = packColor(0.5, 0.48, 0.45);
const STEEL = packColor(0.3, 0.31, 0.33);

export function addRooftopMassing(segments: SegmentList, seed: number) {
  const n = segments.count;
  for (let i = 0; i < n; i++) {
    const g = segments.get(i);
    if ((g.flags & SegFlags.RoofExposed) === 0) continue;
    if (g.shape > Shape.BoxTwist || g.twist !== 0) continue;
    if (g.style === Style.NeonRing || g.style === Style.LedFacade) continue;
    const tx = g.sx * g.taper;
    const tz = g.sz * g.taper;
    if (Math.min(tx, tz) < 18) continue;
    const rng = new Rng(hashCombine(seed, i, 0x5eed));
    const top = g.y + g.sy;
    const c = Math.cos(g.rotY);
    const s = Math.sin(g.rotY);
    const ring = (g.flags & SegFlags.RoofRing) !== 0;
    // Painted helipad in the middle (must match helipad() in the shaders).
    const helipad = !ring && Math.min(tx, tz) > 40 && (g.seed & 7) < 2;
    // Place in roof-local coordinates (fractions of the half extents).
    const put = (
      fx: number,
      fz: number,
      w: number,
      d: number,
      h: number,
      o: {
        shape?: Shape;
        style?: Style;
        taper?: number;
        flags?: number;
        color?: number;
        accent?: number;
        y?: number;
      },
    ) => {
      // Keep the piece on the roof.
      const cx =
        Math.sign(fx) * Math.min(Math.abs(fx), Math.max(0, 1 - w / tx));
      const cz =
        Math.sign(fz) * Math.min(Math.abs(fz), Math.max(0, 1 - d / tz));
      const lx = (cx * tx) / 2;
      const lz = (cz * tz) / 2;
      segments.push({
        x: g.x + c * lx - s * lz,
        y: (o.y ?? top) - 0.05,
        z: g.z + s * lx + c * lz,
        rotY: g.rotY,
        sx: w,
        sy: h,
        sz: d,
        taper: o.taper ?? 1,
        twist: 0,
        shape: o.shape ?? Shape.Box,
        style: o.style ?? Style.MetalPanel,
        seed: rng.nextU32(),
        colorA: o.color ?? STEEL,
        colorB: o.accent ?? packColor(1, 0.2, 0.15),
        flags: o.flags ?? SegFlags.NoWindows,
        floorH: 4,
      });
    };
    // Corners keep clear of a tower rising from the middle of the roof.
    const corner = () => {
      const fx = (rng.chance(0.5) ? 1 : -1) * rng.range(0.45, 0.7);
      const fz = (rng.chance(0.5) ? 1 : -1) * rng.range(0.45, 0.7);
      return [fx, fz];
    };
    // Core penthouse, centred: the GPU rooftop clusters are composed around
    // it (roof_core() in segment.wgsl must agree).
    const core = !ring && !helipad && ((g.seed >>> 3) & 7) < 5;
    if (core) {
      const w = tx * 0.32;
      const d = tz * 0.32;
      const h = rng.range(4, 8);
      put(0, 0, w, d, h, {
        style: rng.chance(0.5) ? Style.MetalPanel : Style.Monolith,
        flags: SegFlags.NoWindows,
      });
      // A second, smaller stage (lift motor room).
      if (rng.chance(0.45)) {
        put(0, 0, w * 0.55, d * 0.6, rng.range(3, 6), {
          y: top + h,
          flags: SegFlags.NoWindows,
        });
      }
    }
    // Ring roofs/helipads: a plant room in a corner instead.
    if ((ring || helipad) && rng.chance(0.55)) {
      const [fx, fz] = corner();
      put(
        fx,
        fz,
        tx * rng.range(0.18, 0.3),
        tz * rng.range(0.18, 0.3),
        rng.range(4, 7),
        {
          style: Style.MetalPanel,
          flags: SegFlags.NoWindows,
        },
      );
    }
    // Water tanks in a cluster (on roofs without a core; the GPU groups
    // tanks around the core otherwise).
    if (rng.chance(0.6) && !core) {
      const [fx, fz] =
        ring || helipad
          ? corner()
          : [rng.range(-0.6, 0.6), rng.range(-0.6, 0.6)];
      const k = rng.int(1, 4);
      const r = rng.range(3, 5.5);
      for (let t = 0; t < k; t++) {
        const ox = (t % 2) * ((r * 2.3) / tx) * 2;
        const oz = Math.floor(t / 2) * ((r * 2.3) / tz) * 2;
        put(
          fx - Math.sign(fx) * ox,
          fz - Math.sign(fz) * oz,
          r * 2,
          r * 2,
          r * rng.range(1.2, 1.8),
          {
            shape: Shape.Cylinder,
            color: TANK,
          },
        );
      }
    }
    // Cooling towers (industrial, on big roofs).
    if (tx * tz > 1600 && rng.chance(0.25)) {
      const [fx, fz] = corner();
      const r = rng.range(5, 8);
      put(fx, fz, r * 2, r * 2, r * 1.6, {
        shape: Shape.Cylinder,
        taper: 0.75,
        style: Style.Monolith,
        flags: SegFlags.NoWindows,
      });
    }
    // Lattice mast with aircraft beacon.
    if (rng.chance(0.4)) {
      const [fx, fz] = corner();
      const h = rng.range(18, Math.min(70, g.sy * 0.25 + 20));
      put(fx, fz, 2.2, 2.2, h, {
        style: Style.Structure,
        taper: 0.4,
        flags: SegFlags.RoofBeacon,
        accent: packColor(1, 0.1, 0.08),
      });
    }
    // Rooftop shacks: squatter rooms and stairwell huts with lit windows.
    const shacks = rng.int(0, ring ? 2 : 4);
    for (let k = 0; k < shacks; k++) {
      const [fx, fz] = corner();
      const w = rng.range(4, 8);
      put(fx, fz, w, rng.range(4, 7), rng.range(3, 4.5), {
        style: Style.Slum,
        flags: 0,
        color: packColor(1, rng.range(0.55, 0.8), rng.range(0.3, 0.5)),
      });
    }
    // Billboard frame on legs (lit panel on the outward face); never on
    // a helipad roof.
    if (rng.chance(0.18) && !helipad) {
      const alongX = rng.chance(0.5);
      const w = (alongX ? tx : tz) * rng.range(0.4, 0.7);
      const h = w * rng.range(0.3, 0.45);
      const legs = rng.range(3, 6);
      const side = rng.chance(0.5) ? 1 : -1;
      const fx = alongX ? 0 : side * 0.7;
      const fz = alongX ? side * 0.7 : 0;
      const [bw, bd] = alongX ? [w, 1.2] : [1.2, w];
      put(fx, fz, bw * 0.9, bd * 0.5, legs, {style: Style.Structure});
      put(fx, fz, bw, bd, h, {
        y: top + legs,
        style: Style.LedFacade,
        flags: 0,
        color: packColor(...neonPair(rng)[0]),
        accent: packColor(...neonPair(rng)[1]),
      });
    }
  }
}

const NEONS: [number, number, number][] = [
  [1.0, 0.08, 0.55],
  [0.05, 0.85, 1.0],
  [1.0, 0.5, 0.05],
  [0.55, 0.15, 1.0],
  [0.15, 1.0, 0.45],
];

function neonPair(rng: Rng) {
  return [rng.pick(NEONS), rng.pick(NEONS)];
}
