// Flying-traffic lanes over the avenues and the vehicles on them.
import {Rng} from '../math/random';
import {CITY_RADIUS_SUPERS, CITY_HALF_SIZE, SUPER} from './layout';

/** Lane altitudes (m). The autopilot keeps to the avenue center (+-8 m). */
const ALTITUDES = [60, 150, 235, 310, 400];
/** Lateral offsets from the avenue centerline for each direction. */
const OFFSETS = [17, 26];

export interface TrafficData {
  lanes: Float32Array; // 8 floats each: origin.xyz, length, dir.xyz, pad
  vehicles: ArrayBuffer; // 16 bytes each: lane u32, s0 f32, speed f32, style u32
  laneCount: number;
  vehicleCount: number;
}

export function generateTraffic(seed: number): TrafficData {
  const rng = new Rng(seed, 8080);
  const lanes: number[] = [];
  const veh: number[] = [];
  const N = CITY_RADIUS_SUPERS;
  const L = CITY_HALF_SIZE * 2;
  let laneId = 0;
  for (let k = -N; k <= N; k++) {
    for (const alongZ of [true, false]) {
      for (const alt of ALTITUDES) {
        for (const off of OFFSETS) {
          for (const dirSign of [1, -1]) {
            // Traffic keeps right: offset to the right of travel direction.
            const lateral = off * dirSign;
            const a = alt + rng.range(-8, 8);
            const origin = alongZ
              ? [k * SUPER - lateral, a, -dirSign * CITY_HALF_SIZE]
              : [-dirSign * CITY_HALF_SIZE, a, k * SUPER + lateral];
            const dir = alongZ ? [0, 0, dirSign] : [dirSign, 0, 0];
            lanes.push(...origin, L, ...dir, 0);
            const speed = rng.range(22, 50);
            let s = rng.range(0, 150);
            while (s < L) {
              veh.push(laneId, s, speed * rng.range(0.95, 1.05), rng.nextU32());
              s += rng.range(70, 260);
            }
            laneId++;
          }
        }
      }
    }
  }
  const count = veh.length / 4;
  const buf = new ArrayBuffer(count * 16);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  for (let i = 0; i < count; i++) {
    u[i * 4] = veh[i * 4];
    f[i * 4 + 1] = veh[i * 4 + 1];
    f[i * 4 + 2] = veh[i * 4 + 2];
    u[i * 4 + 3] = veh[i * 4 + 3];
  }
  return {
    lanes: new Float32Array(lanes),
    vehicles: buf,
    laneCount: laneId,
    vehicleCount: count,
  };
}
