import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateCity} from '../../src/city/generate';

test('many building roofs are marked exposed for rooftop kitbash', () => {
  const city = generateCity(1);
  let exposed = 0;
  let area = 0;
  for (let i = 0; i < city.segments.count; i++) {
    const g = city.segments.get(i);
    if (g.flags & 32) {
      exposed++;
      area += g.sx * g.sz * g.taper * g.taper;
    }
  }
  console.log(
    `exposed roofs: ${exposed} of ${city.segments.count}, area ${(area / 1e6).toFixed(2)} km^2`,
  );
  assert.ok(exposed > 5000, `only ${exposed} exposed roofs`);
});
