// Compiles every WGSL entry file (with #includes resolved) in a real WebGPU
// device and prints all errors at once.
//   node test/validate-shaders.mjs
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import {startServer} from '../server.mjs';

const dir = 'src/shaders';
const load = (file, stack = []) => {
  const src = fs.readFileSync(file, 'utf8');
  return src.replace(/^\s*#include\s+"([^"]+)"\s*$/gm, (_, rel) =>
    load(path.resolve(path.dirname(file), rel), [...stack, file]),
  );
};
// Entry files are those not included by any other file.
const files = fs.readdirSync(dir).filter(f => f.endsWith('.wgsl'));
const included = new Set();
for (const f of files) {
  for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/#include\s+"([^"]+)"/g)) {
    included.add(path.basename(m[1]));
  }
}
const extra = (process.env.SHADERS ?? '').split(',').filter(Boolean);
const entries = files.filter(f => !included.has(f) || extra.includes(f));
const sources = Object.fromEntries(entries.map(f => [f, load(path.join(dir, f))]));

const server = await startServer(0);
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto(`http://localhost:${server.port}/__blank`);
const results = await page.evaluate(async sources => {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const out = {};
  for (const [name, code] of Object.entries(sources)) {
    const m = device.createShaderModule({label: name, code});
    const info = await m.getCompilationInfo();
    const lines = code.split('\n');
    out[name] = info.messages
      .filter(x => x.type !== 'info')
      .map(x => `${x.type} ${x.lineNum}:${x.linePos} ${x.message.split('\n')[0]}\n    ${lines[x.lineNum - 1]?.trim()}`);
  }
  return out;
}, sources);
await browser.close();
await server.close();
let bad = 0;
for (const [name, msgs] of Object.entries(results)) {
  if (msgs.length) {
    bad++;
    console.log(`✖ ${name}\n  ${msgs.join('\n  ')}`);
  } else {
    console.log(`✔ ${name}`);
  }
}
process.exit(bad ? 1 : 0);
