// City themes: each load picks one (or ?theme=NAME) so cities differ in
// character, not just layout. A theme gathers everything that makes a
// city recognisable: district mix, heights, building types, colours,
// signs, atmosphere, weather and landscape (mountains, water).
//
// The generator runs in a worker and the renderer on the main thread; both
// call setTheme() with the same name so they agree.
import {hashFloat} from '../math/random';

export type Weather = 'rain' | 'snow' | 'ash' | 'dust' | 'none';
export type Water = 'none' | 'harbour' | 'flooded';
type RGB = [number, number, number];

export interface Theme {
  name: string;
  label: string;
  /** Relative weights of districts: Core, Megablock, Slum, Market, Corporate. */
  districts: [number, number, number, number, number];
  /** Overall building height multiplier. */
  height: number;
  /** Share of gaudy (outlined, banded, LED) buildings, x the default. */
  gaudy: number;
  /** Street-grid bending (warp amplitude multiplier). */
  warp: number;
  /** Sign density multiplier and script weights (Latin, Kana, CJK). */
  signs: number;
  scripts: [number, number, number];
  /** Owner-colour taste: extra weight per accent (see palette.ts). */
  accents: {magenta: number; cyan: number; green: number; violet: number};
  /** Window lit fraction multiplier. */
  windowsLit: number;
  /** Atmosphere (linear RGB): fog / haze low and high, sky horizon. */
  fogLow: RGB;
  fogHigh: RGB;
  skyHorizon: RGB;
  fogDensity: number;
  /** Rain/snow/ash/dust and its intensity. */
  weather: Weather;
  weatherAmount: number;
  /** Searchlights per km^2 multiplier. */
  beams: number;
  /** Landscape. */
  mountains: boolean;
  water: Water;
  /** Refinery flare stacks on the horizon (Blade Runner's Hades). */
  flares: boolean;
}

const BASE: Theme = {
  name: 'base',
  label: 'City',
  districts: [1, 1, 1, 1, 1],
  height: 1,
  gaudy: 1,
  warp: 1,
  signs: 1,
  scripts: [1, 1, 1],
  accents: {magenta: 1, cyan: 1, green: 1, violet: 1},
  windowsLit: 1,
  fogLow: [0.05, 0.035, 0.022],
  fogHigh: [0.061, 0.08, 0.102],
  skyHorizon: [0.1, 0.06, 0.035],
  fogDensity: 1,
  weather: 'rain',
  weatherAmount: 1,
  beams: 1,
  mountains: false,
  water: 'none',
  flares: false,
};

const t = (o: Partial<Theme> & {name: string; label: string}): Theme => ({
  ...BASE,
  ...o,
});

