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
// Inside the car, dragging looks around from the driver's seat (no jump to
// the outside orbit), then eases back.
await withPage('index.html?t=40&mute=1&cam=pov', async page => {
  await page.waitForFunction(() => window.__debug?.orbitActive, {timeout: 60000});
  await sleep(800);
  const view = async () => {
    await page.evaluate(() => (window.__debug.trace = []));
    await sleep(150);
    return page.evaluate(() => {
      const m = window.__debug.trace.at(-1);
      const c = window.__debug.cameraPos();
      const p = window.__debug.carPos;
      const car = window.__debug.pose(window.__stats.time).forward;
      return {fwd: [-m[8], -m[9], -m[10]], car, fromCar: Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2])};
    });
  };
  const angle = (a, b) => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;
  const v0 = await view();
  await page.mouse.move(640, 360);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) {
    await page.mouse.move(640 - k * 25, 360);
    await sleep(30);
  }
  const v1 = await view();
  await page.mouse.up();
  check(
    v1.fromCar < 3 && angle(v0.fwd, v1.fwd) > 30,
    `dragging inside the car looks around (turned ${angle(v0.fwd, v1.fwd).toFixed(0)} deg, ` +
      `camera ${v1.fromCar.toFixed(1)} m from the car)`,
  );
  await sleep(8000);
  const v2 = await view();
  const back = Math.abs(angle(v2.fwd, v2.car) - angle(v0.fwd, v0.car));
  check(v2.fromCar < 3 && back < 4, `...and eases back afterwards (${back.toFixed(1)} deg from where it was)`);
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
// size=WxH: fixed-size canvas, centred, rendering at exactly that size.
await withPage('index.html?t=40&mute=1&size=640x360', async page => {
  const r = await page.evaluate(() => {
    const c = document.getElementById('c');
    const b = c.getBoundingClientRect();
    return {w: c.width, h: c.height, x: b.left, y: b.top, vw: innerWidth, vh: innerHeight};
  });
  check(
    r.w === 640 && r.h === 360 && r.x === (r.vw - 640) / 2 && r.y === (r.vh - 360) / 2,
    `size=640x360 renders 640x360, centred (${JSON.stringify(r)})`,
  );
});
// Every load is a different city (nothing written to the URL); settings
// shows a link that reopens exactly this one.
{
  const links = [];
  for (let k = 0; k < 2; k++) {
    await withPage(
      'index.html?t=40&mute=1',
      async page => {
        await page.click('#ui-gear-btn');
        await sleep(200);
        links.push(await page.$eval('#ui-city-link', a => a.href));
        check(!/seed=/.test(await page.evaluate(() => location.search)), 'URL is left alone');
      },
      {pin: false},
    );
  }
  check(
    links.every(l => /seed=\d+/.test(l) && /theme=\w+/.test(l)) && links[0] !== links[1],
    `new city each load, link in settings (${links.join(' , ')})`,
  );
}
// The globe button and T cycle to the next theme in place: no reload, and
// the music keeps playing.
await withPage('index.html?t=40', async (page, ctx) => {
  const theme = async () => {
    const href = await page.$eval('#ui-city-link', a => a.href);
    return new URL(href).searchParams.get('theme');
  };
  await page.click('#ui-sound-btn');
  await sleep(400);
  const nav = [];
  page.on('framenavigated', () => nav.push(1));
  const a = await theme();
  // Sample the toast every 100 ms until the switch lands.
  await page.evaluate(() => {
    window.__toastLog = [];
    window.__toastTimer = setInterval(() => {
      const el = document.getElementById('ui-toast');
      window.__toastLog.push(el.classList.contains('show') ? el.textContent : '');
    }, 100);
  });
  await page.click('#ui-theme-btn');
  await page.waitForFunction(() => /sodium/.test(document.getElementById('ui-city-link').href), {timeout: 120000});
  const tl = await page.evaluate(() => (clearInterval(window.__toastTimer), window.__toastLog));
  const first = tl.findIndex(x => /Building/.test(x));
  const gaps = tl.slice(first).filter(x => x === '').length;
  check(first >= 0 && gaps === 0, `'Building…' stays up until the switch (${tl.length} samples, ${gaps} blank)`);
  const b = await theme();
  await page.keyboard.press('t');
  await page.waitForFunction(() => /theme=ash/.test(document.getElementById('ui-city-link').href), {timeout: 120000});
  const c = await theme();
  await sleep(1500);
  const playing = await page.evaluate(() => window.__debug.audioRunning());
  check(
    a === 'kowloon' && b === 'sodium' && c === 'ash' && nav.length === 0,
    `globe and T switch themes without reloading (${a} -> ${b} -> ${c}, reloads ${nav.length})`,
  );
  check(playing, 'music keeps playing across theme switches');
  check(ctx.errors.length === 0, `no WebGPU errors while switching (${ctx.errors.slice(0, 2).join(' | ')})`);
});
// Settings lists the cities; picking one switches to it in place, and the
// globe button then carries on from there.
await withPage('index.html?t=40&mute=1', async (page, ctx) => {
  await page.click('#ui-gear-btn');
  await page.click('.ui-cities button[data-city=arcology]');
  await page.waitForFunction(() => /theme=arcology/.test(document.getElementById('ui-city-link').href), {timeout: 120000});
  const pressed = await page.evaluate(() =>
    [...document.querySelectorAll('.ui-cities button[aria-pressed=true]')].map(b => b.dataset.city),
  );
  const open = await page.evaluate(() => !document.getElementById('ui-gear-panel').hidden);
  check(
    pressed.length === 1 && pressed[0] === 'arcology' && !open,
    `settings picks a city and closes (${pressed.join(',')} highlighted, panel open ${open})`,
  );
  await page.click('#ui-theme-btn');
  await page.waitForFunction(() => !/theme=arcology/.test(document.getElementById('ui-city-link').href), {timeout: 120000});
  const after = await page.evaluate(() => new URL(document.getElementById('ui-city-link').href).searchParams.get('theme'));
  check(after === 'dust', `the globe button carries on from the picked city (arcology -> ${after})`);
  check(ctx.errors.length === 0, 'no errors picking cities');
});
// F hands the car to the user; it cruises on by itself, steers and climbs,
// stays out of buildings, and F gives it back: it flies itself (through
// open air, no jumps) to a new tour nearby.
await withPage('index.html?t=40&mute=1', async (page, ctx) => {
  const pos = () => page.evaluate(() => window.__debug.carPos);
  await page.keyboard.press('f');
  const p0 = await pos();
  await page.keyboard.down('d');
  await sleep(1200);
  await page.keyboard.up('d');
  await page.keyboard.down('w');
  await sleep(1500);
  await page.keyboard.up('w');
  await sleep(3000);
  const p1 = await pos();
  const moved = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
  const route = await page.evaluate(() => window.__debug.pose(window.__stats.time).position);
  const off = Math.hypot(p1[0] - route[0], p1[2] - route[2]);
  const clearAt = p => page.evaluate(p => window.__debug.isClear(p[0], p[2], 1, p[1] - 1, p[1] + 1), p);
  const clear = await clearAt(p1);
  const on = await page.evaluate(() => document.getElementById('ui-drive-btn').classList.contains('on'));
  check(
    on && moved > 150 && off > 30 && p1[1] > p0[1] + 10,
    `F takes control; the car cruises, steers and climbs (moved ${moved.toFixed(0)} m, ` +
      `${off.toFixed(0)} m off the route, climbed ${(p1[1] - p0[1]).toFixed(0)} m)`,
  );
  check(clear, `the user-flown car isn't inside a building (${p1.map(v => v.toFixed(0)).join(',')})`);
  await page.keyboard.press('f');
  // Follow it back: never inside a building, no jumps, on a tour in the end.
  let prev = await pos();
  let inside = 0;
  let maxStep = 0;
  let onTour = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 35000 && onTour < 8) {
    await sleep(250);
    const p = await pos();
    const r = await page.evaluate(() => window.__debug.pose(window.__stats.time).position);
    if (!(await clearAt(p))) inside++;
    maxStep = Math.max(maxStep, Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]));
    onTour = Math.hypot(p[0] - r[0], p[2] - r[2]) < 1 ? onTour + 1 : 0;
    prev = p;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  check(onTour >= 8, `F again: the autopilot takes over on a new tour (${secs} s)`);
  check(inside === 0 && maxStep < 30, `...getting there without entering buildings or jumping (inside ${inside}, max step ${maxStep.toFixed(1)} m)`);
  check(ctx.errors.length === 0, 'no errors while flying');
});
// On a phone the wheel shows a touch stick; pushing it up climbs.
await withPage('index.html?t=40&mute=1', async (page, ctx) => {
  await page.setViewport({width: 390, height: 844, isMobile: true, hasTouch: true});
  await page.waitForFunction(() => window.__ready && document.getElementById('ui-drive-btn'), {timeout: 120000});
  await sleep(1500);
  await page.tap('#ui-drive-btn');
  await sleep(300);
  const shown = await page.evaluate(() => !document.getElementById('ui-drive-stick').hidden);
  const p0 = await page.evaluate(() => window.__debug.carPos);
  const [x, y] = await page.evaluate(() => {
    const r = document.getElementById('ui-drive-stick').getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  });
  const cdp = await page.createCDPSession();
  const touch = (type, dy) =>
    cdp.send('Input.dispatchTouchEvent', {type, touchPoints: type === 'touchEnd' ? [] : [{x, y: y - dy}]});
  await touch('touchStart', 0);
  for (let k = 1; k <= 5; k++) {
    await touch('touchMove', k * 12);
    await sleep(30);
  }
  await sleep(3000);
  await touch('touchEnd');
  const p1 = await page.evaluate(() => window.__debug.carPos);
  const climbed = p1[1] - p0[1];
  check(shown && climbed > 20, `touch stick flies the car on a phone (stick shown ${shown}, climbed ${climbed.toFixed(0)} m)`);
  check(ctx.errors.length === 0, 'no errors flying by touch');
});
process.exit(failed ? 1 : 0);
