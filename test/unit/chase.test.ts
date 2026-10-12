import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChaseCamera, type CarPose} from '../../src/camera/flight';
import {mat4, type Vec3} from '../../src/math/vec';

// A car flying straight at 80 m/s.
const poseAt = (t: number): CarPose => ({
  position: [0, 200, -80 * t],
  forward: [0, 0, -1],
  up: [0, 1, 0],
  right: [1, 0, 0],
  speed: 80,
  matrix: mat4(),
});

// The camera's offset from the car must not depend on frame timing, or the
// car shakes on screen when frame times vary (120 Hz / variable refresh).
test('chase camera offset is independent of frame timing', () => {
  const run = (dts: number[]) => {
    const cam = new ChaseCamera();
    cam.fixedShot = 0;
    let t = 10;
    const offsets: Vec3[] = [];
    const steps: number[] = [];
    for (let i = 0; i < 600; i++) {
      const dt = dts[i % dts.length];
      t += dt;
      const p = poseAt(t);
      const c = cam.update(p, t, dt);
      offsets.push([
        c.eye[0] - p.position[0],
        c.eye[1] - p.position[1],
        c.eye[2] - p.position[2],
      ]);
      steps.push(dt);
    }
    return {offsets, steps};
  };
  for (const dts of [[1 / 60], [1 / 120], [1 / 120, 1 / 60, 1 / 90, 1 / 40]]) {
    const {offsets: o, steps} = run(dts);
    // The offset drifts slowly on purpose (the chase car wanders), so check
    // its velocity: slow, and smooth from frame to frame whatever the frame
    // times (frame-time jitter would show up as velocity jumps).
    const vel = (i: number): Vec3 => [
      (o[i][0] - o[i - 1][0]) / steps[i],
      (o[i][1] - o[i - 1][1]) / steps[i],
      (o[i][2] - o[i - 1][2]) / steps[i],
    ];
    for (let i = 300; i < o.length; i++) {
      const v = vel(i);
      const w = vel(i - 1);
      const speed = Math.hypot(...v);
      const jump = Math.hypot(v[0] - w[0], v[1] - w[1], v[2] - w[2]);
      assert.ok(speed < 3, `offset moving ${speed.toFixed(2)} m/s`);
      assert.ok(jump < 0.2, `offset velocity jumped ${jump.toFixed(3)} m/s`);
    }
  }
});

// While the user flies, the camera is a steady rear chase, whatever the
// director would be showing (here its side-tracking framing).
test('flying yourself gives a rear chase camera', () => {
  const cam = new ChaseCamera();
  cam.driving = true;
  const t0 = 3 * 22 + 2; // the director's side shot
  let c = cam.update(poseAt(t0), t0, 1 / 60);
  for (let i = 1; i <= 300; i++) {
    const t = t0 + i / 60;
    c = cam.update(poseAt(t), t, 1 / 60);
  }
  const p = poseAt(t0 + 5).position;
  const rel = [c.eye[0] - p[0], c.eye[1] - p[1], c.eye[2] - p[2]];
  // Car heads -z: behind is +z.
  assert.ok(rel[2] > 8, `not behind the car (${rel.map(v => v.toFixed(1))})`);
  assert.ok(Math.abs(rel[0]) < 1, `off to the side (${rel[0].toFixed(2)} m)`);
});