export const THEMES: Theme[] = [
  // Hong Kong: slum and housing heavy, narrow canyons, dense CJK signage,
  // red and magenta neon, heavy rain, a harbour and hills.
  t({
    name: 'kowloon',
    label: 'Neo-Kowloon',
    districts: [0.6, 1.4, 2, 1.4, 0.3],
    height: 0.9,
    signs: 1.4,
    scripts: [0.4, 0.3, 2.5],
    accents: {magenta: 1.4, cyan: 0.8, green: 1.2, violet: 0.5},
    windowsLit: 1.15,
    fogLow: [0.055, 0.035, 0.028],
    fogHigh: [0.055, 0.068, 0.085],
    skyHorizon: [0.11, 0.06, 0.042],
    fogDensity: 1.2,
    weatherAmount: 1.3,
    mountains: true,
    water: 'harbour',
  }),
  // Blade Runner (1982): flat sprawl, Tyrell pyramids, sparse red and
  // white neon, thick amber smoke, many searchlights, Hades flare stacks.
  t({
    name: 'sodium',
    label: 'Sodium LA 2019',
    districts: [0.8, 1.2, 0.6, 0.8, 6],
    height: 0.7,
    gaudy: 0.3,
    signs: 0.6,
    scripts: [1.5, 1.5, 1],
    accents: {magenta: 0.3, cyan: 0.3, green: 0.2, violet: 0.1},
    windowsLit: 0.9,
    fogLow: [0.075, 0.04, 0.016],
    fogHigh: [0.05, 0.05, 0.055],
    skyHorizon: [0.15, 0.07, 0.028],
    fogDensity: 1.5,
    beams: 2.5,
    flares: true,
  }),
  // Blade Runner 2049: brutalist megablocks, grey-teal, desaturated, few
  // signs but huge pink/blue holograms, snow, the sea wall.
  t({
    name: 'ash',
    label: 'Ash LA 2049',
    districts: [0.5, 3, 0.5, 0.5, 1],
    height: 1.1,
    gaudy: 0.15,
    signs: 0.35,
    scripts: [1, 1.5, 0.6],
    accents: {magenta: 1.2, cyan: 0.4, green: 0.1, violet: 0.3},
    windowsLit: 0.6,
    fogLow: [0.04, 0.045, 0.048],
    fogHigh: [0.055, 0.062, 0.068],
    skyHorizon: [0.06, 0.065, 0.07],
    fogDensity: 1.6,
    weather: 'snow',
    water: 'harbour',
  }),
  // Chongqing / Shenzhen: extreme heights, skybridges, light-show towers,
  // every neon colour, river fog, mountains, a riverfront.
  t({
    name: 'chongqing',
    label: 'Neon Chongqing',
    districts: [1.4, 0.8, 1, 1.6, 0.3],
    height: 1.25,
    gaudy: 2.5,
    warp: 1.4,
    signs: 1.2,
    scripts: [0.4, 0.2, 3],
    accents: {magenta: 1.5, cyan: 1.5, green: 1.2, violet: 1.2},
    fogLow: [0.045, 0.035, 0.035],
    fogHigh: [0.05, 0.06, 0.075],
    skyHorizon: [0.08, 0.055, 0.06],
    fogDensity: 1.3,
    weatherAmount: 0.4,
    mountains: true,
    water: 'harbour',
  }),
  // Neo-Tokyo / Akira: clean, ordered, wide straight avenues, monoliths
  // and supertalls, cool white and blue, kana signs, little slum.
  t({
    name: 'arcology',
    label: 'Corporate Arcology',
    districts: [2.5, 0.6, 0.15, 0.6, 3],
    height: 1.4,
    gaudy: 0.6,
    warp: 0.25,
    signs: 0.6,
    scripts: [0.8, 3, 0.3],
    accents: {magenta: 0.3, cyan: 2, green: 0.2, violet: 0.6},
    windowsLit: 1.2,
    fogLow: [0.03, 0.035, 0.045],
    fogHigh: [0.05, 0.065, 0.09],
    skyHorizon: [0.05, 0.06, 0.085],
    fogDensity: 0.8,
    weatherAmount: 0.3,
    beams: 1.5,
  }),
  // 2049's Las Vegas: orange dust, near monochrome, dark half-abandoned
  // blocks, sparse light, desert mountains.
  t({
    name: 'dust',
    label: 'Dust City',
    districts: [0.8, 1.5, 1.2, 0.5, 1],
    height: 0.9,
    gaudy: 0.1,
    signs: 0.25,
    scripts: [2, 0.5, 0.5],
    accents: {magenta: 0.2, cyan: 0.2, green: 0.2, violet: 0.2},
    windowsLit: 0.35,
    fogLow: [0.12, 0.05, 0.012],
    fogHigh: [0.1, 0.055, 0.02],
    skyHorizon: [0.2, 0.08, 0.02],
    fogDensity: 2.2,
    weather: 'dust',
    mountains: true,
  }),
];

let current: Theme = THEMES[0];

/** The active theme. */
export function theme(): Theme {
  return current;
}

/** Selects a theme by name (unknown names fall back to the first). */
export function setTheme(name: string): Theme {
  current = THEMES.find(x => x.name === name) ?? THEMES[0];
  return current;
}

/** World height of the water surface (no water: far below the city). */
export function waterLevel(): number {
  return current.water === 'flooded'
    ? 4.5
    : current.water === 'harbour'
      ? 0.3
      : -1000;
}

/** A theme chosen from the seed (when ?theme is not given). */
export function themeForSeed(seed: number): string {
  return THEMES[Math.floor(hashFloat(seed, 4711) * THEMES.length)].name;
}
