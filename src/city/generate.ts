// City generator (placeholder grid; replaced by the district grammar).
import {Rng} from '../math/random';
import {Shape} from './meshes';
import {SegmentList, Style, packColor} from './segments';

export function generateCity(seed: number): SegmentList {
  const rng = new Rng(seed);
  const list = new SegmentList(1 << 16);
  const N = 60;
  const spacing = 120;
  for (let i = -N; i < N; i++) {
    for (let j = -N; j < N; j++) {
      if (i === 0) continue; // avenue
      const h = 60 + Math.pow(rng.next(), 3) * 900;
      const w = rng.range(40, 90);
      const d = rng.range(40, 90);
      list.push({
        x: i * spacing,
        y: 0,
        z: j * spacing,
        rotY: 0,
        sx: w,
        sy: h,
        sz: d,
        taper: 1,
        twist: 0,
        shape: rng.chance(0.15) ? Shape.Cylinder : Shape.Box,
        style: Style.GlassOffice,
        seed: rng.nextU32(),
        colorA: packColor(1, 0.75, 0.5),
        colorB: packColor(0, 1, 1),
        flags: 0,
        floorH: 4,
      });
    }
  }
  return list;
}
