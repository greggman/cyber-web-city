// User-flown car: a relaxed hover-car (not a flight sim). Throttle, steer
// and climb drive a glide with inertia and drag; buildings push the car away
// softly (city/inside.ts makeRepelField). Entering takes over from the
// autopilot's pose; leaving (or 30 s without input) eases back onto it.
import {
  add,
  cross,
  dot,
  fromBasis,
  normalize,
  rotateAround,
  scale,
  sub,
  type Vec3,
} from '../math/vec';
import type {CarPose} from './flight';
import type {Repel} from '../city/inside';

/** Driver input, each in [-1, 1]. */
export interface DriveInput {
  throttle: number;
  steer: number;
  climb: number;
}

const ACCEL = 28; // m/s^2 at full throttle
const DRAG = ACCEL / 80; // top speed ~80 m/s
const LATERAL_DRAG = 2.5; // sideways slip dies quickly
const TURN_RATE = 1.1; // rad/s at full steer
const CLIMB_SPEED = 22; // m/s
const FLOOR = 10;
const CEILING = 650;
const IDLE_RETURN = 30; // s without input before the autopilot takes back
const BLEND = 3; // s to ease back onto the route

export class DriveControl {
  active = false;
  private pos: Vec3 = [0, 0, 0];
  private vel: Vec3 = [0, 0, 0];
  private yaw = 0;
  private bank = 0;
  private pitch = 0;
  private idle = 0;
  /** Easing back to the autopilot: the pose we left from and progress. */
  private exitPose: CarPose | null = null;
  private exitT = 1;
  repel: ((x: number, y: number, z: number) => Repel) | null = null;
  /** Called when control returns to the autopilot by itself. */
  onAutoExit: () => void = () => {};

  /** Takes over from the given pose (the autopilot's current one). */
  enter(from: CarPose) {
    this.active = true;
    this.exitPose = null;
    this.idle = 0;
    this.pos = [...from.position];
    this.vel = scale(from.forward, from.speed);
    const f = from.forward;
    this.yaw = Math.atan2(-f[0], -f[2]);
    this.pitch = 0;
    this.bank = 0;
  }

  /** Hands back to the autopilot, easing over a few seconds. */
  exit() {
    if (!this.active) return;
    this.active = false;
    this.exitPose = this.makePose();
    this.exitT = 0;
  }

  /**
   * Advances the simulation and returns the car pose: the user's while
   * driving, the autopilot's otherwise, blended while handing back.
   */
  update(dt: number, input: DriveInput, auto: CarPose): CarPose {
    if (!this.active) {
      if (!this.exitPose || this.exitT >= 1) return auto;
      this.exitT = Math.min(1, this.exitT + dt / BLEND);
      return blendPose(this.exitPose, auto, smooth(this.exitT));
    }
    const any =
      Math.abs(input.throttle) + Math.abs(input.steer) + Math.abs(input.climb) >
      0.05;
    this.idle = any ? 0 : this.idle + dt;
    if (this.idle > IDLE_RETURN) {
      this.exit();
      this.onAutoExit();
      return auto;
    }
    dt = Math.min(dt, 0.05);
    // Heading.
    const speed = Math.hypot(this.vel[0], this.vel[2]);
    this.yaw -= input.steer * TURN_RATE * Math.min(1, 0.35 + speed / 40) * dt;
    const f: Vec3 = [-Math.sin(this.yaw), 0, -Math.cos(this.yaw)];
    const r: Vec3 = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
    // Thrust along the heading, drag, and sideways slip removal.
    let v = this.vel;
    v = add(v, scale(f, input.throttle * ACCEL * dt));
    v = sub(v, scale(v, DRAG * dt));
    v = sub(v, scale(r, dot(v, r) * Math.min(1, LATERAL_DRAG * dt)));
    // Climb towards a target vertical speed; hover when released.
    const vyT = input.climb * CLIMB_SPEED;
    v[1] += (vyT - v[1]) * Math.min(1, 3 * dt);
    // Soft walls: buildings push away, and motion into a close wall is
    // damped so the car slides along it instead of stopping dead.
    if (this.repel) {
      const rp = this.repel(this.pos[0], this.pos[1], this.pos[2]);
      v = add(v, scale(rp.push, dt));
      // Speed into a near wall is removed, gradually from 8 m out and fully
      // at the surface, so the car slides along instead of entering.
      const into = dot(v, rp.normal);
      if (into < 0 && rp.dist < 8) {
        const k = Math.min(1, Math.max(0, (8 - rp.dist) / 8) ** 0.5);
        v = sub(v, scale(rp.normal, into * k));
      }
      // If it ever ends up inside (e.g. a new city), ease it back out.
      if (rp.dist < 0) {
        this.pos = add(
          this.pos,
          scale(rp.normal, -rp.dist * Math.min(1, 8 * dt)),
        );
      }
    }
    // Floor and ceiling (soft).
    if (this.pos[1] < FLOOR) v[1] += (FLOOR - this.pos[1]) * 4 * dt;
    if (this.pos[1] > CEILING) v[1] -= (this.pos[1] - CEILING) * 4 * dt;
    this.vel = v;
    this.pos = add(this.pos, scale(v, dt));
    // Body attitude: bank into turns, nose follows climb a little.
    const bankT = Math.max(
      -0.5,
      Math.min(0.5, input.steer * (speed / 80) * 0.6),
    );
    this.bank += (bankT - this.bank) * Math.min(1, 3 * dt);
    const pitchT = Math.atan2(v[1], Math.max(speed, 10)) * 0.5;
    this.pitch += (pitchT - this.pitch) * Math.min(1, 3 * dt);
    return this.makePose();
  }

  private makePose(): CarPose {
    const cp = Math.cos(this.pitch);
    const fwd = normalize([
      -Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cp,
    ]);
    const right0 = normalize(cross(fwd, [0, 1, 0]));
    let up = cross(right0, fwd);
    up = rotateAround(up, fwd, -this.bank);
    const right = normalize(cross(fwd, up));
    const up2 = cross(right, fwd);
    return {
      position: [...this.pos],
      forward: fwd,
      up: up2,
      right,
      speed: Math.hypot(this.vel[0], this.vel[1], this.vel[2]),
      matrix: fromBasis(right, up2, scale(fwd, -1), [...this.pos]),
    };
  }
}

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

function blendPose(a: CarPose, b: CarPose, t: number): CarPose {
  const lerp = (p: Vec3, q: Vec3): Vec3 => [
    p[0] + (q[0] - p[0]) * t,
    p[1] + (q[1] - p[1]) * t,
    p[2] + (q[2] - p[2]) * t,
  ];
  const position = lerp(a.position, b.position);
  const fwd = normalize(lerp(a.forward, b.forward));
  const up0 = normalize(lerp(a.up, b.up));
  const right = normalize(cross(fwd, up0));
  const up = cross(right, fwd);
  return {
    position,
    forward: fwd,
    up,
    right,
    speed: a.speed + (b.speed - a.speed) * t,
    matrix: fromBasis(right, up, scale(fwd, -1), position),
  };
}
