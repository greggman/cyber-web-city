import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  invert,
  multiply,
  perspectiveReversedInfinite,
  lookAtCamera,
  transformPoint,
  rotationY,
  translation,
  frustumPlanes,
  type Vec3,
} from '../../src/math/vec';
import {Rng, hashFloat} from '../../src/math/random';

const close = (a: number, b: number, eps = 1e-4) =>
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('invert * m = identity', () => {
  const m = multiply(translation([3, -2, 7]), rotationY(0.7));
  const r = multiply(invert(m), m);
  for (let i = 0; i < 16; i++) {
    close(r[i], i % 5 === 0 ? 1 : 0);
  }
});

test('reversed-Z: near plane maps to depth 1, far toward 0', () => {
  const p = perspectiveReversedInfinite(1, 1.5, 0.1);
  close(transformPoint(p, [0, 0, -0.1])[2], 1);
  assert.ok(transformPoint(p, [0, 0, -1000])[2] < 0.001);
  assert.ok(transformPoint(p, [0, 0, -1000])[2] > 0);
});

test('lookAtCamera looks down -Z toward target', () => {
  const cam = lookAtCamera([0, 0, 10], [0, 0, 0]);
  const view = invert(cam);
  const p = transformPoint(view, [0, 0, 0]);
  close(p[2], -10);
});

test('frustum planes contain a point in front and reject behind', () => {
  const proj = perspectiveReversedInfinite(1, 1, 0.5);
  const view = invert(lookAtCamera([0, 0, 0], [0, 0, -1]));
  const planes = frustumPlanes(multiply(proj, view));
  const inside = (p: Vec3) =>
    planes.every(
      pl => pl[0] * p[0] + pl[1] * p[1] + pl[2] * p[2] + pl[3] >= -1e-4,
    );
  assert.ok(inside([0, 0, -5]));
  assert.ok(inside([0, 0, -5000]));
  assert.ok(!inside([0, 0, 5]));
  assert.ok(!inside([100, 0, -5]));
});

test('Rng is deterministic and uniform-ish', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    const x = a.next();
    assert.equal(x, b.next());
    assert.ok(x >= 0 && x < 1);
    sum += x;
  }
  close(sum / 10000, 0.5, 0.02);
  assert.notEqual(new Rng(1).next(), new Rng(2).next());
  assert.equal(hashFloat(1, 2, 3), hashFloat(1, 2, 3));
});

test('chase framing is defined for any time, including negative', async () => {
  const {shotAt} = await import('../../src/camera/flight');
  for (const t of [-100, -0.01, 0, 21.9, 1e6]) {
    assert.ok(Number.isFinite(shotAt(t).back), `t=${t}`);
  }
  assert.ok(Number.isFinite(shotAt(0, -1).back));
});
