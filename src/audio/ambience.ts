// Procedural ambience with WebAudio (no samples, no libraries): rain hiss,
// a distant city rumble, a slow Vangelis-style pad, and the car's thruster
// hum following its speed. Starts on the first user gesture (autoplay
// policy); M toggles mute.

function noiseBuffer(
  ctx: AudioContext,
  seconds: number,
  brown: boolean,
): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else {
        d[i] = w;
      }
    }
  }
  return buf;
}

function impulse(
  ctx: AudioContext,
  seconds: number,
  decay: number,
): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++)
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

// Slow chord progression (MIDI notes), in a minor key.
const CHORDS = [
  [45, 52, 57, 60, 64],
  [41, 48, 53, 57, 60],
  [43, 50, 55, 58, 62],
  [40, 47, 52, 55, 59],
];
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export class Ambience {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private hum!: OscillatorNode;
  private humGain!: GainNode;
  private humFilter!: BiquadFilterNode;
  private voices: OscillatorNode[] = [];
  private chord = -1;
  muted = false;

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
    this.master.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 4);
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx, 5, 2.5);
    const wet = ctx.createGain();
    wet.gain.value = 0.6;
    reverb.connect(wet).connect(this.master);

    // Rain: white noise, band-passed, with slow intensity swells.
    const rain = ctx.createBufferSource();
    rain.buffer = noiseBuffer(ctx, 4, false);
    rain.loop = true;
    const rf = ctx.createBiquadFilter();
    rf.type = 'bandpass';
    rf.frequency.value = 3500;
    rf.Q.value = 0.4;
    const rg = ctx.createGain();
    rg.gain.value = 0.12;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.04;
    lfo.connect(lfoG).connect(rg.gain);
    rain.connect(rf).connect(rg).connect(this.master);
    rain.start();
    lfo.start();

    // City rumble: brown noise, low-passed.
    const rumble = ctx.createBufferSource();
    rumble.buffer = noiseBuffer(ctx, 6, true);
    rumble.loop = true;
    const lf = ctx.createBiquadFilter();
    lf.type = 'lowpass';
    lf.frequency.value = 180;
    const lg = ctx.createGain();
    lg.gain.value = 0.35;
    rumble.connect(lf).connect(lg).connect(this.master);
    rumble.start();

    // Pad voices: detuned sawtooths through a slowly sweeping low-pass.
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 900;
    padFilter.Q.value = 2;
    const sweep = ctx.createOscillator();
    sweep.frequency.value = 0.03;
    const sweepG = ctx.createGain();
    sweepG.gain.value = 500;
    sweep.connect(sweepG).connect(padFilter.frequency);
    sweep.start();
    const padGain = ctx.createGain();
    padGain.gain.value = 0.05;
    padFilter.connect(padGain);
    padGain.connect(this.master);
    padGain.connect(reverb);
    for (let v = 0; v < 10; v++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = (v % 2 ? 1 : -1) * (6 + v);
      o.connect(padFilter);
      o.start();
      this.voices.push(o);
    }

    // Thruster hum.
    this.hum = ctx.createOscillator();
    this.hum.type = 'triangle';
    this.hum.frequency.value = 50;
    this.humFilter = ctx.createBiquadFilter();
    this.humFilter.type = 'lowpass';
    this.humFilter.frequency.value = 300;
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0.08;
    this.hum.connect(this.humFilter).connect(this.humGain).connect(this.master);
    this.hum.start();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx)
      this.master.gain.setTargetAtTime(
        this.muted ? 0 : 0.8,
        this.ctx.currentTime,
        0.3,
      );
  }

  /** Updates chord changes and the thruster hum from the flight state. */
  update(time: number, speed: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const c = Math.floor(time / 12) % CHORDS.length;
    if (c !== this.chord) {
      this.chord = c;
      const notes = CHORDS[c];
      this.voices.forEach((o, i) => {
        o.frequency.setTargetAtTime(
          midi(notes[i % notes.length]) * (i >= notes.length ? 0.5 : 1),
          ctx.currentTime,
          1.5,
        );
      });
    }
    this.hum.frequency.setTargetAtTime(40 + speed * 0.9, ctx.currentTime, 0.5);
    this.humFilter.frequency.setTargetAtTime(
      200 + speed * 8,
      ctx.currentTime,
      0.5,
    );
  }
}
