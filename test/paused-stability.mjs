// With time paused, the image must not change between frames (no blinking
// from nondeterministic GPU work). Counts pixels that change sharply between
// two screenshots of the same paused frame: node test/paused-stability.mjs
import {withPage, sleep} from './harness.mjs';

const VIEWS = ['cam=chase&t=60', 'cam=roof&n=40&t=20', 'cam=cable&n=3&t=20'];
const MAX = 200;
let failed = false;
for (const q of VIEWS) {
  await withPage(`index.html?paused=1&taa=0&rain=0&${q}`, async page => {
    await sleep(1500);
    const a = await page.screenshot({encoding: 'base64'});
    await sleep(700);
    const b = await page.screenshot({encoding: 'base64'});
    const n = await page.evaluate(
      async ([a, b]) => {
        const load = async s => {
          const i = new Image();
          i.src = 'data:image/png;base64,' + s;
          await i.decode();
          const c = new OffscreenCanvas(i.width, i.height);
          const g = c.getContext('2d');
          g.drawImage(i, 0, 0);
          return g.getImageData(0, 0, i.width, i.height).data;
        };
        const A = await load(a);
        const B = await load(b);
        let n = 0;
        for (let i = 0; i < A.length; i += 4) {
          const d =
            Math.abs(A[i] - B[i]) +
            Math.abs(A[i + 1] - B[i + 1]) +
            Math.abs(A[i + 2] - B[i + 2]);
          if (d > 120) n++;
        }
        return n;
      },
      [a, b],
    );
    const ok = n <= MAX;
    if (!ok) failed = true;
    console.log(`${ok ? '✔' : '✘'} ${q}: ${n} pixels changed while paused`);
  });
}
process.exit(failed ? 1 : 0);
