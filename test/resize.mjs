// Resizes the window repeatedly while rendering; fails on any WebGPU error.
import {withPage, sleep} from './harness.mjs';

let failed = false;
await withPage('index.html?t=40&mute=1', async (page, ctx) => {
  const sizes = [
    [800, 600],
    [1280, 720],
    [640, 900],
    [1920, 1080],
    [333, 777],
    [1281, 721],
    [1000, 1000],
  ];
  for (let k = 0; k < 3; k++) {
    for (const [width, height] of sizes) {
      await page.setViewport({width, height});
      await sleep(120);
    }
  }
  // A burst of tiny steps, like dragging a window edge.
  for (let w = 900; w < 1000; w += 7) {
    await page.setViewport({width: w, height: 700});
    await sleep(16);
  }
  await sleep(1000);
  const errs = ctx.errors;
  if (errs.length) {
    failed = true;
    console.log(
      '✖ WebGPU errors while resizing:\n  ' +
        [...new Set(errs)].slice(0, 8).join('\n  '),
    );
  } else {
    console.log('✔ no WebGPU errors while resizing');
  }
});
process.exit(failed ? 1 : 0);
