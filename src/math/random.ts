// Deterministic random numbers and hashing. Everything procedural in the
// project derives from these so that a seed reproduces the same world.

/** Integer hash (lowbias32 by Chris Wellons). */
export function hash32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

export function hashCombine(...values: number[]): number {
  let h = 0x9e3779b9;
  for (const v of values) {
    h = hash32(h ^ hash32(Math.floor(v) | 0));
  }
  return h;
}

/** Hash to a float in [0, 1). */
export function hashFloat(...values: number[]): number {
  return hashCombine(...values) / 4294967296;
}

/** sfc32-based PRNG. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number, stream = 0) {
    this.a = hash32(seed ^ 0xdeadbeef);
    this.b = hash32(seed + 0x1234567 + stream * 0x9e3779b9);
    this.c = hash32(this.a ^ this.b ^ stream);
    this.d = 1;
    for (let i = 0; i < 12; i++) {
      this.nextU32();
    }
  }

  nextU32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(lo: number, hiExclusive: number): number {
    return lo + Math.floor(this.next() * (hiExclusive - lo));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Picks an index according to the given weights. */
  weighted(weights: readonly number[]): number {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) {
        return i;
      }
    }
    return weights.length - 1;
  }

  /** Approximately normal distribution (mean 0, sd 1). */
  gaussian(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732;
  }
}
