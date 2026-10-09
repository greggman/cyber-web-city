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
const TURN_SPEED = 22;
const TABLE_DT = 0.05;

interface PathPoint {
  p: Vec3;
}

export interface CarPose {
  position: Vec3;
  forward: Vec3;
  up: Vec3;
  right: Vec3;
  speed: number;
  /** Car-to-world matrix (model space: +X right, +Y up, nose toward -Z). */
  matrix: Mat4;
}

/** Centripetal Catmull-Rom on 4 points. */
function catmull(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const alpha = 0.5;
  const tj = (ti: number, a: Vec3, b: Vec3) =>
    ti + Math.pow(Math.max(length(sub(b, a)), 1e-4), alpha);
  const t0 = 0;
  const t1 = tj(t0, p0, p1);
  const t2 = tj(t1, p1, p2);
  const t3 = tj(t2, p2, p3);
  const u = lerp(t1, t2, t);
  const A1 = add(
    scale(p0, (t1 - u) / (t1 - t0)),
    scale(p1, (u - t0) / (t1 - t0)),
  );
  const A2 = add(
    scale(p1, (t2 - u) / (t2 - t1)),
    scale(p2, (u - t1) / (t2 - t1)),
  );
  const A3 = add(
    scale(p2, (t3 - u) / (t3 - t2)),
    scale(p3, (u - t2) / (t3 - t2)),
  );
  const B1 = add(
    scale(A1, (t2 - u) / (t2 - t0)),
    scale(A2, (u - t0) / (t2 - t0)),
  );
  const B2 = add(
    scale(A2, (t3 - u) / (t3 - t1)),
    scale(A3, (u - t1) / (t3 - t1)),
  );
  return add(scale(B1, (t2 - u) / (t2 - t1)), scale(B2, (u - t1) / (t2 - t1)));
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
    const pts: PathPoint[] = [];
    let alt = 220;
    const legs = 160;
    const corner = 36;
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
      // Lateral offset within the lane.
      const side = rng.range(-8, 8);
      const perp: Vec3 = [-dir[1], 0, dir[0]];
      const d3: Vec3 = [dir[0], 0, dir[1]];
      const legLen = n * SUPER;
      const steps = Math.max(2, Math.round(legLen / 60));
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        const dist = corner + f * (legLen - 2 * corner);
        const y = lerp(alt, target, f * f * (3 - 2 * f));
        pts.push({
          p: add(
            add([start[0], y, start[2]], scale(d3, dist)),
            scale(perp, side),
          ),
        });
      }
      alt = target;
      this.intersections.push(warp(na * SUPER, nb * SUPER));
      a = na;
      b = nb;
      // Turn left or right (or continue straight sometimes).
      const r = rng.next();
      if (r < 0.42) dir = [-dir[1], dir[0]];
      else if (r < 0.84) dir = [dir[1], -dir[0]];
    }
    // Dense resample of the spline.
    const P = pts.map(q => q.p);
    for (let i = 0; i < P.length - 3; i++) {
      const seglen = length(sub(P[i + 2], P[i + 1]));
      const n = Math.max(2, Math.ceil(seglen / 1.0));
      for (let k = 0; k < n; k++) {
        this.samples.push(catmull(P[i], P[i + 1], P[i + 2], P[i + 3], k / n));
      }
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
    // Integrate the speed profile into a time -> distance table.
    let s = 0;
    let v = CRUISE * 0.6;
    this.timeToDist.push(0);
    while (s < this.totalLength - 200) {
      // Look ahead for curvature.
      let k = 0;
      for (const ahead of [10, 30, 60])
        k = Math.max(k, this.curvature(s + ahead));
      const target = lerp(CRUISE, TURN_SPEED, Math.min(1, k * 25));
      v += (target - v) * Math.min(1, TABLE_DT * 0.8);
      s += v * TABLE_DT;
      this.timeToDist.push(s);
    }
    this.duration = (this.timeToDist.length - 1) * TABLE_DT;
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

  pose(time: number): CarPose {
    const s = this.distanceAt(time);
    const s2 = this.distanceAt(time + 0.05);
    const speed = (s2 - s) / 0.05;
    let pos = this.pointAt(s);
    // Follow the path's pitch only partially: flying cars stay fairly level.
    const tan = this.tangentAt(s + 3);
    const fwd = normalize([tan[0], tan[1] * 0.5, tan[2]]);
    // Bank into turns: lateral acceleration v^2 * k.
    const k =
      (this.signedCurvature(s + 4) + this.signedCurvature(s + 10)) * 0.5;
    const bank = Math.max(
      -0.6,
      Math.min(0.6, Math.atan((speed * speed * k) / 9.81) * 0.8),
    );
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
  if (fixed !== undefined) return SHOTS[fixed % SHOTS.length];
  const k = Math.floor(time / SHOT_LEN);
  const f = time / SHOT_LEN - k;
  const a = SHOTS[k % SHOTS.length];
  const b = SHOTS[(k + 1) % SHOTS.length];
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
    if (!this.pos || !this.target || Math.abs(time - this.lastTime) > 1) {
      this.pos = desiredEye;
      this.target = desiredTarget;
    } else {
      const a = 1 - Math.exp(-dt * 4);
      const b = 1 - Math.exp(-dt * 8);
      this.pos = add(this.pos, scale(sub(desiredEye, this.pos), a));
      this.target = add(this.target, scale(sub(desiredTarget, this.target), b));
      // Keep height close to the framing so climbs/dives don't leave the
      // camera staring at the car's belly.
      const y = Math.min(
        Math.max(this.pos[1], desiredEye[1] - 1.5),
        desiredEye[1] + 1.5,
      );
      this.pos = [this.pos[0], y, this.pos[2]];
    }
    this.lastTime = time;
    // Slight roll with the car's bank.
    const up = normalize(
      add([0, 1, 0], scale(sub(pose.up, [0, dot(pose.up, [0, 1, 0]), 0]), 0.4)),
    );
    return {eye: this.pos, target: this.target, up};
  }
}
