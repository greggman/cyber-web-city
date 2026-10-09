// Audio mixer: the generative Vangelis-style score (music.ts) over a quiet
// rain bed that is muffled when you're inside the cockpit. Starts on the
// first user gesture (autoplay policy).
import {VangelisEngine} from './music';

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return buf;
}

export class Ambience {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private rainGain!: GainNode;
  private rainFilter!: BiquadFilterNode;
  private music!: VangelisEngine;
  muted = false;
  volume = 0.8;
  rain = 1;
  interior = false;

  constructor(private readonly seed = 1) {}

  /** True once the audio context is running (unlocked by a gesture). */
  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Creates the graph; must be called from a user gesture. */
  start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.gain.linearRampToValueAtTime(
      this.target(),
      ctx.currentTime + 3,
    );
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    // Rain bed.
    const rain = ctx.createBufferSource();
    rain.buffer = noiseBuffer(ctx, 4);
    rain.loop = true;
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'lowpass';
    this.rainFilter.frequency.value = 6000;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 400;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rain
      .connect(hp)
      .connect(this.rainFilter)
      .connect(this.rainGain)
      .connect(this.master);
    rain.start();

    this.music = new VangelisEngine(ctx, this.master, this.seed);
    this.applyRain();
  }

  private target() {
    return this.muted ? 0 : this.volume;
  }

  private applyRain() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Inside the cockpit the rain is a muffled patter on the canopy.
    this.rainFilter.frequency.setTargetAtTime(
      this.interior ? 1100 : 6000,
      t,
      0.3,
    );
    this.rainGain.gain.setTargetAtTime(
      0.05 * this.rain * (this.interior ? 1.6 : 1),
      t,
      0.5,
    );
  }

  toggleMute() {
    this.setMuted(!this.muted);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.ctx)
      this.master.gain.setTargetAtTime(
        this.target(),
        this.ctx.currentTime,
        0.3,
      );
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx)
      this.master.gain.setTargetAtTime(
        this.target(),
        this.ctx.currentTime,
        0.1,
      );
  }

  setRain(r: number) {
    this.rain = r;
    this.applyRain();
  }

  setInterior(inside: boolean) {
    if (inside === this.interior) return;
    this.interior = inside;
    this.applyRain();
  }

  /** Call every frame: keeps the score scheduled ~2 s ahead. */
  update() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.music.scheduleUntil(this.ctx.currentTime + 2);
  }
}
