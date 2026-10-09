// Autopilot: a long, deterministic route along the avenue grid (the open sky
// lanes between superblocks), smoothed into a spline with speed easing into
// turns, banking, altitude changes and a gentle hover bob.
import {Rng} from '../math/random';
import {
  add,
  cross,
  dot,
  length,
  lerp,
  normalize,
  scale,
  sub,
  rotateAround,
  fromBasis,
  type Mat4,
  type Vec3,
} from '../math/vec';
import {CITY_RADIUS_SUPERS, SUPER} from '../city/layout';
import {warp, warp3} from '../city/warp';
import type {Obstacle} from '../city/generate';

const CRUISE = 38; // m/s
const LATERAL_ACCEL = 3.4; // m/s^2 (~0.35 g) in turns
const BRAKE = 2.5; // m/s^2
const ACCEL = 2.0; // m/s^2
const TABLE_DT = 0.05;
const TURN_RADIUS = 30; // m, arc radius through intersections
// Orientation smoothing (see simulate()).
const SIM_DT = 1 / 30;
const HEADING_LAG = 0.35; // s
const BANK_LAG = 0.5; // s

export interface CarPose {
  position: Vec3;
  forward: Vec3;
  up: Vec3;
  right: Vec3;
  speed: number;
  /** Car-to-world matrix (model space: +X right, +Y up, nose toward -Z). */
  matrix: Mat4;
}

export class FlightPath {
  private samples: Vec3[] = []; // dense, ~1 m spacing
  private cum: number[] = [];
  private timeToDist: number[] = [];
  readonly totalLength: number;
  readonly duration: number;
  /** Avenue intersections the route passes through, in order. */
  readonly intersections: [number, number][] = [];

