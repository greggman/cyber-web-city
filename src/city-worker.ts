// Generates the city off the main thread so the GPU can compile shaders
// meanwhile (main.ts). Posts {type: 'progress', f} then {type: 'done', ...}.
import {generateCity, makeClearanceTest} from './city/generate';
import {FlightPath} from './camera/flight';
import {generateSigns, brandGlyphs, packSigns} from './city/signs';
import {LIGHT_FLOATS, packLights} from './render/lightClusters';
import type {PackedSigns} from './render/signRenderer';
import {generateAds} from './city/ads';
import type {SegmentTransfer} from './city/segments';

/** What the worker posts back when done (main.ts). */
export interface GeneratedCity {
  city: Omit<ReturnType<typeof generateCity>, 'segments'> & {
    segments: SegmentTransfer;
  };
  signs: PackedSigns;
  /** Static lights packed (LIGHT_FLOATS each). */
  lights: Float32Array;
  ads: ReturnType<typeof generateAds>;
  genMs: number;
}

self.onmessage = (e: MessageEvent<{seed: number}>) => {
  const {seed} = e.data;
  const t0 = performance.now();
  const progress = (f: number) => postMessage({type: 'progress', f});
  const city = generateCity(seed, progress);
  const flight = new FlightPath(seed, city.obstacles);
  progress(0.9);
  const {signs, lights} = generateSigns(seed, city.slots);
  progress(0.97);
  const ads = generateAds(
    seed,
    city.slots,
    city.roofs,
    city.landmarks,
    r => brandGlyphs(r, false),
    makeClearanceTest(city.segments),
    flight.intersections,
  );
  const segments = city.segments.toTransfer();
  // Packed here and transferred: cloning 600k sign objects across the
  // thread boundary took longer than generating them.
  const packedSigns = {packed: packSigns(signs), count: signs.length};
  const packedLights = new Float32Array(lights.length * LIGHT_FLOATS);
  packLights(lights, packedLights);
  (postMessage as (m: unknown, t: Transferable[]) => void)(
    {
      type: 'done',
      city: {...city, segments},
      signs: packedSigns,
      lights: packedLights,
      ads,
      genMs: performance.now() - t0,
    },
    [segments.buffer, packedSigns.packed, packedLights.buffer],
  );
};
