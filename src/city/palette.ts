// The city's colour script (ART_BIBLE.md 15): one shared palette that signs,
// building accents, ads and holograms all draw from. Colour is chosen per
// block with intent, not rolled per sign.
import {Rng, hashFloat} from '../math/random';
import {District} from './layout';

export type RGB = [number, number, number];

// Practicals and the sign set (linear RGB).
export const SODIUM: RGB = [1.0, 0.323, 0.045];
export const TUNGSTEN: RGB = [1.0, 0.456, 0.147];
export const XENON: RGB = [0.716, 0.807, 1.0];
export const RED: RGB = [1.0, 0.042, 0.016];
export const NEON_WHITE: RGB = [1.0, 0.723, 0.434];
export const AMBER: RGB = [1.0, 0.42, 0.06];
// Hologram pair (always used together).
export const HOLO_ROSE: RGB = [0.694, 0.262, 0.352];
export const HOLO_ICE: RGB = [0.275, 0.456, 0.578];
// Accents with an owner (15.2b).
export const MAGENTA: RGB = [1.0, 0.026, 0.3];
export const CYAN: RGB = [0.027, 0.79, 1.0];
export const ACID_GREEN: RGB = [0.2, 1.0, 0.1];
export const ULTRAVIOLET: RGB = [0.25, 0.074, 1.0];

export interface BlockPalette {
  dominant: RGB;
  secondary: RGB;
  /** A district accent placed deliberately (one Slum sign per tenement,
   * Core landmark crowns), or null. */
  accent: RGB | null;
  /** Market blocks whose signature is magenta. */
  magenta: boolean;
}

const pick = <T>(r: number, items: [T, number][]): T => {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = r * total;
  for (const [v, w] of items) {
    if ((x -= w) < 0) return v;
  }
  return items[items.length - 1][0];
};

/** The palette of superblock (i, j) in district d. Deterministic. */
export function blockPalette(
  seed: number,
  i: number,
  j: number,
  d: District,
): BlockPalette {
  const h = (k: number) => hashFloat(seed, i, j, 900 + k);
  const warm: [RGB, number][] = [
    [RED, 0.5],
    [AMBER, 0.3],
    [NEON_WHITE, 0.2],
  ];
  const second = (dom: RGB): RGB => {
    if (h(2) < 0.15) return HOLO_ICE;
    const rest = warm.filter(([c]) => c !== dom);
    return pick(h(3), rest);
  };
  switch (d) {
    case District.Market: {
      // Magenta blocks come in contiguous 3x3-superblock patches so the
      // signature reads as a quarter of town, not a sprinkle.
      const patch = hashFloat(seed, Math.floor(i / 3), Math.floor(j / 3), 901);
      if (patch < 1 / 3) {
        return {
          dominant: MAGENTA,
          secondary: CYAN,
          accent: null,
          magenta: true,
        };
      }
      const dom = pick(h(4), warm);
      return {
        dominant: dom,
        secondary: second(dom),
        accent: null,
        magenta: false,
      };
    }
    case District.Core: {
      const dom = pick(h(4), [
        [NEON_WHITE, 0.4],
        [RED, 0.3],
        [AMBER, 0.3],
      ] as [RGB, number][]);
      return {
        dominant: dom,
        secondary: second(dom),
        accent: CYAN,
        magenta: false,
      };
    }
    case District.Slum: {
      const dom = pick(h(4), warm);
      return {
        dominant: dom,
        secondary: second(dom),
        accent: ACID_GREEN,
        magenta: false,
      };
    }
    case District.Megablock: {
      const dom = pick(h(4), [
        [AMBER, 0.5],
        [RED, 0.35],
        [NEON_WHITE, 0.15],
      ] as [RGB, number][]);
      return {
        dominant: dom,
        secondary: second(dom),
        accent: null,
        magenta: false,
      };
    }
    default: {
      // Corporate: Tyrell gold.
      return {
        dominant: AMBER,
        secondary: NEON_WHITE,
        accent: null,
        magenta: false,
      };
    }
  }
}

/** A colour from a block palette: dominant 60%, secondary 30%, warm white 10%. */
export function paletteColor(rng: Rng, p: BlockPalette): RGB {
  const r = rng.next();
  if (r < 0.6) return p.dominant;
  if (r < 0.9) return p.secondary;
  return NEON_WHITE;
}