  constructor(seed: number, obstacles: Obstacle[]) {
    const rng = new Rng(seed, 777);
    const limit = CITY_RADIUS_SUPERS - 3;
    let a = 0;
    let b = 0;
    let dir: [number, number] = [0, -1];
    // Legs along the avenue grid; geometry is built afterwards.
    const legList: {
      start: [number, number];
      dir: [number, number];
      len: number;
      alt0: number;
      alt1: number;
      side: number;
    }[] = [];
    let alt = 220;
    const legs = 160;
    for (let leg = 0; leg < legs; leg++) {
      let n = rng.int(1, 5);
      // Keep within bounds.
      for (let k = 0; k < 8; k++) {
        const na = a + dir[0] * n;
        const nb = b + dir[1] * n;
        if (Math.abs(na) <= limit && Math.abs(nb) <= limit) break;
        n = Math.max(1, n - 1);
        if (k > 3) dir = [-dir[1], dir[0]];
      }
      const na = a + dir[0] * n;
      const nb = b + dir[1] * n;
      const start: Vec3 = [a * SUPER, alt, b * SUPER];
      const end: Vec3 = [na * SUPER, 0, nb * SUPER];
      // Altitude for this leg, kept clear of avenue bridges.
      let target = rng.range(110, 330);
      const minX = Math.min(start[0], end[0]) - 40;
      const maxX = Math.max(start[0], end[0]) + 40;
      const minZ = Math.min(start[2], end[2]) - 40;
      const maxZ = Math.max(start[2], end[2]) + 40;
      for (const o of obstacles) {
        if (o.x1 < minX || o.x0 > maxX || o.z1 < minZ || o.z0 > maxZ) continue;
        if (target > o.y0 - 30 && target < o.y1 + 30) {
          target =
            o.y0 > 200
              ? Math.min(target, o.y0 - 40)
              : Math.max(target, o.y1 + 40);
        }
      }
      // Gentle climbs and dives only (max ~10 degrees).
      const maxStep = n * SUPER * 0.12;
      target = Math.max(alt - maxStep, Math.min(alt + maxStep, target));
      legList.push({
        start: [a * SUPER, b * SUPER],
        dir: [dir[0], dir[1]],
        len: n * SUPER,
        alt0: alt,
        alt1: target,
        side: rng.range(-8, 8),
      });
      alt = target;
      this.intersections.push(warp(na * SUPER, nb * SUPER));
      a = na;
      b = nb;
      // Turn left or right (or continue straight sometimes).
      const r = rng.next();
      if (r < 0.42) dir = [-dir[1], dir[0]];
      else if (r < 0.84) dir = [dir[1], -dir[0]];
    }
    // Track geometry: straight runs along the avenue centerlines joined by
    // exact circular arcs (radius TURN_RADIUS, tangent to both centerlines)
    // through each intersection. The lateral drift within a lane eases in
    // and out mid-leg so the arcs stay exact. Sampled every ~1 m.
    const turns = legList.map((L, i) => {
      const next = legList[i + 1];
      return (
        next !== undefined &&
        (next.dir[0] !== L.dir[0] || next.dir[1] !== L.dir[1])
      );
    });
    for (let i = 0; i < legList.length; i++) {
      const L = legList[i];
      const inR = i > 0 && turns[i - 1] ? TURN_RADIUS : 0;
      const outR = turns[i] ? TURN_RADIUS : 0;
      const d: Vec3 = [L.dir[0], 0, L.dir[1]];
      const perp: Vec3 = [-L.dir[1], 0, L.dir[0]];
      const s0 = inR;
      const s1 = L.len - outR;
      const steps = Math.max(2, Math.ceil(s1 - s0));
      for (let k = 0; k < steps; k++) {
        const f = k / steps;
        const dist = s0 + f * (s1 - s0);
        const y = lerp(L.alt0, L.alt1, f * f * (3 - 2 * f));
        const lat = L.side * Math.sin(Math.PI * f) ** 2;
        this.samples.push(
          add(
            add([L.start[0], y, L.start[1]], scale(d, dist)),
            scale(perp, lat),
          ),
        );
      }
      if (turns[i]) {
        const nd: Vec3 = [legList[i + 1].dir[0], 0, legList[i + 1].dir[1]];
        const I: Vec3 = [
          L.start[0] + d[0] * L.len,
          L.alt1,
          L.start[1] + d[2] * L.len,
        ];
        const p0 = sub(I, scale(d, TURN_RADIUS));
        const p1 = add(I, scale(nd, TURN_RADIUS));
        const c = add(p0, scale(nd, TURN_RADIUS));
        const e0 = sub(p0, c);
        const e1 = sub(p1, c);
        const arcSteps = Math.ceil((Math.PI / 2) * TURN_RADIUS);
        for (let k = 0; k < arcSteps; k++) {
          const th = (k / arcSteps) * (Math.PI / 2);
          this.samples.push(
            add(c, add(scale(e0, Math.cos(th)), scale(e1, Math.sin(th)))),
          );
        }
      }
    }
    // Gaussian-smooth the track (sigma ~8 m): line-to-arc joins get gradual
    // curvature ramps (like road clothoids) while moving < 2 m sideways.
    {
      const src = this.samples;
      const R = 24;
      const w = Array.from({length: 2 * R + 1}, (_, k) =>
        Math.exp(-((k - R) ** 2) / (2 * 8 * 8)),
      );
      this.samples = src.map((p, i) => {
        let x = 0;
        let z = 0;
        let ws = 0;
        for (let k = -R; k <= R; k++) {
          const q = src[Math.min(src.length - 1, Math.max(0, i + k))];
          x += q[0] * w[k + R];
          z += q[2] * w[k + R];
          ws += w[k + R];
        }
        return [x / ws, p[1], z / ws] as Vec3;
      });
    }
    // Planned in grid space; bend into world space with the city.
    this.samples = this.samples.map(p => warp3(p));
    this.cum = [0];
    for (let i = 1; i < this.samples.length; i++) {
      this.cum.push(
        this.cum[i - 1] + length(sub(this.samples[i], this.samples[i - 1])),
      );
    }
    this.totalLength = this.cum[this.cum.length - 1];
    // Speed profile (like a racing line): the speed at each point is
    // limited by its curvature (gentle lateral g), then a backward pass
    // brakes in time for turns and a forward pass limits acceleration.
    const DS = 2;
    const m = Math.ceil(this.totalLength / DS) + 1;
    const vmax = new Float32Array(m);
    for (let k = 0; k < m; k++) {
      const c = Math.max(this.curvature(k * DS), 1e-5);
      vmax[k] = Math.min(CRUISE, Math.sqrt(LATERAL_ACCEL / c));
    }
    for (let k = m - 2; k >= 0; k--) {
      vmax[k] = Math.min(vmax[k], Math.sqrt(vmax[k + 1] ** 2 + 2 * BRAKE * DS));
    }
    vmax[0] = Math.min(vmax[0], CRUISE * 0.6);
    for (let k = 1; k < m; k++) {
      vmax[k] = Math.min(vmax[k], Math.sqrt(vmax[k - 1] ** 2 + 2 * ACCEL * DS));
    }
    // Integrate into a time -> distance table.
    let s = 0;
    this.timeToDist.push(0);
    while (s < this.totalLength - 200) {
      const f = s / DS;
      const k = Math.min(m - 2, Math.floor(f));
      const v = vmax[k] + (vmax[k + 1] - vmax[k]) * (f - k);
      s += Math.max(v, 1) * TABLE_DT;
      this.timeToDist.push(s);
    }
    this.duration = (this.timeToDist.length - 1) * TABLE_DT;
    this.simulate();
  }

