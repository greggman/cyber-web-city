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
  t({name: 'kowloon', label: 'Neo-Kowloon'}),
  t({name: 'sodium', label: 'Sodium LA 2019'}),
  t({name: 'ash', label: 'Ash LA 2049'}),
  t({name: 'chongqing', label: 'Neon Chongqing'}),
  t({name: 'arcology', label: 'Corporate Arcology'}),
  t({name: 'dust', label: 'Dust City'}),
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

/** A theme chosen from the seed (when ?theme is not given). */
export function themeForSeed(seed: number): string {
  return THEMES[Math.floor(hashFloat(seed, 4711) * THEMES.length)].name;
}
