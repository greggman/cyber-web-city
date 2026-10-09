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

  await page.click('#ui-cam-btn');
  await sleep(300);
  check(await page.$eval('#ui-cam-panel', e => !e.hidden), 'camera menu opens');
  await page.screenshot({path: 'out/ui/1-camera-menu.png'});
  const items = await page.$$('#ui-cam-panel .ui-item');
  check(items.length === 9, `camera menu has 9 choices (${items.length})`);
  const cockpit = (await Promise.all(items.map(async i => [i, await i.evaluate(e => e.textContent)]))).find(([, t]) => t === 'Cockpit')[0];
  await cockpit.click();
  await sleep(800);
  check(await cockpit.evaluate(e => e.getAttribute('aria-checked') === 'true'), 'cockpit marked selected');
  await page.mouse.click(640, 400); // click outside closes
  await sleep(200);
  check(await page.$eval('#ui-cam-panel', e => e.hidden), 'clicking outside closes the menu');
  await sleep(1500);
  await page.screenshot({path: 'out/ui/2-cockpit.png'});

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
  await page.click('#ui-cam-btn');
  await sleep(300);
  const sel = await page.$$eval('#ui-cam-panel .ui-item[aria-checked="true"]', es => es.map(e => e.textContent));
  check(sel.length === 1 && sel[0] === 'Low & close', `key 2 selects 'Low & close' (${sel})`);
  check(ctx.errors.length === 0, `no WebGPU/page errors (${ctx.errors.slice(0, 2)})`);
});
process.exit(failed ? 1 : 0);
