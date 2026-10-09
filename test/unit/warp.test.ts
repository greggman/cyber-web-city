import {test} from 'node:test';
import assert from 'node:assert/strict';
import {warp, unwarp, maxSlope, warpDir} from '../../src/city/warp';

test('warp is invertible and gentle', () => {
  assert.ok(maxSlope() < 0.6, `max slope ${maxSlope()}`);
  for (let i = 0; i < 200; i++) {
    const u = Math.sin(i * 12.9) * 0.5 * 13000;
    const v = Math.cos(i * 7.3) * 0.5 * 13000;
    const [x, z] = warp(u, v);
    const [u2, v2] = unwarp(x, z);
    assert.ok(
      Math.hypot(u - u2, v - v2) < 0.05,
      `round trip error at ${u},${v}`,
    );
  }
  const d = warpDir(100, 200, 1, 0);
  assert.ok(Math.abs(Math.hypot(d[0], d[1]) - 1) < 1e-9);
});
