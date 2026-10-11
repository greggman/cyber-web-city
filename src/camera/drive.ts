// User-flown car: a relaxed hover-car (not a flight sim). It keeps flying
// forward at a cruise speed, so the driver mostly steers and climbs; the
// speed can be nudged up or down. Glides with inertia; buildings push the
// car away softly (city/inside.ts makeRepelField). Entering takes over from
// the autopilot's pose. Leaving (or 30 s without input) flies the car itself,
// with the same physics and soft walls, to the start of a new tour nearby,
// then eases onto it.
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
  steer: number;
  climb: number;
  /** Raises (+) or lowers (-) the cruise speed while held. */
  speed: number;
}

/**
 * Leads the car back to the autopilot: the point to aim for from a
 * position, or null once it has arrived.
 */
export type Guide = (pos: Vec3) => Vec3 | null;

const ACCEL = 28; // m/s^2, towards the cruise speed
const TOP_SPEED = 80; // m/s
const SPEED_RATE = 25; // m/s per second of holding faster/slower
const LATERAL_DRAG = 1.1; // sideways slip dies away (a little drift)
const TURN_RATE = 1.1; // rad/s at full steer
const TURN_LAG = 0.35; // s for the turn rate to follow the stick
const BANK_LAG = 0.45; // s
const CLIMB_LAG = 0.6; // s
const CLIMB_SPEED = 22; // m/s
const FLOOR = 10;
const CEILING = 650;
const IDLE_RETURN = 30; // s without input before the autopilot takes back
const GUIDE_SPEED = 28; // m/s while flying itself to a new tour
const GUIDE_TIMEOUT = 25; // s, then it just eases onto the route
const BLEND = 1.5; // s to ease onto the route at the end

export class DriveControl {
  active = false;
  private pos: Vec3 = [0, 0, 0];
  private vel: Vec3 = [0, 0, 0];
  private yaw = 0;
  private bank = 0;
  private pitch = 0;
  /** Current turn rate (rad/s, + is left), easing after the input. */
  private turn = 0;
  private idle = 0;
  /** Cruise speed (m/s) the car holds along its heading. */
  private cruise = 0;
  /** Flying itself to a new tour (see exit()). */
  private guide: Guide | null = null;
  private guideTime = 0;
  private wallSide = 0;
  /** Easing onto the autopilot: the pose we left from and progress. */
  private exitPose: CarPose | null = null;
  private exitT = 1;
  repel: ((x: number, y: number, z: number) => Repel) | null = null;
  /** Called when the user's 30 s of idling hands back control. */
  onAutoExit: () => void = () => {};
  /** Called when a guided car arrives and the autopilot takes over. */
  onRejoin: () => void = () => {};

  /** Takes over from the given pose (the autopilot's or our own). */
  enter(from: CarPose) {
    this.active = true;
    this.exitPose = null;
    this.guide = null;
    this.idle = 0;
    this.pos = [...from.position];
    this.vel = scale(from.forward, from.speed);
    this.cruise = Math.min(TOP_SPEED, Math.max(15, from.speed));
    const f = from.forward;
    this.yaw = Math.atan2(-f[0], -f[2]);
    this.pitch = 0;
    this.bank = 0;
    this.turn = 0;
  }

  /**
   * Hands back to the autopilot. With a guide, the car first flies itself
   * (soft walls and all) to where the guide leads, then eases onto the
   * route; without one it eases straight onto it.
   */
  exit(guide: Guide | null = null) {
    if (!this.active) return;
    this.active = false;
    this.guide = guide;
    this.guideTime = 0;
    if (!guide) this.startBlend();
  }

  /** Changes where a car flying itself is heading. */
  retarget(guide: Guide) {
    if (this.guide) this.guide = guide;
  }

  /** Is the car flying itself to a new tour? */
  get rejoining(): boolean {
    return this.guide !== null;
  }

  private startBlend() {
    this.guide = null;
    this.exitPose = this.makePose();
    this.exitT = 0;
  }

  /**
   * Advances the simulation and returns the car pose: the user's while
   * driving, guided while flying to a new tour, then the autopilot's
   * (blended at first).
   */
  update(dt: number, input: DriveInput, auto: CarPose): CarPose {
    if (this.guide) {
      this.guideTime += dt;
      const aim = this.guide(this.pos);
      if (aim && this.guideTime < GUIDE_TIMEOUT) {
        return this.step(dt, this.steerTo(aim), GUIDE_SPEED);
      }
      this.startBlend();
      // The caller starts the new tour here, so ask for its pose again.
      this.onRejoin();
      return this.makePose();
    }
    if (!this.active) {
      if (!this.exitPose || this.exitT >= 1) return auto;
      this.exitT = Math.min(1, this.exitT + dt / BLEND);
      return blendPose(this.exitPose, auto, smooth(this.exitT));
    }
    const any =
      Math.abs(input.speed) + Math.abs(input.steer) + Math.abs(input.climb) >
      0.05;
    this.idle = any ? 0 : this.idle + dt;
    if (this.idle > IDLE_RETURN) {
      this.onAutoExit();
      if (!this.active) return this.update(0, input, auto);
    }
    this.cruise = Math.max(
      0,
      Math.min(TOP_SPEED, this.cruise + input.speed * SPEED_RATE * dt),
    );
    return this.step(dt, input, this.cruise);
  }

