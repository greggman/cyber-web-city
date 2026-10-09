import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateCity} from '../../src/city/generate';
import {generateSigns} from '../../src/city/signs';
import {makeInsideTest} from '../../src/city/inside';

// Signs must not sit inside buildings (z-fighting with walls, buried in
// bolted-on pieces) or cut through each other.
test('signs are not buried in buildings or stacked on each other', () => {
  const city = generateCity(1);
  const inside = makeInsideTest(city.segments);
  const {signs} = generateSigns(1, city.slots, inside);
  let buried = 0;
  for (const s of signs) {
    for (const [a, b] of [
      [0, 0],
      [-0.4, -0.4],
      [0.4, 0.4],
    ]) {
      const x = s.pos[0] + s.right[0] * a * s.width + s.normal[0] * 0.05;
      const z = s.pos[2] + s.right[2] * a * s.width + s.normal[2] * 0.05;
      if (inside(x, s.pos[1] + b * s.height, z) >= 0) {
        buried++;
        break;
      }
    }
  }
  assert.ok(
    buried / signs.length < 0.002,
    `${buried} of ${signs.length} signs buried`,
  );
  // Two signs crossing in one plane: centres within each other's slab.
  const grid = new Map<string, number[]>();
  signs.forEach((s, i) => {
    const k = `${Math.floor(s.pos[0] / 10)},${Math.floor(s.pos[2] / 10)}`;
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(i);
  });
  let crossed = 0;
  signs.forEach((s, i) => {
    const k = `${Math.floor(s.pos[0] / 10)},${Math.floor(s.pos[2] / 10)}`;
    for (const j of grid.get(k)!) {
      if (j <= i) continue;
      const t = signs[j];
      const dx = t.pos[0] - s.pos[0];
      const dz = t.pos[2] - s.pos[2];
      const depth = Math.abs(dx * s.normal[0] + dz * s.normal[2]);
      const along = Math.abs(dx * s.right[0] + dz * s.right[2]);
      if (
        depth < 0.1 &&
        along < s.width / 2 &&
        Math.abs(t.pos[1] - s.pos[1]) < s.height / 2
      ) {
        crossed++;
      }
    }
  });
  assert.equal(crossed, 0, `${crossed} sign pairs share a plane`);
});
