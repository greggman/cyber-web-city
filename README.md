# Cyber Web City

A relaxing night flight through an enormous, rain-soaked, procedurally
generated cyberpunk megacity. It is inspired by Blade Runner, Dredd, The Fifth
Element and Cyberpunk 2077, and by the gaudy lighting of Chongqing, Shenzhen
and Shanghai. Everything is rendered with raw **WebGPU** and uses **no runtime
libraries**. The city, the signage, the ads, the holograms, the traffic and the
NURBS flying car are all generated procedurally.

- [DESIGN.md](DESIGN.md) is the brief.
- [PLAN.md](PLAN.md) is the plan, with its status and deviations.
- [docs/NURBS.md](docs/NURBS.md) documents the NURBS modeling API used for the
  car.

## Running

```sh
npm ci
npm run dev        # builds in watch mode and serves http://localhost:8080/
npm run build      # production build into dist/
npm test           # build, unit tests, puppeteer smoke test (fails on any WebGPU error)
npm run shots      # deterministic screenshot set into out/shots/
node test/car-shots.mjs spinner   # car preview renders into out/car/
node test/validate-shaders.mjs    # compile every WGSL entry file, list all errors
```

The site deploys to GitHub Pages on every push to `main`
(`.github/workflows/pages.yml`).

## Controls

| Key | Action |
|---|---|
| C | Cycle camera: chase, cockpit, skyline |
| 1–5 | Pick a chase framing (classic, low, high wide, side, front three-quarter) |
| 0 | Cycle framings automatically |
| Space | Pause |
| M | Sound on/off (sound starts on the first click or key press) |
| H | Stats HUD (GPU time per pass, visible segments) |

## URL parameters

| Param | Meaning |
|---|---|
| `seed=N` | World seed |
| `t=S` | Start time on the flight path |
| `cam=chase\|pov\|skyline\|screen\|holo` | Camera. `screen` and `holo` frame ad screen or hologram `n=K`. |
| `shot=N` | Fixed chase framing |
| `paused=1` | Freeze time (deterministic screenshots; also hides the help text) |
| `hud=1` | Show stats |
| `debug=1..6` | Debug views: albedo, normals, emissive, lights, ambient, light count per cluster |
| `quality=low` | Turns SSR off and thins the rain |
| `taa=0`, `occlusion=0`, `ssr=0`, `rain=0`, `mute=1` | Turn individual features off |

The car preview page is
`car-preview.html?view=three-quarter|side|front|rear|rear-three-quarter|top|low|under|interior|pov&env=studio|city`.

## How it works

Each frame runs the passes below, all GPU-driven. The CPU issues a fixed
number of draws no matter how large the city is.

1. **City cull (compute):** about 229k building segments are frustum-culled,
   rejected when too small to see, and occlusion-culled against last frame's
   Hi-Z pyramid. Each survivor gets an LOD and is appended to a per-mesh
   bucket, which is drawn with `drawIndexedIndirect`.
2. **Sign and traffic culls (compute):** about 140k vehicles moving
   analytically along lanes, and the neon signs, are culled into indirect
   draws. The nearest vehicles, and every ad screen, write their lights into
   dynamic light slots.
3. **Clustered light culling:** a 16×9×24 cluster grid holds the visible
   lights out of about 200k static and 2k dynamic ones.
4. **Depth prepass, then Hi-Z pyramid build.**
5. **Opaque pass (depth-equal):**
   - Buildings use procedural facade shading: interior-mapped rooms, LED
     facades, edge strips and wet streaks.
   - Neon signs use a Canvas2D glyph atlas.
   - Ad screens sample a raymarched-SDF ad atlas.
   - The NURBS car and the traffic meshes.
6. **Composite:** sky, height fog that matches the horizon, distant rain
   sheets, and froxel volumetric in-scattering (160×90×64).
7. **SSR:** half resolution, applied additively.
8. **Transparent pass:**
   - Holograms (raymarched SDFs, limited by scene depth).
   - Rain particles, lit by the clusters.
   - The car's glass, with simulated droplets and condensation in canopy uv
     space.
   - Additive glow volumes and traffic light streaks.
9. **Post:** TAA (Catmull-Rom history with variance clipping), dual-filter
   bloom, anamorphic streaks, then an AgX tonemap blended with a
   hue-preserving curve, a split-tone grade, chromatic aberration, vignette
   and grain.

All rendering is at CSS resolution, with no `devicePixelRatio` scaling.
Every WebGPU object is labeled. `uncapturederror` events and device loss are
printed with a `[WebGPU]` prefix and shown on screen, and the tests fail on
them.

### Code map

| Path | Contents |
|---|---|
| `src/gpu/` | Device setup, labeled-resource helpers, layout helper, GPU timer |
| `src/math/` | Vectors and matrices (reversed-Z infinite projection), seeded random numbers |
| `src/city/` | Layout and districts, building archetypes, signs, ads and holograms, traffic lanes |
| `src/nurbs/` | NURBS curves and surfaces, tessellation, models and materials |
| `src/car/` | The spinner, written against the NURBS API by the designer agent |
| `src/camera/` | Autopilot flight path, chase framings |
| `src/render/` | One class per system (city, signs, lights, SSR, volumetrics, rain, canopy, ads, traffic, post, Hi-Z) |
| `src/shaders/` | WGSL, assembled with `#include` |
| `src/audio/` | Procedural WebAudio ambience |
| `test/` | Puppeteer harness, smoke test, screenshot tools, shader validator, unit tests |
