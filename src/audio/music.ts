// Generative Vangelis-inspired score (Blade Runner era): slow minor-key
// progressions on brassy CS-80-style pads with filter swells, a gliding lead
// with delayed vibrato and bend-ins, FM bells, sub bass and distant booms,
// all in a huge reverb. Pure WebAudio; works with AudioContext or
// OfflineAudioContext (scheduleUntil() schedules everything ahead).
import {Rng} from '../math/random';

const midiHz = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

const MODES = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
};
type ModeName = keyof typeof MODES;

// Progressions as scale degrees (0-based) for minor modes.
const PROGRESSIONS = [
  [0, 5, 2, 6], // i  VI  III VII
  [0, 3, 5, 4], // i  iv  VI  v
  [0, 6, 5, 6], // i  VII VI  VII
  [5, 6, 0, 0], // VI VII i   i
  [0, 5, 3, 6], // i  VI  iv  VII
  [3, 0, 5, 6], // iv i   VI  VII
];

const enum Section {
  Pads,
  Bells,
  Theme,
}

interface Chord {
  degree: number;
  notes: number[]; // MIDI voicing for pads
  tones: Set<number>; // pitch classes
}

export class VangelisEngine {
  private rng: Rng;
  private cursor = 0; // audio time of the next chord
  private root = 50; // D
  private mode: ModeName = 'aeolian';
  private progression = PROGRESSIONS[0];
  private chordIndex = 0;
  private section: Section = Section.Pads;
  private cyclesLeft = 1;
  private sectionCount = 0;
  private prevVoicing: number[] = [57, 62, 65, 69];
  private melody: {deg: number; beat: number; len: number}[][] = [];
  private melodyPass = 0;
  private lastLead = 74;
  /** Event counts and section log (for tests). */
  readonly stats = {
    pads: 0,
    lead: 0,
    bells: 0,
    booms: 0,
    sections: [] as string[],
  };
  private readonly bus: GainNode;
  private readonly padBus: GainNode;
  private readonly leadBus: GainNode;
  private readonly bellBus: GainNode;
  private readonly reverbSend: GainNode;
  private readonly vibrato: OscillatorNode;
  private readonly vibratoDepth: GainNode;

  constructor(
    private readonly ctx: BaseAudioContext,
    out: AudioNode,
    seed = 1,
  ) {
    this.rng = new Rng(seed, 1982);
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.9;
    this.bus.connect(out);
    // Huge hall: dark, long, slightly pre-delayed.
    const reverb = ctx.createConvolver();
    reverb.buffer = hallImpulse(ctx, 7.5);
    const pre = ctx.createDelay(0.2);
    pre.delayTime.value = 0.04;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.reverbSend.connect(pre).connect(reverb).connect(wet).connect(this.bus);
    const mk = (dry: number, send: number) => {
      const g = ctx.createGain();
      const d = ctx.createGain();
      d.gain.value = dry;
      const s = ctx.createGain();
      s.gain.value = send;
      g.connect(d).connect(this.bus);
      g.connect(s).connect(this.reverbSend);
      return g;
    };
    this.padBus = mk(0.7, 0.6);
    this.leadBus = mk(0.55, 0.9);
    this.bellBus = mk(0.35, 1.0);
    // Lead echo (long, dark feedback delay) into the reverb too.
    const echo = ctx.createDelay(2);
    echo.delayTime.value = 0.62;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = 'lowpass';
    echoTone.frequency.value = 2200;
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.35;
    this.leadBus.connect(echo);
    echo.connect(echoTone).connect(fb).connect(echo);
    echoTone.connect(echoOut);
    echoOut.connect(this.bus);
    echoOut.connect(this.reverbSend);
    // Shared slow vibrato for the pads (CS-80 shimmer).
    this.vibrato = ctx.createOscillator();
    this.vibrato.frequency.value = 4.8;
    this.vibratoDepth = ctx.createGain();
    this.vibratoDepth.gain.value = 5; // cents
    this.vibrato.connect(this.vibratoDepth);
    this.vibrato.start();
    this.root = this.rng.pick([50, 48, 45, 52]);
    this.newMelody();
  }