  private index(s: number): number {
    const c = this.cum;
    s = Math.max(0, Math.min(this.totalLength, s));
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo + (s - c[lo]) / Math.max(1e-6, c[hi] - c[lo]);
  }

  pointAt(s: number): Vec3 {
    const f = this.index(s);
    const i = Math.min(this.samples.length - 2, Math.floor(f));
    const t = f - i;
    const a = this.samples[i];
    const b = this.samples[i + 1];
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  }

  tangentAt(s: number): Vec3 {
    return normalize(sub(this.pointAt(s + 2), this.pointAt(s - 2)));
  }

  /** Signed horizontal curvature (1/m), positive turning left. */
  curvature(s: number): number {
    const t0 = this.tangentAt(s - 6);
    const t1 = this.tangentAt(s + 6);
    const c = cross([t0[0], 0, t0[2]], [t1[0], 0, t1[2]]);
    return Math.abs(c[1]) / 12;
  }

  private signedCurvature(s: number): number {
    const t0 = this.tangentAt(s - 8);
    const t1 = this.tangentAt(s + 8);
    return cross([t0[0], 0, t0[2]], [t1[0], 0, t1[2]])[1] / 16;
  }

  distanceAt(time: number): number {
    const t = ((time % this.duration) + this.duration) % this.duration;
    const f = t / TABLE_DT;
    const i = Math.floor(f);
    const a = this.timeToDist[i];
    const b = this.timeToDist[Math.min(i + 1, this.timeToDist.length - 1)];
    return lerp(a, b, f - i);
  }

  // ------------------------------------------------------------------
  // The car rides the (smoothed) track, but its orientation chases the
  // track's direction with a little lag, like a body with momentum: heading
  // and bank are low-pass filtered in time. Precomputed once so any time can
  // be sampled deterministically, then interpolated.
  private simFwd: Float32Array = new Float32Array(0);
  private simBank: Float32Array = new Float32Array(0);

  private simulate() {
    const n = Math.ceil(this.duration / SIM_DT) + 2;
    this.simFwd = new Float32Array(n * 3);
    this.simBank = new Float32Array(n);
    let fwd = this.tangentAt(0);
    let bank = 0;
    const kf = 1 - Math.exp(-SIM_DT / HEADING_LAG);
    const kb = 1 - Math.exp(-SIM_DT / BANK_LAG);
    for (let i = 0; i < n; i++) {
      const t = i * SIM_DT;
      const s = this.distanceAt(Math.min(t, this.duration));
      const want = this.tangentAt(s + 2);
      fwd = normalize(add(fwd, scale(sub(want, fwd), kf)));
      const speed = this.speedAt(t);
      const k = this.signedCurvature(s + 3);
      const bankTarget = Math.max(
        -0.5,
        Math.min(0.5, Math.atan((speed * speed * k) / 9.81) * 0.9),
      );
      bank += (bankTarget - bank) * kb;
      this.simFwd.set(fwd, i * 3);
      this.simBank[i] = bank;
    }
  }

  /** The track point the carrot started from at this time (debugging). */
  trackPoint(time: number): Vec3 {
    return this.pointAt(this.distanceAt(time));
  }

  private speedAt(time: number): number {
    return (this.distanceAt(time + 0.05) - this.distanceAt(time)) / 0.05;
  }

  pose(time: number): CarPose {
    const t = ((time % this.duration) + this.duration) % this.duration;
    const f = t / SIM_DT;
    const i = Math.min(Math.floor(f), this.simBank.length - 2);
    const u = f - i;
    const F = (k: number): Vec3 => [
      this.simFwd[k * 3],
      this.simFwd[k * 3 + 1],
      this.simFwd[k * 3 + 2],
    ];
    const dir = normalize(add(scale(F(i), 1 - u), scale(F(i + 1), u)));
    const bank = this.simBank[i] * (1 - u) + this.simBank[i + 1] * u;
    const s = this.distanceAt(time);
    let pos = this.pointAt(s);
    const speed = this.speedAt(t);
    const vel = dir;
    // Follow the track's pitch only partially: flying cars stay level.
    const fwd = normalize([vel[0], vel[1] * 0.5, vel[2]]);
    const flatRight = normalize(cross(fwd, [0, 1, 0]));
    let up = normalize(cross(flatRight, fwd));
    up = rotateAround(up, fwd, -bank);
    // Hover bob and a little drift.
    const bob = Math.sin(time * 1.3) * 0.12 + Math.sin(time * 0.71 + 1) * 0.08;
    pos = add(pos, [0, bob, 0]);
    const pitchWobble = Math.sin(time * 0.9) * 0.01;
    const fwd2 = normalize(add(fwd, scale(up, pitchWobble)));
    const right = normalize(cross(fwd2, up));
    const up2 = cross(right, fwd2);
    // Model space: +X right, +Y up, nose toward -Z => Z axis = -forward.
    const matrix = fromBasis(right, up2, scale(fwd2, -1), pos);
    return {position: pos, forward: fwd2, up: up2, right, speed, matrix};
  }
}

