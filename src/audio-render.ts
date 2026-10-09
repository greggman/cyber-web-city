// Offline render of the generative score (used by test/music.mjs to check
// levels and to save a listenable WAV sample).
import {VangelisEngine} from './audio/music';

export async function renderMusic(seconds: number, seed: number, rate = 32000) {
  const ctx = new OfflineAudioContext(2, Math.floor(seconds * rate), rate);
  const master = ctx.createGain();
  master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 3;
  master.connect(comp).connect(ctx.destination);
  const engine = new VangelisEngine(ctx, master, seed);
  engine.scheduleUntil(seconds);
  const buf = await ctx.startRendering();
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  // Stats per second: RMS (dBFS) and peaks.
  const perSec: number[] = [];
  let peak = 0;
  let clipped = 0;
  for (let s = 0; s < Math.floor(seconds); s++) {
    let sum = 0;
    for (let i = s * rate; i < (s + 1) * rate; i++) {
      const v = (L[i] + R[i]) / 2;
      sum += v * v;
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      peak = Math.max(peak, a);
      if (a >= 0.999) clipped++;
    }
    perSec.push(Math.round(10 * Math.log10(sum / rate + 1e-12)));
  }
  // 16-bit PCM WAV.
  const n = L.length;
  const wav = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, t: string) =>
    [...t].forEach((c, i) => wav.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  wav.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVEfmt ');
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 2, true);
  wav.setUint32(24, rate, true);
  wav.setUint32(28, rate * 4, true);
  wav.setUint16(32, 4, true);
  wav.setUint16(34, 16, true);
  str(36, 'data');
  wav.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    wav.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    wav.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
  }
  const bytes = new Uint8Array(wav.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {wav: btoa(bin), perSec, peak, clipped, stats: engine.stats};
}