  /**
   * Input that turns and climbs toward a point. With a wall in the way it
   * follows the wall (on the side it first chose) until it's clear.
   */
  private steerTo(aim: Vec3): DriveInput {
    let dx = aim[0] - this.pos[0];
    let dz = aim[2] - this.pos[2];
    const rp = this.repel?.(this.pos[0], this.pos[1], this.pos[2]);
    const nl = rp ? Math.hypot(rp.normal[0], rp.normal[2]) : 0;
    if (rp && rp.dist < 9 && nl > 0.5) {
      const nx = rp.normal[0] / nl;
      const nz = rp.normal[2] / nl;
      if (dx * nx + dz * nz < 0) {
        // Along the wall, the way that's nearer the aim, slightly outward.
        this.wallSide ||= dx * -nz + dz * nx >= 0 ? 1 : -1;
        const tx = -nz * this.wallSide;
        const tz = nx * this.wallSide;
        dx = tx + nx * 0.3;
        dz = tz + nz * 0.3;
      } else this.wallSide = 0;
    } else this.wallSide = 0;
    // Heading error, positive when the aim is to the right.
    let err = this.yaw - Math.atan2(-dx, -dz);
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const c = (x: number) => Math.max(-1, Math.min(1, x));
    return {
      steer: c(err * 2),
      climb: c((aim[1] - this.pos[1]) / 25),
      speed: 0,
    };
  }

  /** One physics step at a cruise speed. */
  private step(dt: number, input: DriveInput, cruise: number): CarPose {
    dt = Math.min(dt, 0.05);
    // Heading.
    const speed = Math.hypot(this.vel[0], this.vel[2]);
    // The turn rate follows the stick with a little lag, like a body with
    // momentum, so turns roll in and out instead of starting dead.
    const turnT = -input.steer * TURN_RATE * Math.min(1, 0.35 + speed / 40);
    this.turn += (turnT - this.turn) * (1 - Math.exp(-dt / TURN_LAG));
    this.yaw += this.turn * dt;
    const f: Vec3 = [-Math.sin(this.yaw), 0, -Math.cos(this.yaw)];
    const r: Vec3 = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
    // Speed along the heading eases to the cruise speed; sideways slip is
    // removed.
    let v = this.vel;
    const dv = cruise - dot(v, f);
    v = add(v, scale(f, Math.max(-ACCEL * dt, Math.min(ACCEL * dt, dv))));
    v = sub(v, scale(r, dot(v, r) * Math.min(1, LATERAL_DRAG * dt)));
    // Climb towards a target vertical speed; hover when released.
    const vyT = input.climb * CLIMB_SPEED;
    v[1] += (vyT - v[1]) * (1 - Math.exp(-dt / CLIMB_LAG));
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
    // Floor and ceiling: the closer the car gets, the slower it may sink
    // (or rise) toward them, so it levels off smoothly and never passes
    // through; if it's ever past one (a new city), it eases back.
    const y = this.pos[1];
    v[1] = Math.max(v[1], -Math.max(0, y - FLOOR) * 1.5);
    v[1] = Math.min(v[1], Math.max(0, CEILING - y) * 1.5);
    if (y < FLOOR) v[1] = Math.max(v[1], (FLOOR - y) * 2);
    if (y > CEILING) v[1] = Math.min(v[1], (CEILING - y) * 2);
    this.vel = v;
    this.pos = add(this.pos, scale(v, dt));
    // Body attitude: bank into turns like a coordinated turn (as in
    // flight.ts; positive bank and turn are to the left), so faster and
    // tighter turns lean more; the nose follows climbs and dives.
    const bankT = Math.max(
      -0.6,
      Math.min(0.6, Math.atan((speed * this.turn) / 9.81) * 0.9),
    );
    this.bank += (bankT - this.bank) * (1 - Math.exp(-dt / BANK_LAG));
    const pitchT = Math.atan2(v[1], Math.max(speed, 10)) * 0.7;
    this.pitch += (pitchT - this.pitch) * (1 - Math.exp(-dt / 0.4));
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