  /** Schedules music up to audio time t (call regularly, ~2 s ahead). */
  scheduleUntil(t: number) {
    // Fell behind (tab hidden, first call): restart just ahead of now.
    if (this.cursor < this.ctx.currentTime)
      this.cursor = this.ctx.currentTime + 0.1;
    while (this.cursor < t) this.nextChord();
  }

  // ---------------------------------------------------------------- theory

  private scale(deg: number): number {
    const m = MODES[this.mode];
    const o = Math.floor(deg / m.length);
    return this.root + m[((deg % m.length) + m.length) % m.length] + 12 * o;
  }

  private buildChord(degree: number): Chord {
    const r = this.rng;
    const sus = r.chance(0.3);
    const add9 = r.chance(0.35);
    const pcs = [degree, degree + (sus ? 1 : 2), degree + 4, degree + 6];
    if (add9) pcs[3] = degree + 8;
    const tones = new Set(pcs.map(d => ((this.scale(d) % 12) + 12) % 12));
    // Voice leading: choose octaves near the previous voicing.
    const prev = [...this.prevVoicing].sort((a, b) => a - b);
    const notes = pcs.map((d, i) => {
      const pc = this.scale(d) % 12;
      const target = prev[i] ?? 62;
      let best = pc;
      for (let n = pc; n < 90; n += 12)
        if (Math.abs(n - target) < Math.abs(best - target)) best = n;
      return Math.min(74, Math.max(50, best));
    });
    this.prevVoicing = notes;
    return {degree, notes, tones};
  }

  private newMelody() {
    // One phrase per chord: 2-4 notes, arch contour, chord tones on beats.
    const r = this.rng;
    this.melody = this.progression.map((deg, ci) => {
      const n = r.int(2, 5);
      const phrase: {deg: number; beat: number; len: number}[] = [];
      let beat = r.chance(0.5) ? 0 : 0.5;
      let d = deg + 7 + r.pick([2, 4]); // a chord tone, an octave up
      if (ci === 0) d += r.pick([0, 2]);
      for (let k = 0; k < n && beat < 3.4; k++) {
        const len =
          k === n - 1 ? r.pick([1.5, 2, 2.5]) : r.pick([0.5, 0.75, 1, 1, 1.5]);
        phrase.push({deg: d, beat, len});
        beat += len;
        // Mostly stepwise, descending after a high start.
        d += r.weighted([1, 3, 2, 1.5, 0.5]) - 2;
        if (r.chance(0.12)) d += r.pick([-3, 3, 4]);
      }
      return phrase;
    });
  }

  // ------------------------------------------------------------- structure

  private nextChord() {
    const r = this.rng;
    const t = this.cursor;
    const beat = r.range(2.4, 2.9); // seconds per "beat"; 4 beats per chord
    const dur = beat * 4;
    const chord = this.buildChord(this.progression[this.chordIndex]);
    const vel = r.range(0.65, 1);

    // Pads (always), a little later on each voice like a hand on keys.
    chord.notes.forEach((n, i) => this.pad(t + i * 0.06, dur + 0.6, n, vel));
    // Sub bass on the chord root.
    this.bass(
      t,
      dur,
      this.scale(chord.degree) -
        24 +
        (this.scale(chord.degree) - 24 < 33 ? 12 : 0),
    );

    if (this.section === Section.Theme) {
      const phrase = this.melody[this.chordIndex];
      phrase.forEach(({deg, beat: b, len}) => {
        let d = deg;
        if (this.melodyPass % 2 === 1 && r.chance(0.3)) d += r.pick([-1, 1, 2]);
        this.leadNote(
          t + b * beat,
          len * beat,
          this.scale(d),
          b === phrase[0].beat,
        );
      });
    }
    if (
      this.section === Section.Bells ||
      (this.section === Section.Theme && r.chance(0.2))
    ) {
      const tones = [...chord.notes].sort((a, b) => a - b).map(n => n + 24);
      const start = r.range(0.5, 3) * beat;
      const step = r.pick([0.35, 0.5, 0.7]) * beat;
      const count = r.int(3, 7);
      for (let k = 0; k < count; k++) {
        const n =
          tones[r.chance(0.7) ? k % tones.length : r.int(0, tones.length)];
        this.bell(
          t + start + k * step + r.range(-0.03, 0.03),
          n,
          r.range(0.5, 1),
        );
      }
    }

    this.cursor += dur;
    this.chordIndex++;
    if (this.chordIndex >= this.progression.length) {
      this.chordIndex = 0;
      this.melodyPass++;
      if (--this.cyclesLeft <= 0) this.nextSection();
    }
  }

