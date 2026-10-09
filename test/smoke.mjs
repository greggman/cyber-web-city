// Smoke test: load the app, let it run, fail on any WebGPU error or a blank frame.
import fs from 'node:fs';
import {withPage, sleep, measureFps, imageStats} from './harness.mjs';

const pages = process.argv.slice(2);
if (pages.length === 0) {
  pages.push('index.html?seed=1', 'index.html?seed=2&cam=pov&t=20');
}
fs.mkdirSync('out', {recursive: true});
let failed = false;
for (const [i, p] of pages.entries()) {
  await withPage(p, async (page, ctx) => {
    await sleep(4000);
    const shot = `out/smoke-${i}.png`;
    await page.screenshot({path: shot});
    // Check the frame is not blank: count distinct coarse colors.
    const stats = await imageStats(page, fs.readFileSync(shot).toString('base64'));
    const fps = await measureFps(page);
    const hud = await page.evaluate(() => window.__stats ?? null);
    console.log(
      `[smoke] ${p}: load ${ctx.loadSeconds.toFixed(1)}s, fps ${fps.toFixed(1)}, ` +
        `colors ${stats.colors}, mean ${stats.mean.toFixed(1)} -> ${shot}`,
    );
    if (hud) console.log('[smoke] stats', JSON.stringify(hud));
    if (ctx.errors.length) {
      failed = true;
      console.log(`[smoke] FAIL: ${ctx.errors.length} error(s):\n  ` + ctx.errors.slice(0, 8).join('\n  '));
    }
    if (process.env.SMOKE_ALLOW_BLANK !== '1' && stats.colors < 8) {
      failed = true;
      console.log('[smoke] FAIL: frame looks blank');
    }
  });
}
console.log(failed ? '[smoke] FAILED' : '[smoke] PASSED');
process.exit(failed ? 1 : 0);
