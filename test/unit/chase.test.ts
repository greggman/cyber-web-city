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
    for (let i = 0; i < 600; i++) {
      t += dts[i % dts.length];
      const p = poseAt(t);
      const c = cam.update(p, t, dts[i % dts.length]);
      offsets.push([
        c.eye[0] - p.position[0],
        c.eye[1] - p.position[1],
        c.eye[2] - p.position[2],
      ]);
    }
    return offsets;
  };
  for (const dts of [[1 / 60], [1 / 120], [1 / 120, 1 / 60, 1 / 90, 1 / 40]]) {
    const o = run(dts);
    for (let i = 300; i < o.length; i++) {
      const d = Math.hypot(
        o[i][0] - o[i - 1][0],
        o[i][1] - o[i - 1][1],
        o[i][2] - o[i - 1][2],
      );
      // Only the slow framing sway may move it: well under a centimeter.
      assert.ok(d < 0.01, `offset moved ${d.toFixed(3)} m between frames`);
    }
  }
});