  private nextSection() {
    const r = this.rng;
    this.sectionCount++;
    const order = [Section.Pads, Section.Theme, Section.Bells, Section.Theme];
    this.section = order[this.sectionCount % order.length];
    this.cyclesLeft = this.section === Section.Theme ? 2 : r.int(1, 3);
    // Occasionally move the key or the mode, and pick a new progression.
    if (r.chance(0.35)) {
      this.root += r.pick([-2, 3, -4, 5, -5]);
      while (this.root > 53) this.root -= 12;
      while (this.root < 43) this.root += 12;
    }
    this.mode =
      r.weighted([4, 2, 0.6]) === 0
        ? 'aeolian'
        : r.chance(0.75)
          ? 'dorian'
          : 'lydian';
    this.progression = r.pick(PROGRESSIONS);
    if (this.section === Section.Theme) {
      this.newMelody();
      this.melodyPass = 0;
    }
    if (r.chance(0.6)) this.boom(this.cursor + r.range(0, 2));
    this.stats.sections.push(
      `${Math.round(this.cursor)}s ${['pads', 'bells', 'theme'][this.section]} ${this.mode} root ${this.root}`,
    );
  }

  // ---------------------------------------------------------------- voices

  /** Brassy CS-80 pad voice: detuned saws through a swelling resonant filter. */
  private pad(t: number, dur: number, midi: number, vel: number) {
    this.stats.pads++;
    const ctx = this.ctx;
    const f = midiHz(midi);
    const atk = this.rng.range(1.4, 2.6);
    const rel = 3.2;
    const end = t + dur + rel;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 4;
    const peak = 500 + 2600 * vel;
    filter.frequency.setValueAtTime(260, t);
    filter.frequency.linearRampToValueAtTime(peak, t + atk);
    filter.frequency.setTargetAtTime(700 + 600 * vel, t + atk, dur * 0.35);
    filter.frequency.setTargetAtTime(240, t + dur, rel * 0.4);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(0.05 * vel, t + atk);
    amp.gain.setTargetAtTime(0.038 * vel, t + atk, 2);
    amp.gain.setTargetAtTime(0.0001, t + dur, rel / 4);
    const pan = ctx.createStereoPanner();
    pan.pan.value = this.rng.range(-0.5, 0.5);
    filter.connect(amp).connect(pan).connect(this.padBus);
    for (const [type, ratio, det, g] of [
      ['sawtooth', 1, -7, 1],
      ['sawtooth', 1, 7, 1],
      ['square', 0.5, 0, 0.35],
    ] as [OscillatorType, number, number, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * ratio;
      o.detune.value = det;
      this.vibratoDepth.connect(o.detune);
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(filter);
      o.start(t);
      o.stop(end);
    }
  }

  /** Lead note: brassy attack, bend-in on phrase starts, delayed vibrato. */
  private leadNote(t: number, dur: number, midi: number, phraseStart: boolean) {
    this.stats.lead++;
    const ctx = this.ctx;
    const f = midiHz(midi);
    const from = phraseStart ? midiHz(midi - 1) : midiHz(this.lastLead);
    this.lastLead = midi;
    const rel = 1.2;
    const end = t + dur + rel;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 6;
    filter.frequency.setValueAtTime(600, t);
    filter.frequency.linearRampToValueAtTime(3200, t + 0.12);
    filter.frequency.setTargetAtTime(1500, t + 0.12, 0.4);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(0.085, t + 0.09);
    amp.gain.setTargetAtTime(0.065, t + 0.09, 0.5);
    amp.gain.setTargetAtTime(0.0001, t + dur, rel / 4);
    // Vibrato that blooms after the attack.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.4;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(0, t + Math.min(0.5, dur * 0.4));
    depth.gain.linearRampToValueAtTime(18, t + Math.min(1.4, dur * 0.9));
    lfo.connect(depth);
    lfo.start(t);
    lfo.stop(end);
    filter.connect(amp).connect(this.leadBus);
    for (const [type, det, g] of [
      ['sawtooth', 0, 0.8],
      ['square', 5, 0.45],
    ] as [OscillatorType, number, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = det;
      // Portamento glide into the note.
      o.frequency.setValueAtTime(from, t);
      o.frequency.setTargetAtTime(f, t, phraseStart ? 0.18 : 0.07);
      depth.connect(o.detune);
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(filter);
      o.start(t);
      o.stop(end);
    }
  }

  /** FM bell / chime. */
  private bell(t: number, midi: number, vel: number) {
    this.stats.bells++;
    const ctx = this.ctx;
    const f = midiHz(midi);
    const end = t + 6;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(0.05 * vel, t + 0.004);
    amp.gain.setTargetAtTime(0.0001, t + 0.004, 1.1);
    const pan = ctx.createStereoPanner();
    pan.pan.value = this.rng.range(-0.7, 0.7);
    amp.connect(pan).connect(this.bellBus);
    for (const [ratio, idx, g] of [
      [3.5, 2.4, 1],
      [2.76, 1.2, 0.35],
    ]) {
      const car = ctx.createOscillator();
      car.frequency.value = f * (g === 1 ? 1 : 2);
      const mod = ctx.createOscillator();
      mod.frequency.value = f * ratio;
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(f * idx, t);
      mg.gain.setTargetAtTime(f * 0.05, t, 0.6);
      mod.connect(mg).connect(car.frequency);
      const cg = ctx.createGain();
      cg.gain.value = g;
      car.connect(cg).connect(amp);
      car.start(t);
      mod.start(t);
      car.stop(end);
      mod.stop(end);
    }
  }

  private bass(t: number, dur: number, midi: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midiHz(midi);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(0.16, t + 2.5);
    amp.gain.setTargetAtTime(0.0001, t + dur, 1);
    o.connect(lp).connect(amp).connect(this.bus);
    o.start(t);
    o.stop(t + dur + 5);
  }

  /** A distant, deep boom (city machinery / thunder) at section changes. */
  private boom(t: number) {
    this.stats.booms++;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 2.5);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(0.22, t + 0.05);
    amp.gain.setTargetAtTime(0.0001, t + 0.05, 1.2);
    o.connect(amp).connect(this.bus);
    amp.connect(this.reverbSend);
    o.start(t);
    o.stop(t + 7);
  }
}

/** Generated stereo hall impulse response: dark, dense, long tail. */
export function hallImpulse(
  ctx: BaseAudioContext,
  seconds: number,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  const rng = new Rng(7, 7);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // Darken over time: one-pole lowpass with a falling cutoff.
      const k = 0.5 * Math.exp(-t * 0.6) + 0.04;
      lp += (rng.next() * 2 - 1 - lp) * k;
      const env = Math.exp((-t * 6.9) / seconds) * Math.min(1, t / 0.08);
      d[i] = lp * env * 1.6;
    }
  }
  return buf;
}
