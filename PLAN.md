# Cyber Web City — Implementation Plan

A plan for building the experience described in [DESIGN.md](DESIGN.md): a relaxing, night-time,
rain-soaked flight through an enormous procedurally generated cyberpunk megacity in a
procedurally generated (NURBS) flying car, rendered with raw WebGPU and no runtime libraries.

---

## 1. Guiding principles

- **No runtime libraries.** All math, geometry, NURBS, noise, text, and rendering code is ours.
  Dev-only tooling (TypeScript, esbuild, gts, express, puppeteer) is fine.
- **Everything procedural and deterministic.** A single seed (`?seed=N`) drives the city, cars,
  ads, and flight path, so screenshots are reproducible and regressions are visible.
- **GPU-driven.** The CPU sets up data once and issues a small, fixed number of indirect draws
  per frame. Culling, LOD selection, traffic animation, and particles run in compute shaders.
- **Light comes from the city.** No sun and no moon to speak of. Thousands of emissive surfaces
  (windows, neon, signs, ad screens, holograms, traffic) light the scene through HDR, bloom,
  wet reflections, and volumetric fog. This is what makes it look like the films.
- **Debuggable.** Every WebGPU object gets a `label`. `device.onuncapturederror` and
  `device.lost` are logged loudly with the label in the message. Error scopes wrap pipeline
  creation. A test fails on any such error.
- **Render at CSS resolution.** `canvas.width = canvas.clientWidth` (likewise for height), with
  no `devicePixelRatio` scaling. Expensive effects (volumetrics, SSR, bloom chain) run at
  half or quarter of that size internally.

---

## 2. Tooling and repository layout

```
cyber-web-city/
  package.json            # "type": "module"; scripts below
  tsconfig.json           # strict, ES2022+, moduleResolution bundler, @webgpu/types
  .eslintrc / .prettierrc # from `npx gts init`
  build.mjs               # esbuild: bundle src/main.ts -> dist/, inline .wgsl as strings
  server.mjs              # express static server for dist/ (local dev and tests)
  index.html
  src/
    main.ts               # boot, device creation, error hooks, main loop
    gpu/                  # device wrapper, labeled-resource helpers, buffer pools, timestamp queries
    math/                 # vec/mat/quat, PRNG (PCG/xoshiro), noise (value/simplex/worley), splines
    nurbs/                # NURBS curve/surface API and tessellator (see §6)
    city/                 # layout, building grammar, materials, LOD/cluster builder
    car/                  # car definition (written against the NURBS API), interior, lights
    traffic/              # lanes, GPU traffic sim
    ads/                  # ad scene library, render-to-texture scheduler, holograms
    weather/              # rain particles, splashes, canopy droplets, condensation
    render/               # frame graph and passes (see §4)
    camera/               # flight path, chase cam, cockpit POV, input
    shaders/*.wgsl        # one file per pass/material, plus shared includes
  test/
    smoke.mjs             # puppeteer: load, run N frames, assert no GPU errors, screenshot
    shots.mjs             # deterministic screenshot set for judging (see §10)
  .github/workflows/pages.yml
```

**npm scripts**

- `build`: run esbuild (minified, sourcemaps) into `dist/`.
- `dev`: run esbuild in watch mode plus `server.mjs` on :8080.
- `lint` / `fix`: gts.
- `check`: `tsc --noEmit`.
- `test`: build, start express on a random port, run `test/smoke.mjs`.
- `shots`: run `test/shots.mjs` and write PNGs to `out/`.

**WGSL handling:** esbuild's `text` loader imports `.wgsl` files as strings. A tiny `#include`
preprocessor in `build.mjs` resolves shared snippets (noise, lighting, packing).

**GitHub Pages:** `pages.yml` runs on pushes to `main`: checkout → setup-node (LTS) →
`npm ci` → `npm run lint && npm run check && npm run build` → `actions/upload-pages-artifact`
with `dist/` → `actions/deploy-pages`. Permissions: `pages: write`, `id-token: write`.
All asset paths are relative so the site works under `/<repo>/`.

---

## 3. WebGPU foundation

- Request an adapter with `powerPreference: 'high-performance'`. Opportunistically request
  `timestamp-query`, `float32-filterable`, `rg11b10ufloat-renderable`, and
  `indirect-first-instance`, and fall back gracefully when they're missing.
- `device.addEventListener('uncapturederror', e => console.error('[WebGPU]', e.error.message))`
  and `device.lost.then(info => console.error('[WebGPU lost]', info.reason, info.message))`.
  Show the error in an on-screen overlay too.
