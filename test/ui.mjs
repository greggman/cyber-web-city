// Drives the camera and settings menus like a user and checks the effects.
import fs from 'node:fs';
import {withPage, sleep} from './harness.mjs';

fs.mkdirSync('out/ui', {recursive: true});
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? '✔' : '✖'} ${msg}`);
  if (!ok) failed = true;
};
await withPage('index.html?t=40&mute=1', async (page, ctx) => {
  await page.evaluate(() => localStorage.clear());
  await sleep(1500);
  check(await page.$eval('#ui-cam-btn', e => getComputedStyle(e).display !== 'none'), 'camera button visible');
  check(await page.$eval('#ui-gear-btn', e => getComputedStyle(e).display !== 'none'), 'gear button visible');
  await page.screenshot({path: 'out/ui/0-closed.png'});

  const camera = () => page.evaluate(() => window.__ui.camera);
  check((await camera()) === 0, 'starts in chase camera');
  check((await page.$('#ui-cam-panel')) === null, 'camera button has no dropdown');
  for (const [want, name] of [[1, 'Cockpit'], [2, 'Skyline'], [0, 'Chase']]) {
    await page.click('#ui-cam-btn');
    await sleep(250);
    const toast = await page.$eval('#ui-toast', e => e.textContent);
    check((await camera()) === want && toast === `${name} camera`, `click cycles to ${name} (toast "${toast}")`);
    if (want === 1) {
      await sleep(1200);
      await page.screenshot({path: 'out/ui/2-cockpit.png'});
    }
  }
  await page.keyboard.press('c');
  await sleep(200);
  check((await camera()) === 1, 'C key cycles too');
  const css = await page.evaluate(() => {
    const b = getComputedStyle(document.body);
    return {
      sel: b.userSelect || b.webkitUserSelect,
      touch: b.touchAction,
      meta: document.querySelector('meta[name=viewport]').content,
    };
  });
  check(css.sel === 'none' && css.touch === 'none' && /user-scalable=no/.test(css.meta), `zoom and selection disabled (${JSON.stringify(css)})`);
  await page.click('#ui-gear-btn');
  await sleep(300);
  check(await page.$eval('#ui-gear-panel', e => !e.hidden), 'settings panel opens');
  await page.click('#ui-hud');
  await page.$eval('#ui-rain', e => { e.value = '0'; e.dispatchEvent(new Event('input')); });
  await sleep(800);
  await page.screenshot({path: 'out/ui/3-settings.png'});
  check(await page.$eval('#hud', e => e.textContent.length > 0), 'stats overlay toggled on');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cyber-web-city/settings') ?? '{}'));
  check(saved.hud === true && saved.rain === 0, 'settings persisted');
  await page.keyboard.press('Escape');
  await page.keyboard.press('2');
  await sleep(300);
  const st = await page.evaluate(() => window.__ui);
  check(st.camera === 0 && st.shot === 1, `key 2 picks chase framing 2 (${st.camera}/${st.shot})`);
  check(ctx.errors.length === 0, `no WebGPU/page errors (${ctx.errors.slice(0, 2)})`);
});
process.exit(failed ? 1 : 0);
