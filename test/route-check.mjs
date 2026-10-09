// Flies the whole autopilot route and reports any point where the car
// (a 6 m radius around it) intersects a building segment.
import {withPage} from './harness.mjs';
const seed = process.argv[2] ?? '1';
await withPage(`index.html?paused=1&seed=${seed}`, async page => {
  const r = await page.evaluate(() => {
    const d = window.__debug;
    const hits = [];
    let n = 0;
    for (let t = 0; t < d.duration; t += 0.5) {
      const p = d.pose(t).position;
      n++;
      if (!d.isClear(p[0], p[2], 6, p[1] - 3, p[1] + 3)) hits.push([t, p.map(Math.round)]);
    }
    return {samples: n, hits: hits.length, first: hits.slice(0, 10)};
  });
  console.log(JSON.stringify(r));
  if (r.hits) process.exitCode = 1;
});
