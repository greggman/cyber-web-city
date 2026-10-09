// Measures how smooth the autopilot is: peak yaw rate, yaw acceleration,
// lateral g and bank rate along the whole route (sampled at 60 Hz).
import {withPage} from './harness.mjs';
const seed = process.argv[2] ?? '1';
await withPage(`index.html?paused=1&seed=${seed}`, async page => {
  const r = await page.evaluate(() => {
    const d = window.__debug;
    const dt = 1 / 60;
    const yaw = f => Math.atan2(f[0], f[2]);
    const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
    const bankOf = p => Math.asin(Math.max(-1, Math.min(1, p.right[1])));
    let prev = d.pose(0), prevRate = 0, prevBank = bankOf(prev);
    const rates = [], accs = [], banks = [], lat = [];
    for (let t = dt; t < Math.min(d.duration, 1500); t += dt) {
      const p = d.pose(t);
      const rate = wrap(yaw(p.forward) - yaw(prev.forward)) / dt;
      rates.push(Math.abs(rate));
      accs.push(Math.abs(rate - prevRate) / dt);
      const b = bankOf(p);
      banks.push(Math.abs(b - prevBank) / dt);
      lat.push(Math.abs(rate * p.speed) / 9.81);
      prev = p; prevRate = rate; prevBank = b;
    }
    const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * f)]; };
    const deg = 180 / Math.PI;
    const raw = {lat: q(lat, 0.999), acc: q(accs, 0.99) * deg, bank: q(banks, 0.999) * deg};
    return {
      raw,
      yawRateMax: (q(rates, 0.999) * deg).toFixed(1) + '°/s',
      yawAccelP99: (q(accs, 0.99) * deg).toFixed(0) + '°/s²',
      yawAccelMax: (q(accs, 0.999) * deg).toFixed(0) + '°/s²',
      lateralG: q(lat, 0.999).toFixed(2) + ' g',
      bankRateMax: (q(banks, 0.999) * deg).toFixed(1) + '°/s',
    };
  });
  const {raw, ...shown} = r;
  console.log(JSON.stringify(shown));
  // Regression limits (the old spline autopilot measured 3.3 g, 335°/s², 142°/s).
  if (raw.lat > 0.6 || raw.acc > 60 || raw.bank > 30) {
    console.log('✖ autopilot is not smooth enough');
    process.exitCode = 1;
  }
});
