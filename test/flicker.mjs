// Measures how many screen pixels change sharply between two nearby times
// with a frozen camera (hud off, taa off, rain off) — i.e. blinking lights.
import fs from 'node:fs';
import {withPage, sleep} from './harness.mjs';
const shots = [];
for (const t of [90.0, 90.35]) {
  await withPage(`index.html?paused=1&cam=chase&shot=4&t=90&taa=0&rain=0&anim=${t}`, async page => {
    await sleep(1500);
    shots.push((await page.screenshot({encoding: 'base64'})));
  });
}
await withPage('index.html?paused=1', async page => {
  const r = await page.evaluate(async ([a, b]) => {
    const load = async s => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
    const A = await load(a), B = await load(b);
    let n = 0;
    for (let i = 0; i < A.length; i += 4) {
      const d = Math.abs(A[i] - B[i]) + Math.abs(A[i+1] - B[i+1]) + Math.abs(A[i+2] - B[i+2]);
      if (d > 120) n++;
    }
    return n;
  }, shots);
  console.log('pixels changing sharply:', r);
});
