// Renders the generative score offline and checks it: audible throughout,
// no clipping, no long silences. Saves out/music-sample.wav to listen to.
//   node test/music.mjs [seconds] [seed]
import fs from 'node:fs';
import {withPage} from './harness.mjs';

const seconds = Number(process.argv[2] ?? 120);
const seed = Number(process.argv[3] ?? 1);
let failed = false;
await withPage('car-preview.html', async page => {
  const r = await page.evaluate(
    async (s, sd) => (await import('/audio-render.js')).renderMusic(s, sd),
    seconds,
    seed,
  );
  fs.mkdirSync('out', {recursive: true});
  fs.writeFileSync('out/music-sample.wav', Buffer.from(r.wav, 'base64'));
  const quiet = r.perSec.filter(d => d < -55).length;
  console.log('dBFS per 10 s:', r.perSec.filter((_, i) => i % 10 === 0).join(' '));
  console.log(`peak ${r.peak.toFixed(3)}, clipped samples ${r.clipped}, near-silent seconds ${quiet}`);
  const st = r.stats;
  console.log(`events: ${st.pads} pad notes, ${st.lead} lead notes, ${st.bells} bells, ${st.booms} booms`);
  console.log('sections:', st.sections.join(' | '));
  console.log('wrote out/music-sample.wav');
  if (st.lead === 0 || st.bells === 0) failed = true;
  if (r.clipped > 0 || quiet > seconds * 0.1 || r.peak < 0.05) failed = true;
});
process.exit(failed ? 1 : 0);
