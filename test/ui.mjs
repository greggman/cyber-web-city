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
// Sound starts on the first touch (mobile browsers only unlock audio on a
// gesture).
await withPage('index.html?t=40', async page => {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.__debug?.audioRunning, {timeout: 60000});
  await sleep(500);
  const before = await page.evaluate(() => window.__debug.audioRunning());
  await page.touchscreen.tap(640, 400);
  await sleep(500);
  const after = await page.evaluate(() => window.__debug.audioRunning());
  check(!before && after, `sound starts on touch (before ${before}, after ${after})`);
});
// Dragging orbits the car; 6 s after the last input the auto camera
// takes over again.
await withPage('index.html?t=40&mute=1', async page => {
  await page.waitForFunction(() => window.__debug?.orbitActive, {timeout: 60000});
  await sleep(800);
  const p0 = await page.evaluate(() => window.__debug.cameraPos());
  // Grabbing the camera must not make the view jump.
  await page.evaluate(() => (window.__debug.trace = []));
  await sleep(300);
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await sleep(300);
  const tr = await page.evaluate(() => window.__debug.trace);
  let maxTurn = 0;
  for (let k = 1; k < tr.length; k++) {
    const a = tr[k - 1].slice(8, 11), b = tr[k].slice(8, 11);
    const d = Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
    maxTurn = Math.max(maxTurn, (Math.acos(d) * 180) / Math.PI);
  }
  check(maxTurn < 2, `taking control doesn't snap the view (max ${maxTurn.toFixed(2)} deg/frame)`);
  for (let k = 1; k <= 10; k++) {
    await page.mouse.move(640 + k * 30, 360 - k * 8);
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(300);
  const on = await page.evaluate(() => window.__debug.orbitActive());
  const p1 = await page.evaluate(() => window.__debug.cameraPos());
  await page.screenshot({path: 'out/ui/orbit.png'});
  check(on, 'drag takes control (orbit active)');
  // C (like the camera button) switches camera even while orbiting.
  const cam0 = await page.evaluate(() => window.__ui.camera);
  await page.keyboard.press('c');
  await sleep(200);
  const cam1 = await page.evaluate(() => window.__ui.camera);
  const still = await page.evaluate(() => window.__debug.orbitActive());
  check(cam1 !== cam0 && !still, `C switches camera at once while orbiting (${cam0} -> ${cam1}, orbit ${still})`);
  // Back to orbit for the 6 s hand-back check below.
  await page.keyboard.press('c');
  await page.keyboard.press('c');
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.mouse.move(700, 350);
  await page.mouse.up();
  await sleep(7000);
  const off = await page.evaluate(() => window.__debug.orbitActive());
  check(!off, 'auto camera resumes 6 s after the last input');
  void p0;
  void p1;
});
// Startup shows progress for both city generation and shader compiles.
await withPage('index.html?t=40&mute=1', async page => {
  const log = await page.evaluate(() => window.__loadLog);
  const gen = log.filter(m => /Generating city \d+%/.test(m));
  const sh = log.filter(m => /Compiling shaders \d+\/\d+/.test(m));
  const last = sh.at(-1)?.match(/(\d+)\/(\d+)/);
  check(gen.length >= 3, `city generation progress shown (${gen.length} updates)`);
  check(
    sh.length >= 3 && last && last[1] === last[2],
    `shader compile progress shown (${sh.length} updates, last "${last?.[0]}")`,
  );
  const s = await page.evaluate(() => window.__stats.startupMs);
  console.log(`  startup ${Math.round(s.total)} ms (city arrived ${Math.round(s.cityArrived)}, shaders static ${Math.round(s.static)})`);
});
// Sound button: starts showing off; a click starts the sound, another
// turns it off.
await withPage('index.html?t=40', async page => {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.__debug?.audioRunning, {timeout: 60000});
  await sleep(500);
  const state = () =>
    page.evaluate(() => ({
      off: document.getElementById('ui-sound-btn')?.classList.contains('off'),
      shown: (document.getElementById('ui-sound-btn')?.getBoundingClientRect().width ?? 0) > 0,
      running: window.__debug.audioRunning(),
    }));
  const s0 = await state();
  check(s0.shown && s0.off && !s0.running, `sound button visible and off at start (${JSON.stringify(s0)})`);
  await page.screenshot({path: 'out/ui/sound-off.png'});
  await page.click('#ui-sound-btn');
  await sleep(400);
  const s1 = await state();
  check(!s1.off && s1.running, `one click starts the sound (${JSON.stringify(s1)})`);
  await page.screenshot({path: 'out/ui/sound-on.png'});
  await page.click('#ui-sound-btn');
  await sleep(400);
  const s2 = await state();
  check(s2.off, `second click turns it off (${JSON.stringify(s2)})`);
});
// The settings button toggles: a second click closes the panel.
await withPage('index.html?t=40&mute=1', async page => {
  const open = () => page.evaluate(() => !document.getElementById('ui-gear-panel').hidden);
  await page.click('#ui-gear-btn');
  await sleep(200);
  const a = await open();
  await page.click('#ui-gear-btn');
  await sleep(200);
  const b = await open();
  check(a && !b, `settings button opens then closes the panel (${a} -> ${b})`);
});
process.exit(failed ? 1 : 0);
