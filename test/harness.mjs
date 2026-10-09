// Shared puppeteer harness: serves dist/, opens pages, collects console
// output and WebGPU errors, and retries when headless Chrome's compositor
// stalls (rAF stops ticking), which has been seen with WebGPU in headless mode.
import puppeteer from 'puppeteer';
import {startServer} from '../server.mjs';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Runs `fn(page, ctx)` against `pagePath` (e.g. "index.html?seed=1").
 * ctx.errors collects any `[WebGPU]` errors and page errors.
 */
export async function withPage(pagePath, fn, opts = {}) {
  const {width = 1280, height = 720, readyTimeout = 120000, attempts = 4} = opts;
  const server = await startServer(0);
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const browser = await puppeteer.launch({protocolTimeout: 180000});
      try {
        const page = await browser.newPage();
        await page.setViewport({width, height});
        await page.evaluateOnNewDocument(() => {
          const raf = window.requestAnimationFrame.bind(window);
          (function tick() {
            window.__ticks = (window.__ticks || 0) + 1;
            raf(tick);
          })();
          // Record every loading message (startup progress tests).
          window.__loadLog = [];
          document.addEventListener('DOMContentLoaded', () => {
            const el = document.getElementById('loadmsg');
            if (!el) return;
            new MutationObserver(() => window.__loadLog.push(el.textContent)).observe(
              el,
              {childList: true, characterData: true, subtree: true},
            );
          });
        });
        const ctx = {errors: [], logs: []};
        page.on('console', msg => {
          const text = msg.text();
          if (/\[WebGPU/.test(text)) {
            ctx.errors.push(text);
          }
          ctx.logs.push(`[${msg.type()}] ${text}`);
          const n = (ctx.printed = (ctx.printed ?? 0) + 1);
          if (n === 21) console.log('[harness] (further page messages suppressed)');
          if (n <= 20 && (opts.verbose || msg.type() === 'error' || msg.type() === 'warn')) {
            console.log(`[page:${msg.type()}] ${text.slice(0, 2000)}`);
          }
        });
        page.on('pageerror', e => {
          ctx.errors.push(`pageerror: ${e.message}`);
          console.log(`[pageerror] ${e.message}`);
        });
        const url = `http://localhost:${server.port}/${pagePath}`;
        await page.goto(url);
        const t0 = Date.now();
        let status = '';
        while (Date.now() - t0 < readyTimeout) {
          status = await page.evaluate(() =>
            window.__ready
              ? 'Ready'
              : document.getElementById('loadmsg')?.textContent ?? '',
          );
          if (status === 'Ready' || /Failed/.test(status)) {
            break;
          }
          await sleep(250);
        }
        ctx.loadSeconds = (Date.now() - t0) / 1000;
        ctx.status = status;
        if (status !== 'Ready') {
          ctx.errors.push(`page did not become ready: "${status}"`);
          return await fn(page, ctx);
        }
        const a = await page.evaluate(() => window.__ticks);
        await sleep(1500);
        const b = await page.evaluate(() => window.__ticks);
        if (b - a < 3) {
          console.log(`[harness] compositor stalled (attempt ${attempt}), retrying`);
          continue;
        }
        return await fn(page, ctx);
      } finally {
        await browser.close();
      }
    }
    throw new Error('compositor stalled on every attempt');
  } finally {
    await server.close();
  }
}

/** Measures rAF rate over `ms`. */
export function measureFps(page, ms = 2000) {
  return page.evaluate(
    ms =>
      new Promise(r => {
        let n = 0;
        const t0 = performance.now();
        const f = () => {
          n++;
          if (performance.now() - t0 < ms) requestAnimationFrame(f);
          else r(n / ((performance.now() - t0) / 1000));
        };
        requestAnimationFrame(f);
      }),
    ms,
  );
}

/** Counts coarse distinct colors / mean brightness of a PNG (base64). */
export function imageStats(page, pngBase64) {
  return page.evaluate(async b64 => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const oc = new OffscreenCanvas(128, 72);
    const g = oc.getContext('2d');
    g.drawImage(img, 0, 0, 128, 72);
    const d = g.getImageData(0, 0, 128, 72).data;
    const set = new Set();
    let sum = 0;
    for (let j = 0; j < d.length; j += 4) {
      set.add(((d[j] >> 4) << 8) | ((d[j + 1] >> 4) << 4) | (d[j + 2] >> 4));
      sum += d[j] + d[j + 1] + d[j + 2];
    }
    return {colors: set.size, mean: sum / (d.length / 4) / 3};
  }, pngBase64);
}
