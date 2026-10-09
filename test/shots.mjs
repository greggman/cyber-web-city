// Deterministic screenshot set for judging: node test/shots.mjs [outDir] [filter]
import fs from 'node:fs';
import {withPage, sleep, measureFps} from './harness.mjs';

const outDir = process.argv[2] ?? 'out/shots';
const filter = process.argv[3] ?? '';
const SHOTS = [
  ['chase-005', 'cam=chase&t=5'],
  ['chase-030', 'cam=chase&t=30'],
  ['chase-060', 'cam=chase&t=60'],
  ['chase-150', 'cam=chase&t=150'],
  ['pov-010', 'cam=pov&t=10'],
  ['pov-045', 'cam=pov&t=45'],
  ['skyline-020', 'cam=skyline&t=20'],
  ['skyline-200', 'cam=skyline&t=200'],
];
fs.mkdirSync(outDir, {recursive: true});
let failed = false;
const report = [];
for (const [name, q] of SHOTS) {
  if (filter && !name.includes(filter)) continue;
  await withPage(`index.html?seed=1&paused=1&${q}`, async (page, ctx) => {
    await sleep(2500); // let temporal effects converge
    const file = `${outDir}/${name}.png`;
    await page.screenshot({path: file});
    const fps = await measureFps(page, 1500);
    report.push(`${file}  fps=${fps.toFixed(1)}`);
    console.log(`${file}  fps=${fps.toFixed(1)}`);
    if (ctx.errors.length) {
      failed = true;
      console.log('ERRORS:\n  ' + ctx.errors.join('\n  '));
    }
  });
}
fs.writeFileSync(`${outDir}/index.txt`, report.join('\n') + '\n');
process.exit(failed ? 1 : 0);