/** Smoothly follows the car from behind and above. */
/** A chase-camera framing: offset in the car's horizontal frame. */
interface Shot {
  back: number; // meters behind (negative = in front)
  side: number; // meters to the right
  up: number;
  lookAhead: number; // look-at point ahead of the car
  fov: number; // degrees
}

// Cinematic framings cycled during the flight.
const SHOTS: Shot[] = [
  {back: 11, side: 0, up: 2.6, lookAhead: 6, fov: 55}, // classic chase
  {back: 9, side: -2.2, up: 0.5, lookAhead: 10, fov: 60}, // low, close
  {back: 18, side: 5, up: 4.5, lookAhead: 4, fov: 48}, // high wide
  {back: 2, side: 9, up: 1.2, lookAhead: 2, fov: 50}, // side tracking
  {back: -12, side: 4, up: 2.0, lookAhead: -2, fov: 48}, // front three-quarter, looking back
];
const SHOT_LEN = 22;
const SHOT_BLEND = 4;

/** Blended framing for a time (deterministic, so screenshots repeat). */
export function shotAt(time: number, fixed?: number): Shot {
  const n = SHOTS.length;
  const at = (i: number) => SHOTS[((i % n) + n) % n];
  if (fixed !== undefined) return at(fixed);
  const k = Math.floor(time / SHOT_LEN);
  const f = time / SHOT_LEN - k;
  const a = at(k);
  const b = at(k + 1);
  const t = Math.max(0, (f * SHOT_LEN - (SHOT_LEN - SHOT_BLEND)) / SHOT_BLEND);
  const e = t * t * (3 - 2 * t);
  const mix = (x: number, y: number) => x + (y - x) * e;
  return {
    back: mix(a.back, b.back),
    side: mix(a.side, b.side),
    up: mix(a.up, b.up),
    lookAhead: mix(a.lookAhead, b.lookAhead),
    fov: mix(a.fov, b.fov),
  };
}

/** Smoothly follows the car with cinematic framings. */
export class ChaseCamera {
  private pos: Vec3 | null = null;
  private target: Vec3 | null = null;
  private lastTime = -1;
  /** Force one framing (keys 1-5); undefined cycles automatically. */
  fixedShot: number | undefined = undefined;
  fov = 55;

  update(
    pose: CarPose,
    time: number,
    dt: number,
  ): {eye: Vec3; target: Vec3; up: Vec3} {
    const shot = shotAt(time, this.fixedShot);
    this.fov = shot.fov;
    const fwd = normalize([pose.forward[0], 0, pose.forward[2]]);
    const right: Vec3 = [-fwd[2], 0, fwd[0]];
    const sway = Math.sin(time * 0.07) * 0.08;
    const back = rotateAround(scale(fwd, -1), [0, 1, 0], sway);
    const desiredEye = add(
      add(add(pose.position, scale(back, shot.back)), scale(right, shot.side)),
      [0, shot.up, 0],
    );
    const desiredTarget = add(
      add(pose.position, scale(pose.forward, shot.lookAhead)),
      [0, 0.5, 0],
    );
    // Smooth the camera's offset from the car, not its world position:
    // chasing a target moving at ~80 m/s with an exponential follow lags by
    // about v*dt/2 more on longer frames, so frame-time jitter would shake
    // the car around the screen. In the car's frame only framing changes and
    // turns are smoothed, which is frame-rate independent.
    const eyeRel = sub(desiredEye, pose.position);
    const targetRel = sub(desiredTarget, pose.position);
    if (!this.pos || !this.target || Math.abs(time - this.lastTime) > 1) {
      this.pos = eyeRel;
      this.target = targetRel;
    } else {
      const a = 1 - Math.exp(-dt * 4);
      const b = 1 - Math.exp(-dt * 8);
      this.pos = add(this.pos, scale(sub(eyeRel, this.pos), a));
      this.target = add(this.target, scale(sub(targetRel, this.target), b));
      // Keep height close to the framing so climbs/dives don't leave the
      // camera staring at the car's belly.
      const y = Math.min(
        Math.max(this.pos[1], eyeRel[1] - 1.5),
        eyeRel[1] + 1.5,
      );
      this.pos = [this.pos[0], y, this.pos[2]];
    }
    this.lastTime = time;
    // Slight roll with the car's bank.
    const up = normalize(
      add([0, 1, 0], scale(sub(pose.up, [0, dot(pose.up, [0, 1, 0]), 0]), 0.4)),
    );
    return {
      eye: add(pose.position, this.pos),
      target: add(pose.position, this.target),
      up,
    };
  }
}
