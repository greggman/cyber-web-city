// Audio mixer: the generative Vangelis-style score (music.ts) only (no
// rain or noise bed). Starts on the first user gesture (autoplay policy).
import {VangelisEngine} from './music';

export class Ambience {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private music!: VangelisEngine;
  muted = false;
  volume = 0.8;

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

    this.music = new VangelisEngine(ctx, this.master, this.seed);
  }

  private target() {
    return this.muted ? 0 : this.volume;
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

  /** Call every frame: keeps the score scheduled ~2 s ahead. */
  update() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.music.scheduleUntil(this.ctx.currentTime + 2);
  }
}