- Helpers such as `createBuffer(device, {label, ...})` make `label` a required parameter, so
  forgetting one fails type-checking. Labels are hierarchical, e.g.
  `city/buildings/clusterCull/argsBuffer` or `post/bloom/down[3]`.
- `pushErrorScope('validation')` around every pipeline/shader creation in debug builds, and
  print `getCompilationInfo()` messages with the shader label.
- Prefer `createRenderPipelineAsync` / `createComputePipelineAsync` with a loading progress UI.
- Per-frame uniforms live in one ring of uniform buffers written with `queue.writeBuffer`. Bind
  group layouts are grouped by update frequency: 0 = frame, 1 = pass, 2 = material, 3 = draw.
- Optional GPU timestamp queries per pass feed a HUD (`?hud=1`) for profiling.
- A `?debug=` URL param selects a view: albedo, normals, depth, light count, LOD level,
  overdraw, or cluster IDs.

---

## 4. Frame graph (render passes)

Target: HDR `rgba16float` (or `rg11b10ufloat`) color, `depth32float` with **reversed-Z**
(essential for a city several kilometres deep).

1. **Simulation (compute):** traffic update, rain particles, canopy droplets/condensation,
   hologram animation parameters.
2. **Ad-screen updates:** render 1–3 ad scenes per frame into an ad texture atlas (round-robin,
   see §8), then regenerate mips for that atlas region.
