// Renders the car preview from several views into out/car/.
//   node test/car-shots.mjs [model] [views...]
import fs from 'node:fs';
import {withPage, sleep} from './harness.mjs';

const model = process.argv[2] ?? 'spinner';
const defaultViews = [
  'three-quarter:studio',
  'side:studio',
  'front:studio',
  'rear-three-quarter:studio',
  'top:studio',
  'three-quarter:city',
  'interior:studio',
  'pov:city',
];
const views = process.argv.length > 3 ? process.argv.slice(3) : defaultViews;
fs.mkdirSync('out/car', {recursive: true});
let failed = false;
for (const v of views) {
  const [view, env = 'studio', extra = ''] = v.split(':');
  const q = `car-preview.html?model=${model}&view=${view}&env=${env}${extra ? '&' + extra : ''}`;
  await withPage(q, async (page, ctx) => {
    await sleep(1000);
    const file = `out/car/${model}-${view}-${env}${extra ? '-' + extra.replace(/[=&]/g, '') : ''}.png`;
    await page.screenshot({path: file});
    const stats = await page.evaluate(() => window.__stats ?? null);
    console.log(`${file}  tris=${stats?.triangles}`);
    if (ctx.errors.length) {
      failed = true;
      console.log('ERRORS:\n  ' + ctx.errors.join('\n  '));
    }
  });
}
process.exit(failed ? 1 : 0);
