// A building is a stack of segments. Each segment is one instance of a base
// mesh (see meshes.ts) packed into 64 bytes for the GPU. Layout must match
// `struct Segment` in src/shaders/city.wgsl.
import {Shape} from './meshes';

export const SEGMENT_BYTES = 64;

/** Facade material styles (interpreted by the facade shader). */
export const enum Style {
  GlassOffice = 0,
  Residential = 1,
  MetalPanel = 2,
  LedFacade = 3,
  Slum = 4,
  Monolith = 5,
  Podium = 6,
  Structure = 7,
  NeonRing = 8,
  Bridge = 9,
  Ground = 10,
}

export const enum SegFlags {
  EdgeGlow = 1, // LED strips on vertical edges
  FloorBands = 2, // glowing horizontal bands every few floors
  RoofBeacon = 4, // blinking red aircraft lights on the roof
  NoWindows = 8,
  TopGlow = 16, // glowing crown/top edge
  RoofExposed = 32, // roof (mostly) open: rooftop kitbash goes here
  RoofRing = 64, // the roof's center is built on: kitbash only around the edge
}

export interface Segment {
  x: number;
  y: number;
  z: number;
  rotY: number;
  sx: number;
  sy: number;
  sz: number;
  taper: number; // top footprint scale (1 = straight)
  twist: number; // radians of rotation from bottom to top
  shape: Shape;
  style: Style;
  seed: number;
  colorA: number; // packed rgba8: window light tint
  colorB: number; // packed rgba8: accent/neon color
  flags: number;
  floorH: number; // floor height in meters (window grid)
}

export function packColor(r: number, g: number, b: number, a = 1): number {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)));
  return (c(r) | (c(g) << 8) | (c(b) << 16) | (c(a) << 24)) >>> 0;
}

export class SegmentList {
  private f32: Float32Array;
  private u32: Uint32Array;
  count = 0;
  /** Running bounds of all segments, for chunking. */
  readonly shapeCounts = new Uint32Array(16);

  constructor(capacity = 1024) {
    this.f32 = new Float32Array(capacity * 16);
    this.u32 = new Uint32Array(this.f32.buffer);
  }

  private grow() {
    const n = new Float32Array(this.f32.length * 2);
    n.set(this.f32);
    this.f32 = n;
    this.u32 = new Uint32Array(n.buffer);
  }

  push(s: Segment): number {
    if ((this.count + 1) * 16 > this.f32.length) {
      this.grow();
    }
    const o = this.count * 16;
    const f = this.f32;
    const u = this.u32;
    f[o + 0] = s.x;
    f[o + 1] = s.y;
    f[o + 2] = s.z;
    f[o + 3] = s.rotY;
    f[o + 4] = s.sx;
    f[o + 5] = s.sy;
    f[o + 6] = s.sz;
    f[o + 7] = s.taper;
    f[o + 8] = s.twist;
    u[o + 9] = s.shape;
    u[o + 10] = s.style;
    u[o + 11] = s.seed >>> 0;
    u[o + 12] = s.colorA >>> 0;
    u[o + 13] = s.colorB >>> 0;
    u[o + 14] = s.flags;
    f[o + 15] = s.floorH;
    this.shapeCounts[s.shape]++;
    return this.count++;
  }

  /** Moves/rotates segment i (used to warp the city into world space). */
  setPose(i: number, x: number, z: number, rotY: number) {
    const o = i * 16;
    this.f32[o] = x;
    this.f32[o + 2] = z;
    this.f32[o + 3] = rotY;
  }

  getFlags(i: number): number {
    return this.u32[i * 16 + 14];
  }

  setFlags(i: number, flags: number) {
    this.u32[i * 16 + 14] = flags;
  }

  setSize(i: number, sx: number, sz: number) {
    const o = i * 16;
    this.f32[o + 4] = sx;
    this.f32[o + 6] = sz;
  }

  get(i: number): Segment {
    const o = i * 16;
    const f = this.f32;
    const u = this.u32;
    return {
      x: f[o],
      y: f[o + 1],
      z: f[o + 2],
      rotY: f[o + 3],
      sx: f[o + 4],
      sy: f[o + 5],
      sz: f[o + 6],
      taper: f[o + 7],
      twist: f[o + 8],
      shape: u[o + 9],
      style: u[o + 10],
      seed: u[o + 11],
      colorA: u[o + 12],
      colorB: u[o + 13],
      flags: u[o + 14],
      floorH: f[o + 15],
    };
  }

  /** The packed data for upload. */
  bytes(): Uint8Array {
    return new Uint8Array(this.f32.buffer, 0, this.count * SEGMENT_BYTES);
  }

  /** Reorders segments by a key (e.g. spatial chunk) for culling locality. */
  /** Reorders segments; returns the new index of each old index. */
  sortBy(key: (i: number) => number): Uint32Array {
    const order = Array.from({length: this.count}, (_, i) => i);
    const keys = order.map(key);
    order.sort((a, b) => keys[a] - keys[b]);
    const n = new Float32Array(this.f32.length);
    for (let i = 0; i < order.length; i++) {
      n.set(this.f32.subarray(order[i] * 16, order[i] * 16 + 16), i * 16);
    }
    this.f32 = n;
    this.u32 = new Uint32Array(n.buffer);
    const newIndex = new Uint32Array(order.length);
    for (let i = 0; i < order.length; i++) newIndex[order[i]] = i;
    return newIndex;
  }
}
