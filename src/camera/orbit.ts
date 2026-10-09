// User orbit camera: drag (mouse or one finger) orbits the car, wheel or
// pinch zooms. Six seconds after the last input the auto director takes
// over again.
import type {Vec3} from '../math/vec';

const IDLE_MS = 6000;

export class OrbitControl {
  /** Yaw relative to the car's heading, pitch above the horizon (rad). */
  yaw = 0;
  pitch = 0.25;
  dist = 14;
  private lastInput = -Infinity;
  private pointers = new Map<number, [number, number]>();
  private pinch = 0;
  /** Set when a drag starts: seed yaw/pitch/dist from the current camera. */
  private needsSeed = false;
  /** Look-target offset from the car at takeover, eased to zero. */
  private aimOff: Vec3 = [0, 0, 0];
  private aimT0 = 0;
  /** Field of view at takeover (deg), eased to the orbit's own. */
  private fov0 = 55;
  fov = 55;

  constructor(el: HTMLElement) {
    el.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      // (Check before registering the pointer, which makes us active.)
      if (!this.active) this.needsSeed = true;
      this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      this.pinch = 0;
      this.touch();
    });
    el.addEventListener('pointermove', e => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev[0];
      const dy = e.clientY - prev[1];
      this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.pointers.size === 1) {
        this.yaw -= dx * 0.006;
        this.pitch = Math.max(-0.35, Math.min(1.35, this.pitch + dy * 0.004));
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (this.pinch > 0) this.zoom(this.pinch / d);
        this.pinch = d;
      }
      this.touch();
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      this.pinch = 0;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener(
      'wheel',
      e => {
        e.preventDefault();
        if (!this.active) this.needsSeed = true;
        this.zoom(Math.exp(e.deltaY * 0.001));
        this.touch();
      },
      {passive: false},
    );
  }

  /** Hands control back to the auto camera now (e.g. a camera change). */
  release() {
    this.lastInput = -Infinity;
    this.pointers.clear();
  }

  private touch() {
    this.lastInput = performance.now();
  }

  private zoom(k: number) {
    this.dist = Math.max(4, Math.min(90, this.dist * k));
  }

  /** True while the user is in control (input within the last 6 s). */
  get active(): boolean {
    return (
      this.pointers.size > 0 || performance.now() - this.lastInput < IDLE_MS
    );
  }

  /**
   * Camera eye and target orbiting the car. `heading` is the car's yaw;
   * `camEye` is the current camera position, used to start the orbit from
   * wherever the camera was so taking control never jumps.
   */
  update(
    carPos: Vec3,
    heading: number,
    camEye: Vec3,
    camTarget: Vec3,
    camFov: number,
    inside: boolean,
  ): {eye: Vec3; target: Vec3} {
    const base: Vec3 = [carPos[0], carPos[1] + 0.6, carPos[2]];
    if (this.needsSeed) {
      this.needsSeed = false;
      if (inside) {
        // From the cockpit, start from a classic view behind the car.
        this.yaw = 0;
        this.pitch = 0.25;
        this.dist = 14;
        this.aimOff = [0, 0, 0];
        this.fov0 = 55;
      } else {
        // Pick up exactly where the auto camera was: same eye, same aim,
        // same field of view, then ease the aim onto the car.
        const d: Vec3 = [
          camEye[0] - base[0],
          camEye[1] - base[1],
          camEye[2] - base[2],
        ];
        this.dist = Math.max(4, Math.min(90, Math.hypot(...d)));
        this.pitch = Math.asin(Math.max(-1, Math.min(1, d[1] / this.dist)));
        this.yaw = Math.atan2(d[0], d[2]) - heading;
        // Aim point at the same distance along the old view direction.
        const fx = camTarget[0] - camEye[0];
        const fy = camTarget[1] - camEye[1];
        const fz = camTarget[2] - camEye[2];
        const fl = Math.hypot(fx, fy, fz) || 1;
        const aim: Vec3 = [
          camEye[0] + (fx / fl) * this.dist,
          camEye[1] + (fy / fl) * this.dist,
          camEye[2] + (fz / fl) * this.dist,
        ];
        this.aimOff = [aim[0] - base[0], aim[1] - base[1], aim[2] - base[2]];
        this.fov0 = camFov;
      }
      this.aimT0 = performance.now();
    }
    // Ease the takeover offsets out over a second.
    const t = Math.min(1, (performance.now() - this.aimT0) / 1000);
    const k = 1 - t * t * (3 - 2 * t);
    const target: Vec3 = [
      base[0] + this.aimOff[0] * k,
      base[1] + this.aimOff[1] * k,
      base[2] + this.aimOff[2] * k,
    ];
    this.fov = this.fov0 + (55 - this.fov0) * (1 - k);
    const a = heading + this.yaw;
    const cp = Math.cos(this.pitch);
    return {
      eye: [
        base[0] + Math.sin(a) * cp * this.dist,
        base[1] + Math.sin(this.pitch) * this.dist,
        base[2] + Math.cos(a) * cp * this.dist,
      ],
      target,
    };
  }
}