3. **GPU culling (compute):** frustum and Hi-Z occlusion (using last frame's depth pyramid)
   culling of building instances/clusters and traffic. LOD selection. Writes compacted
   instance lists plus `drawIndexedIndirect` args.
4. **Depth prepass + visibility:** opaque city and cars. Build this frame's Hi-Z pyramid.
5. **Light culling (compute):** clustered (froxel) light lists for thousands of point/spot/
   "neon tube" lights (traffic, signs, street lamps, ad-screen area-light proxies).
6. **Opaque forward+ shading:** clustered forward rather than deferred, because transparency
   (glass canopy, holograms, rain) is central to the look and MSAA/material variety is easier.
   PBR (GGX), plus wetness (darkened albedo, lowered roughness, rain ripple normal maps on
   horizontal surfaces, streaks on vertical ones).
7. **Reflections:** half-res screen-space reflections for wet surfaces and glass, falling back
   to a low-res, procedurally rendered "city glow" cubemap updated every few frames around the
   camera.
8. **Volumetric fog (froxels, compute):** a 160×90×64 froxel grid of in-scattered light from
   the clustered lights and emissive ad screens, with temporal reprojection. This produces the
   Blade Runner light shafts and haze and also makes the city's scale read (aerial perspective).
9. **Transparent pass:** holograms (additive), glass canopy (refraction from the opaque color
   copy + Fresnel reflections + droplets), rain streaks, and traffic light trails.
10. **Post:** TAA (jittered projection plus history with neighborhood clamp) → bloom (dual-
    filter downsample/upsample chain) → anamorphic horizontal lens streaks for bright neon (a
    signature of the films) → tonemap (AgX- or ACES-style) → color grade (teal/orange/magenta
    LUT generated procedurally) → chromatic aberration, vignette, film grain → swap chain.
11. **HUD/cockpit overlay** is part of the 3D interior, not DOM (except the debug HUD).

---

## 5. The city

### 5.1 Layout

- An infinite or very large grid of **districts** generated by chunk `(i, j)` from the seed.
  District types: corporate megatower core (Tyrell-style pyramids, Shanghai supertalls),
  dense vertical slum (Chongqing-style stacked terraces, buildings built on buildings, sky
  bridges), Mega-City One megablocks (Dredd: kilometre-wide slabs with thousands of windows),
  and neon market canyons (Shenzhen/Kowloon: dense signage, low tiers).
- Streets are deep canyons. The ground is barely visible, hazy, and steaming. Multi-level
  **sky-lanes** at several altitudes carry traffic and define the flight path.
- Height profile: most buildings are 300–800 m, landmarks are 1.5–3 km, and the far skyline
  fades into fog to imply endless scale.

### 5.2 Building generation (shape grammar)

- Each building is a stack of **segments** (box, chamfered box, cylinder, twisted prism,
  tapered/setback, stepped pyramid, cantilevered block) with modifiers: twist, taper, offset,
  setbacks, crowns (spires, rings, Pearl-Tower spheres, helipads, antenna clusters), sky
  bridges, external elevators, balconies, pipes, and AC units.
- Inspiration rules: Chongqing (stacked, hillside, mixed heights, bridges threading
  buildings), Shanghai (iconic silhouettes like the bottle opener, twisting tower, and spheres),
  Shenzhen (glass towers with full-facade LED animation), and Cyberpunk 2077 (megabuildings
  with exposed infrastructure).
- **Facade detail is in the shader, not the geometry.** Windows come from procedural UVs on
  facades: a grid cell, a per-window hash for lit/unlit/color temperature/blinds, and
  **interior mapping** (raycast into a fake room cube, as in Spider-Man and The Division) for
  parallax rooms. Floor separators, mullions, and grime come from procedural normals.
- **Gaudy lighting:** facade-outline LED strips, full-facade LED animations (scrolling
  patterns, waves, giant characters), rooftop neon signs with procedurally generated invented
  brand glyphs, and vertical Chinese/Japanese-style neon signs. Use the Canvas2D text API only
  as a texture generator for glyph atlases (a browser API, not a library), or use procedural
  SDF glyphs.

### 5.3 Making it fast (AAA techniques)

- **Instancing + GPU-driven indirect draws.** Building segments share a small library of base
  meshes (box, cylinder, and so on) that are transformed per instance, with material/seed
  per instance. Only a few dozen pipelines and indirect draws exist for the whole city.
- **Nanite-lite clusters:** large unique pieces (megablocks, landmarks, the car) are split
  into ~128-triangle meshlets with bounding spheres/cones and a precomputed LOD hierarchy
  (simplified via edge collapse). A compute shader selects a cut per frame by projected-error,
  culls it against frustum + Hi-Z + backface cone, and emits indirect draws. Start with
  discrete LODs and add clusters only where profiling shows the need.
- **Far field:** beyond ~3 km, buildings become **impostors** (octahedral or simple
  facade-card impostors baked at load), and beyond ~8 km a procedural **skyline layer**
  (several parallax silhouette bands with lit windows, rendered once into a cubemap/strip)
  takes over. Fog hides every transition.
- **Streaming:** generate chunks in a worker ahead of the flight path (the path is known in
  advance), upload with `writeBuffer` within a per-frame byte budget, and evict behind.
- **Light budget:** most "lights" are emissive surfaces that bloom and appear in reflections
  and fog. Only the nearest few thousand become real clustered lights.

---

## 6. NURBS API and the car

### 6.1 NURBS API (`src/nurbs/`)

Written first and documented so a separate agent can design the car using only this API.

- `NurbsCurve(degree, controlPoints: Vec4[] /* homogeneous */, knots)` with `evaluate(t)`,
  `derivative(t)`, and helpers `clampedUniformKnots(n, degree)`, `circle()`, `fromPolyline()`,
  and `interpolate(points)`.
- `NurbsSurface(degreeU, degreeV, controlNet[u][v], knotsU, knotsV)` with `evaluate(u, v)`,
  `normal(u, v)`, and `derivatives(u, v)`.
- Constructors: `loft(curves)`, `sweep(profile, rail)`, `revolve(curve, axis, angle)`,
  `extrude(curve, dir)`, `mirrorX(surface)`, and `bilinearPatch()`.
- `tessellate(surface, {tolerance | segmentsU, segmentsV})` → `{positions, normals, uvs,
  indices}` using curvature-adaptive subdivision, with optional **trim** via a parametric
  boundary curve (enough for window cutouts and wheel-well style openings).
- `Part { surface, material: 'paint' | 'chrome' | 'glass' | 'emissive' | 'rubber' |
  'interior-leather' | 'screen', emissiveColor? }` and `Model { parts }` → merged GPU meshes
  plus meshlets for the cluster renderer.
- Unit tests (node, no browser) for knot validity, partition of unity, circle exactness,
  and tessellation watertightness at seams.

### 6.2 The car design

- Spinner-inspired (Blade Runner): a long, low wedge nose; a bulbous, fully **transparent
  canopy/top** giving 360° visibility; side pods with ducted thrusters; gull-wing door seams;
  and a light bar on the nose plus a police-style roof light in a different color (not a
  copy of the film car).
- Exterior materials: multi-layer car paint (clearcoat + flakes), brushed metal, wet
  droplets, and emissive strips. The thrusters get heat-shimmer distortion in the post
  refraction pass and a volumetric glow.
- **Interior:** two to four seats, a driver's yoke, a dashboard with animated CRT/holographic
  displays (map, altimeter, comms — rendered to texture like the ads), and footwell lights.
  Interior light comes from the city through the canopy plus the dashboard glow.
- **Other traffic** uses the same API to make 4–6 vehicle variants (spinners, heavy haulers,
  police, taxis, ad blimps), each with 3 LODs, and at distance becomes headlight/tail-light
  sprites streaming along lanes.

### 6.3 Agent workflow for the car

1. **API agent** (main): implements `src/nurbs/` plus a `car-preview.html` page that renders
   a single `Model` on a turntable under studio and city lighting, plus screenshot tooling.
2. **Car designer agent:** given only the API docs, Blade Runner references described in
   text, and the preview tool, writes `src/car/spinner.ts`. It iterates using screenshots.
3. **Car judge agent:** receives screenshots (front, side, 3/4, top, interior, cockpit POV)
   and scores silhouette, proportions, surface quality (no creases or seams), canopy
   transparency and readability, and "would this appear in a film". It returns concrete,
   actionable changes. Loop until the judge's score is ≥ 8/10 or 5 rounds pass.

---

## 7. Traffic

- Lanes are 3D splines along streets at several altitudes, and vertical "elevator" lanes
  rise near landmark towers.
- A compute shader advances tens of thousands of vehicles along lanes with spacing and gentle
  speed variation. Near vehicles (< ~400 m) render as instanced NURBS meshes, and far ones as
  billboard headlight/tail-light pairs whose additive streaks create Blade Runner's rivers of
  light.
- The top N vehicles nearest the camera write lights into the clustered light list.

---

## 8. Giant ads and holograms

### 8.1 Animated ad screens (render-to-texture)

- A library of **ad scenes**, each a small procedural 3D scene with its own camera and
  animation: a rotating product bottle with liquid, a dancing figure built from SDF primitives
  (raymarched), koi swimming, a geisha-like face built from simple shapes (stylized, not a
  real person), a flashing noodle bowl, a car commercial reusing the NURBS car, and an
  abstract logo reveal.
- All brands and text are **invented**, never real companies.
- An **ad atlas** (`rgba16float`, e.g. 4096×4096 split into tiles) stores the screens. A
  scheduler renders visible/nearby screens most often (every 1–2 frames), distant ones rarely,
  and offscreen ones never. It is budgeted at ~1.5 ms.
- Screens use emissive materials with a subpixel/LED-grid shader up close and mip blending at
  distance. Each screen also injects an **area-light proxy** (its average color from the
  1×1 mip) into the light clusters and fog, so ads visibly paint the rain and buildings.

### 8.2 Building-sized holograms

- Volumetric-looking additive geometry: a figure (dancer, koi, jellyfish, woman's
  silhouette) rendered as layered shells or raymarched SDF inside a bounding box, with
  scanlines, glitch offsets, Fresnel rim, flicker, and chromatic split.
- Sorted back-to-front among transparents. Holograms are depth-tested, don't write depth,
  contribute to bloom, and add a coarse emissive term to the volumetric fog.

---

## 9. Atmosphere: rain, wetness, condensation

- **Rain:** GPU particle streaks (~100k) in a camera-relative wrapping volume, motion-blurred
  by stretching along velocity relative to the camera and lit by the clustered lights (the
  backlit rain in front of neon is key). Mist sheets/curtains at distance.
- **Splashes** on rooftops and ledges via a depth-texture test in compute. Puddle ripples are
  a procedural animated normal on flat surfaces.
- **Wet materials:** a global wetness factor plus per-surface porosity; vertical streak
  maps; drips from ledges.
- **Canopy droplets (both cameras):** a compute sim on a 2D droplet map in canopy UV space
  where drops spawn, merge, and slide downward with gravity and airflow (pushed back by speed),
  as in "The Rain" style shaders. The glass shader refracts the scene through droplet normals.
- **Cockpit condensation (POV only):** a fog-amount texture on the canopy's inner surface that
  slowly builds up near edges/bottom, is cleared by droplet trails and an occasional defog
  sweep from vents, and produces a blurred, light-diffusing view (sample from the blurred bloom
  mips by fog amount). Faint finger-wipe streaks add character.

---

## 10. Camera and flight

- **Autopilot path:** a precomputed Catmull-Rom/NURBS path through sky-lanes and canyons,
  between towers, past holograms, and under sky bridges, with smooth banking and
  altitude changes. It is guaranteed collision-free by sampling against the building SDF/
  bounds at generation time. It loops, or extends forever with chunked generation.
- **Chase cam:** a spring-damper follow with look-ahead, slight lag on banks, and
  occasional cinematic offsets.
- **Cockpit POV:** at the driver's eye position with subtle head bob/turbulence, looking
  through condensation and droplets; the dashboard is visible.
- Controls: `C` toggles the camera, `Space` pauses, number keys pick cinematic presets, and
  mouse drag looks around in POV. URL params `?cam=chase|pov&t=SECONDS&seed=N&paused=1`
  give deterministic shots.
- **Audio** is out of scope unless requested (a WebAudio rain/synth ambience would add a lot
  to "relaxing" and needs no libraries; consider it as a stretch goal).

---

## 11. Testing and verification

- `server.mjs` (express) serves `dist/`.
- `test/smoke.mjs` (puppeteer, default launch args) does the following:
  - Captures `console` and `pageerror` events. **Fails on any `[WebGPU]` uncaptured
    error, device loss, or shader compilation error**, printing the offending label.
  - Waits for `window.__ready`, runs ~120 frames, and checks that the canvas isn't blank or
    a single color (sampling a pixel histogram).
  - Retries if headless Chrome's compositor stalls (no rAF ticks advancing), since this has
    been observed in the sibling `webgpu-puppeteer` experiments.
- `test/shots.mjs` captures a fixed set of deterministic screenshots at 1280×720: chase cam
  at t = 5/30/60 s, POV at t = 10/45 s, a top-down skyline, a close-up of an ad screen, a
  hologram, and the debug views. It also logs GPU pass timings if `timestamp-query` is
  available.
- Node unit tests (`node --test` on compiled TS) cover math, NURBS, PRNG determinism, and the
  building grammar (no NaNs, no degenerate meshes).

**Performance budget** (mid-range discrete GPU, 1920×1080 CSS pixels): 60 fps / 16.6 ms.
Culling 0.5, depth prepass 1.5, light culling 0.5, opaque 4, SSR 1, volumetrics 1.5, ad RTT
1.5, transparents/rain 2, post 2, slack 2. On an integrated GPU, aim for 30 fps with a
`?quality=low` preset that halves volumetric/SSR resolution, reduces rain, and shortens draw
distance.

---

## 12. Agents and roles

| Agent | Duty |
|---|---|
| **Lead / engine** | Tooling, WebGPU core, frame graph, city, integration. Owns `main`. |
| **NURBS car designer** | Writes the car (and traffic variants) using only the NURBS API and the preview tool. |
| **Car judge** | Critiques car screenshots and gates the car design (§6.3). |
| **AAA visual judge** | Sole duty: compare `npm run shots` output against a rubric for AAA games (Cyberpunk 2077, Spider-Man, Ratchet & Clank, GTA V) and the reference films. It scores each milestone and returns a ranked list of gaps. Rubric: sense of scale, lighting richness/contrast, wet reflections, atmosphere/fog, density of detail, ads/holograms spectacle, car quality, aliasing/shimmer, color grade, frame rate, and absence of obvious artifacts (popping, seams, z-fighting, banding). It must cite specific screenshots and regions. No milestone counts as done below ~7/10, and the final target is ≥ 8/10. |
| (optional) **Perf reviewer** | Reads timestamp-query output and suggests optimizations when the frame exceeds its budget. |

The AAA judge and car judge only look at screenshots and the rubric, not the code, so their
verdicts stay about what the player sees.

---

## 13. Milestones

Each milestone ends with `npm test` green (zero WebGPU errors), new screenshots, and an AAA
judge report. The next milestone starts with the top judge findings.

1. **Skeleton:** repo, gts, esbuild, express, puppeteer smoke test, the Pages workflow
   deploying a cleared canvas, error hooks, labeled-resource helpers, and the resize-to-CSS-
   size canvas.
2. **Core renderer:** math lib, camera, reversed-Z, HDR target, tonemap, a box city with
   instancing, and indirect draws.
3. **City v1:** districts, building grammar, procedural facades with window shaders and
   interior mapping, fog, autopilot path, and chase cam. *First AAA judging.*
4. **Lighting:** clustered forward+, neon/LED facades, bloom, anamorphic streaks, color grade,
   and TAA.
5. **NURBS + car:** API, preview page, designer/judge loop, car in the scene, and cockpit POV.
6. **Rain and wet:** rain particles, wet materials, SSR, canopy droplets, and condensation.
7. **Ads and holograms:** ad scene library, atlas scheduler, area-light proxies, and
   holograms.
8. **Traffic:** lanes, compute sim, mesh/billboard LODs, and light streams.
9. **Scale and performance:** GPU culling with Hi-Z, meshlet LOD for big pieces, impostors,
   skyline layer, chunk streaming, quality presets, and profiling against the budget.
10. **Polish:** volumetric light shafts, thruster effects, camera cinematics, optional audio,
    and final AAA judging to ≥ 8/10, then deploy.

---

## 14. Risks and mitigations

- **Headless WebGPU differences** (software adapter or flaky compositor in puppeteer): keep
  tests tolerant of performance, retry on stalls, and judge visuals from screenshots rather
  than FPS. Do real performance checks in a headed browser.
- **Transparency ordering** (canopy vs rain vs holograms): use fixed pass ordering, give each
  transparent class its own sub-pass, and use weighted-blended OIT for rain/hologram overlap
  if sorting artifacts appear.
- **TAA ghosting** on rain and holograms: write per-pixel motion vectors (including for
  traffic) and use a reactive mask for particles.
- **Shader compile time** with many materials: use an uber-shader with a small number of
  permutations and async pipeline creation behind a loading screen.
- **Scope:** Nanite-style clusters and froxel volumetrics are the most expensive features to
  build, so ship simpler versions first (discrete LODs; height fog + light-sprite glows) and
  upgrade them when the judge or profiler says they're the bottleneck.
- **IP:** draw inspiration from the films and cities, but invent all brands, logos, faces,
  and the car design itself.

---

## 15. Status (implementation notes)

All ten milestones are implemented; see [README.md](README.md) for usage and
the architecture overview. Where the implementation deviates from the plan
above, it is noted here.

| Plan item | Status |
|---|---|
| Tooling, Pages deploy, labeled objects, error reporting | Done. TypeScript 7 runs side by side with the TS 6 API package, because typescript-eslint (used by gts) doesn't support TS 7 yet. A WGSL batch validator (`test/validate-shaders.mjs`) was added. |
| GPU-driven city, compute culling, indirect draws, LOD | Done. Hi-Z occlusion uses the previous frame's pyramid; in canyon views it typically culls about 95% of segments. |
| Building grammar, districts, Chinese-city archetypes | Done (setback, cylinder, twisting, pearl, megablock, pyramid, slum stack, Raffles-style bridged cluster, gate, LED slab, wedge), plus sky bridges that always connect to real faces. |
| Facade shading, interior mapping, wetness | Done. Distant facades use per-building emission averages. |
| Clustered forward+ lighting | Done (16×9×24 clusters, about 200k static and 2k dynamic lights). |
| Signs, glyph atlas | Done, with GPU culling into an indirect draw. |
| Ads (render to texture) and holograms | Done. Ads are raymarched SDF scenes in a mipmapped atlas, with GPU-extracted area lights. Holograms are raymarched SDFs. One planned ad, a commercial rasterizing the NURBS car, was not done. |
| Rain, splashes, canopy droplets, condensation | Done. Splashes are represented by animated ripple normals on wet surfaces rather than splash particles. |
| SSR, volumetrics, TAA, bloom, streaks, grade | Done. |
| NURBS API and car via designer and judge agents | Done in five rounds. The car judge scored 4.5, 5.7, 6.6, then 7.3 after rounds 4–5 (the 5-round limit). Its remaining notes are renderer polish plus minor modeling. |
| Traffic | Done. It's analytic (no simulation state), so screenshots are deterministic. The nearest vehicles render as meshes (the hero car tessellated coarsely) and all of them as light streaks. Dedicated traffic models were not made. |
| Nanite-style meshlet clusters | **Not built.** City geometry is a few hundred thousand instanced primitives whose facade detail lives in shaders, so meshlets would not pay off. The plan's fallback was used instead: discrete LODs, Hi-Z occlusion and size culling. |
| Impostors and chunk streaming | **Replaced.** The whole city (about 230k segments) generates in under 0.7 s. A far-field ring of simple buildings out to about 14 km, plus horizon-matched fog, replaces impostors and the skyline layer, and no streaming is needed because the flight path loops within the city. |
| Quality presets, profiling | Done: `quality=low`, GPU timestamp HUD, visible-segment readback. |
| Audio (stretch goal) | Done: procedural WebAudio ambience. |

**AAA visual judge (screenshots only):** M3 3.5, M4 5, M10 6.5, then 7.5,
then **8/10** (the target), followed by a hologram-placement regression fix.
Its remaining suggestions: more car surface detail, more chase-framing
variety, more visible pods and voids, and bolder ad art.
