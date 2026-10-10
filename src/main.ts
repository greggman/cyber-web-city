// Entry point: boots WebGPU, generates the city and runs the main loop.
//
// URL params:
//   seed=N        world seed (default: random every load)
//   theme=NAME    city theme (kowloon, sodium, ash, chongqing, arcology, dust, drowned)
//   t=SECONDS     start time along the flight path
//   size=WxH      fixed canvas size in CSS px, centred (video capture)
//   cam=chase|pov|skyline|map camera mode (skyline: establishing shot; map: top-down)
//   cam=facade&n=K[&d=D]  inspect a building face (optionally of district D)
//   paused=1      freeze time (deterministic screenshots)
//   anim=S        animation time S with the camera at t (flicker tests)
//   hud=1         show stats
//   debug=N       debug view (see renderer)
//   quality=low|high
import {hashCombine} from './math/random';
import {THEMES, setTheme, themeForSeed} from './city/theme';
import {SegFlags, SegmentList, type Segment} from './city/segments';
import type {GeneratedCity} from './city-worker';
import {initGpu, onGpuError} from './gpu/gpu';
import {Renderer, type RenderSettings} from './render/renderer';
import {Camera} from './camera/camera';
import {makeClearanceTest} from './city/generate';
import {unwarp} from './city/warp';
import {AdSystem, SCREEN_LIGHT_SLOT, SCREEN_LIGHT_SLOTS} from './render/ads';
import {FlightPath, ChaseCamera, insideAt, lookAround} from './camera/flight';
import {OrbitControl} from './camera/orbit';
import {
  lookAtCamera,
  transformPoint,
  transformDir,
  type Vec3,
} from './math/vec';
import {MODELS} from './car/models';
import {buildModelMesh} from './nurbs/model';
import {CarRenderer, carLights} from './render/carRenderer';
import {packLights, LIGHT_FLOATS} from './render/lightClusters';
import {DYNAMIC_LIGHTS} from './render/renderer';
import {Rain} from './render/rain';
import {CableRenderer} from './render/cables';
import {Canopy} from './render/canopy';
import {Ambience} from './audio/ambience';
import {
  CameraMode,
  Controls,
  DEFAULTS,
  loadSaved,
  type UiState,
} from './ui/controls';
import {generateTraffic} from './city/traffic';
import {Traffic} from './render/traffic';

const loadmsg = document.getElementById('loadmsg')!;
const errors = document.getElementById('errors')!;
const hud = document.getElementById('hud')!;

function showError(msg: string) {
  errors.style.display = 'block';
  errors.textContent += msg + '\n';
}

const params = new URLSearchParams(location.search);
// A new city on every load unless ?seed (and ?theme) pin one; nothing is
// written back to the URL (settings shows a link to the current city).
const userSeed = params.has('seed')
  ? Number(params.get('seed'))
  : Math.floor(Math.random() * 0x7fffffff);
let cityTheme = setTheme(params.get('theme') ?? themeForSeed(userSeed));
// The generation seed mixes in the theme: the same seed number gives a
// different city per theme (otherwise blocks of the same district came
// out identical across themes).
const citySeed = () =>
  hashCombine(userSeed, THEMES.indexOf(cityTheme) + 1) & 0x7fffffff;
let seed = citySeed();
/** How much of the theme's weather is rain (snow/ash/dust have their own). */
let weatherRain = 0;
/** Particle amount for the theme's weather (rain, snow, ash or dust). */
let weatherParticles = 0;
function updateWeather() {
  weatherRain = cityTheme.weather === 'rain' ? cityTheme.weatherAmount : 0;
  weatherParticles = cityTheme.weather === 'none' ? 0 : cityTheme.weatherAmount;
}
updateWeather();
/** Switches to the next theme in place (set up in main()). */
let nextTheme: () => void = () => {};

const tStart = performance.now();
const startupMs: Record<string, number> = {};

async function main() {
  onGpuError(showError);
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  // size=WIDTHxHEIGHT: a fixed CSS size, centred (for capturing video at an
  // exact size). Rendering follows the canvas's CSS size.
  const sizeMatch = /^(\d+)x(\d+)$/.exec(params.get('size') ?? '');
  if (sizeMatch) {
    canvas.style.width = `${sizeMatch[1]}px`;
    canvas.style.height = `${sizeMatch[2]}px`;
    document.documentElement.classList.add('fixed-size');
  }
  const gpu = await initGpu(canvas);
  const renderer = new Renderer(gpu);
  const tShaders = performance.now();
  // Startup progress: city generation (in a worker) and shader compiles
  // run at the same time; show both.
  let genF = 0;
  let shadersDone = 0;
  let shadersTotal = 0;
  const showProgress = () => {
    const g =
      genF < 1 ? `Generating city ${Math.round(genF * 100)}%` : 'City ready';
    loadmsg.textContent = `${cityTheme.label}\n${g}\nCompiling shaders ${shadersDone}/${shadersTotal}`;
  };
  const track = <T>(p: Promise<T>): Promise<T> => {
    shadersTotal++;
    showProgress();
    return p.then(v => {
      shadersDone++;
      showProgress();
      return v;
    });
  };
  Renderer.track = track;
  // Generates a city in a worker (the main thread keeps rendering).
  const generate = (
    genSeed: number,
    themeName: string,
    onProgress: (f: number) => void,
  ) =>
    new Promise<GeneratedCity>((resolve, reject) => {
      const worker = new Worker('city-worker.js', {type: 'module'});
      worker.onerror = e => reject(new Error(`city worker: ${e.message}`));
      worker.onmessage = (e: MessageEvent) => {
        if (e.data.type === 'progress') {
          onProgress(e.data.f);
        } else {
          onProgress(1);
          resolve(e.data as GeneratedCity);
          worker.terminate();
        }
      };
      worker.postMessage({seed: genSeed, theme: themeName});
    });
  const generated = generate(seed, cityTheme.name, f => {
    genF = f;
    showProgress();
  });
  // Everything that doesn't need the city compiles meanwhile.
  const lowQuality = params.get('quality') === 'low';
  const carEntry = MODELS.spinner;
  const carMesh = buildModelMesh(carEntry.build());
  const car = new CarRenderer(gpu.device);
  const rain = new Rain(gpu.device, lowQuality ? 18000 : 35000);
  const canopy = new Canopy(gpu.device);
  const staticReady = Promise.all([
    renderer.initStatic(),
    track(car.init(carMesh, renderer.sceneLayout)),
    track(rain.init(renderer.sceneLayout)),
    track(canopy.init()),
  ]);
  void staticReady.then(() => (startupMs.static = performance.now() - tStart));
  // The city and everything built from it. Rebuilt in place on a theme
  // switch; the draw hooks below read these variables each frame.
  const toCity = (g: GeneratedCity) => ({
    ...g.city,
    segments: SegmentList.fromTransfer(g.city.segments),
  });
  let city!: ReturnType<typeof toCity>;
  let signs!: GeneratedCity['signs'];
  let genMs = 0;
  let flight!: FlightPath;
  let adData!: GeneratedCity['ads'];
  let cableRenderer!: CableRenderer;
  let ads!: AdSystem;
  let traffic!: Traffic;
  const dynamicLights = new Float32Array(16 * LIGHT_FLOATS);
  void DYNAMIC_LIGHTS;
  const adState = {time: 0, camVel: [0, 0, 0] as [number, number, number]};
  // Traffic: a coarse tessellation of the hero car stands in for traffic.
  const trafficMesh = buildModelMesh(carEntry.build(), 3);

  async function buildWorld(gen: GeneratedCity) {
    city = toCity(gen);
    signs = gen.signs;
    genMs = gen.genMs;
    flight = new FlightPath(seed, city.obstacles);
    adData = gen.ads;
    await renderer.initScene({
      segments: city.segments,
      signs: gen.signs,
      lights: gen.lights,
      districts: city.districts,
    });
    // Exposed for test scripts (hologram visibility along the route, etc.).
    const dbg = (window as unknown as {__debug?: Record<string, unknown>})
      .__debug;
    (window as unknown as {__debug: unknown}).__debug = {
      ...dbg,
      holograms: adData.holograms,
      pose: (t: number) => flight.pose(t),
      unwarp,
      track: (t: number) => flight.trackPoint(t),
      isClear: makeClearanceTest(city.segments),
      duration: flight.duration,
    };
    renderer.details.setBlockers(adData.screens);
    renderer.flareSources = city.flares;
    // Xenon searchlights from the tallest roofs, apart by the theme's
    // density (ART_BIBLE.md 15.5).
    for (const r of [...city.roofs].sort((a, b) => b[1] - a[1])) {
      if (r[1] < 280) break;
      const src = renderer.volume.beamSources;
      const gap = 350 / Math.sqrt(cityTheme.beams);
      if (src.some(q => Math.hypot(q[0] - r[0], q[2] - r[2]) < gap)) continue;
      src.push([r[0], r[1] + 2, r[2]]);
    }
    // Dynamic light slots: 0-15 the car (CPU), 16-1023 ad screens (GPU),
    // 1024+ traffic (GPU).
    const cr = new CableRenderer(gpu.device, city.cables);
    const ad = new AdSystem(
      gpu.device,
      adData.tiles,
      adData.screens,
      adData.holograms,
      renderer.lights.staticCount + SCREEN_LIGHT_SLOT,
      SCREEN_LIGHT_SLOTS,
    );
    const tr = new Traffic(gpu.device, generateTraffic(seed), 1024, 1024);
    await Promise.all([
      track(cr.init(renderer.sceneLayout)),
      track(
        ad.init(
          renderer.sceneLayout,
          renderer.signs.glyphAtlas,
          renderer.lights.lightBuffer,
        ),
      ),
      track(
        tr.init(
          renderer.frameLayout,
          renderer.sceneLayout,
          renderer.lights.lightBuffer,
          trafficMesh,
        ),
      ),
    ]);
    cableRenderer = cr;
    ads = ad;
    traffic = tr;
  }

  const gen = await generated;
  startupMs.cityArrived = performance.now() - tStart;
  await buildWorld(gen);
  startupMs.scene = performance.now() - tStart;
  // Quality preset: low drops SSR and thins the rain.
  renderer.ssr.enabled =
    params.get('quality') !== 'low' && params.get('ssr') !== '0';
  renderer.opaqueDrawers.push(pass =>
    car.drawOpaque(pass, renderer.sceneBindGroup, renderer.targets),
  );
  renderer.transparentDrawers.push(pass =>
    car.drawGlass(pass, renderer.sceneBindGroup, renderer.targets),
  );
  renderer.transparentDrawers.push(pass =>
    car.drawGlow(pass, renderer.sceneBindGroup, renderer.targets),
  );
  renderer.opaqueDrawers.push(p =>
    cableRenderer.draw(p, renderer.sceneBindGroup),
  );
  renderer.preLightHooks.push(e =>
    traffic.update(
      e,
      renderer.frameBindGroup,
      renderer.lights.lightBuffer,
      renderer.lights.staticCount,
      renderer.frame.viewProjNoJitter,
      adState.camVel,
    ),
  );
  renderer.opaqueDrawers.push(p =>
    traffic.drawMeshes(p, renderer.sceneBindGroup),
  );
  renderer.transparentDrawers.push(p =>
    traffic.drawSprites(p, renderer.sceneBindGroup),
  );
  renderer.preLightHooks.push(e => {
    ads.update(e, renderer.frame.camPos, adState.time);
    ads.writeLights(e);
  });
  renderer.opaqueDrawers.push(p => ads.drawScreens(p, renderer.sceneBindGroup));
  renderer.transparentDrawers.unshift(p =>
    ads.drawHolograms(p, renderer.sceneBindGroup, renderer.targets),
  );
  rain.intensity = Number(params.get('rain') ?? 1) * weatherParticles;
  renderer.computeHooks.push(e => rain.compute(e, renderer.sceneBindGroup));
  renderer.transparentDrawers.push(p =>
    rain.render(p, renderer.sceneBindGroup),
  );
  await staticReady;
  startupMs.late = performance.now() - tStart;
  car.setCanopyFx(canopy.fxView);
  const canopyState = {dt: 0, time: 0, speed: 0, pov: false};
  renderer.computeHooks.push(e =>
    canopy.run(
      e,
      canopyState.dt,
      canopyState.time,
      canopyState.speed,
      rain.intensity,
      canopyState.pov,
    ),
  );
  const camera = new Camera();
  const chase = new ChaseCamera();
  // Drag/pinch/wheel on the canvas orbits the car; the auto camera takes
  // over again 6 s after the last input.
  const orbit = new OrbitControl(canvas);
  let wasOrbit = false;
  // Was the camera in the cockpit last frame (orbit starts outside then).
  let wasInside = false;
  let lastOrbit: {eye: Vec3; target: Vec3} | null = null;
  (
    window as unknown as {__debug: Record<string, unknown>}
  ).__debug.orbitActive = () => orbit.active;
  (window as unknown as {__debug: Record<string, unknown>}).__debug.cameraPos =
    () => camera.position;
  if (params.get('shot') !== null) chase.fixedShot = Number(params.get('shot'));
  const settings: RenderSettings = {
    fogColor: cityTheme.fogLow,
    fogDensity: 0.0009 * cityTheme.fogDensity,
    fogHeightFalloff: 0.0022,
    rain: weatherRain,
    wetness: Math.min(1, weatherRain * 2),
    exposure: 1,
    cityGlow: 1,
    debugView: Number(params.get('debug') ?? 0),
    quality: params.get('quality') === 'low' ? 0 : 1,
    taa: params.get('taa') !== '0',
    occlusion: params.get('occlusion') !== '0',
  };
  const camParam = params.get('cam');
  // UI state: defaults, then saved settings, then URL parameters.
  const ui: UiState = {...DEFAULTS, ...loadSaved()};
  ui.camera =
    camParam === 'pov'
      ? CameraMode.Cockpit
      : camParam === 'skyline'
        ? CameraMode.Skyline
        : camParam === 'map'
          ? CameraMode.Map
          : CameraMode.Chase;
  if (params.has('shot')) ui.shot = Number(params.get('shot'));
  if (params.has('rain')) ui.rain = Number(params.get('rain'));
  if (params.get('mute') === '1') ui.sound = false;
  if (params.get('ssr') === '0' || params.get('quality') === 'low')
    ui.ssr = false;
  if (params.get('taa') === '0') ui.taa = false;
  if (params.get('details') === '0') ui.details = false;
  if (params.get('ao') === '0') ui.ao = false;
  if (params.get('quality') === 'low') renderer.details.distScale = 0.5;
  if (params.has('hud')) ui.hud = params.get('hud') === '1';
  ui.paused = params.get('paused') === '1';
  // Inspection cameras: cam=screen|holo|roof&n=K frame an ad, a hologram
  // or an exposed roof.
  const inspect =
    camParam === 'screen' ||
    camParam === 'holo' ||
    camParam === 'roof' ||
    camParam === 'facade' ||
    camParam === 'horizon' ||
    camParam === 'water'
      ? camParam
      : null;
  const inspectN = Number(params.get('n') ?? 0);
  let renderBlocked = false;
  let roofList: Segment[] | undefined;
  let facadeList: typeof city.slots | undefined;
  let waterList: Segment[] | undefined;
  let horizonEye: [number, number, number] | undefined;
  let time = Number(params.get('t') ?? 0);
  // anim=S offsets animation time only (camera stays put): for flicker tests.
  const animOffset =
    Number(params.get('anim') ?? 0) - (params.has('anim') ? time : 0);

  const audio = new Ambience(seed);
  audio.setMuted(!ui.sound);
  // Start sound on the first touch, click or key. Mobile Safari only
  // unlocks audio on touchend/click (not pointerdown), so listen to all of
  // them, in the capture phase (UI buttons stop propagation), until the
  // context is actually running.
  const gestures = ['pointerdown', 'touchend', 'click', 'keydown'];
  const startAudio = (e?: Event) => {
    // The sound button decides for itself (main sets onSoundClick).
    if ((e?.target as Element | null)?.closest?.('#ui-sound-btn')) return;
    if (!ui.sound) return;
    audio.start();
    if (audio.running) {
      for (const g of gestures) {
        window.removeEventListener(g, startAudio, true);
      }
    }
  };
  for (const g of gestures) {
    window.addEventListener(g, startAudio, {capture: true, passive: true});
  }
  (
    window as unknown as {__debug: Record<string, unknown>}
  ).__debug.audioRunning = () => audio.running;

  // Apply a UI setting to the renderer/simulation.
  const apply = (key: keyof UiState) => {
    switch (key) {
      case 'sound':
        if (ui.sound) audio.start();
        audio.setMuted(!ui.sound);
        break;
      case 'volume':
        audio.setVolume(ui.volume);
        break;
      case 'rain':
        // The theme's weather scales the rain (other weather has its own
        // particles; it isn't rain, so nothing gets wet).
        rain.intensity = ui.rain * weatherParticles;
        settings.rain = ui.rain * weatherRain;
        settings.wetness = Math.min(1, ui.rain * weatherRain * 2);
        break;
      case 'haze':
        settings.fogDensity = 0.0009 * cityTheme.fogDensity * ui.haze;
        break;
      case 'exposure':
        settings.exposure = ui.exposure;
        break;
      case 'ssr':
        renderer.ssr.enabled = ui.ssr;
        break;
      case 'volumetrics':
        renderer.volume.enabled = ui.volumetrics;
        break;
      case 'taa':
        settings.taa = ui.taa;
        break;
      case 'details':
        renderer.details.enabled = ui.details;
        break;
      case 'ao':
        renderer.ssao.enabled = ui.ao;
        break;
      case 'camera':
        chase.fixedShot = ui.shot;
        // A camera change ends a user orbit right away.
        orbit.release();
        break;
    }
  };
  (
    [
      'volume',
      'rain',
      'haze',
      'exposure',
      'ssr',
      'volumetrics',
      'taa',
      'details',
      'ao',
      'camera',
    ] as const
  ).forEach(apply);
  const controls = new Controls(ui, apply);
  const showCityLink = () => {
    // Link to exactly this city (theme + seed).
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('theme', cityTheme.name);
    u.searchParams.set('seed', String(userSeed));
    controls.setCity(`${cityTheme.label} #${userSeed}`, u.href);
  };
  showCityLink();
  // T / the globe: the next theme's city is generated in the worker while
  // this one keeps flying (and the music keeps playing); then the GPU data
  // is swapped in during a short pause in drawing. No page reload.
  let switching = false;
  nextTheme = () => {
    if (switching) return;
    switching = true;
    const next = THEMES[(THEMES.indexOf(cityTheme) + 1) % THEMES.length];
    const nextSeed =
      hashCombine(userSeed, THEMES.indexOf(next) + 1) & 0x7fffffff;
    controls.showToast(`Building ${next.label}…`);
    void generate(nextSeed, next.name, () => {})
      .then(async g => {
        renderBlocked = true;
        cityTheme = setTheme(next.name);
        seed = nextSeed;
        updateWeather();
        await buildWorld(g);
        roofList = undefined;
        facadeList = undefined;
        waterList = undefined;
        horizonEye = undefined;
        settings.fogColor = cityTheme.fogLow;
        apply('rain');
        apply('haze');
        showCityLink();
        controls.showToast(cityTheme.label);
      })
      .catch(e => showError(String(e)))
      .finally(() => {
        renderBlocked = false;
        switching = false;
      });
  };
  controls.onThemeClick = () => nextTheme();
  controls.onSoundClick = () => {
    // Silent (not yet unlocked, or muted): turn it on; playing: off.
    ui.sound = !(ui.sound && audio.running);
    apply('sound');
    controls.refresh();
  };
  (window as unknown as {__ui: UiState}).__ui = ui; // for test/ui.mjs
  // Screenshot/test runs (paused=1, nohelp=1 or ui=0) hide the overlay UI.
  if (ui.paused || params.get('nohelp') === '1' || params.get('ui') === '0') {
    document.getElementById('help')!.style.display = 'none';
    controls.setVisible(false);
  }

  window.addEventListener('keydown', e => {
    // Arrows/space belong to a focused slider or checkbox; other keys work.
    if (
      e.target instanceof HTMLInputElement &&
      (e.key.startsWith('Arrow') || e.key === ' ')
    )
      return;
    if (e.key === 'm' || e.key === 'M') {
      ui.sound = !ui.sound;
      apply('sound');
    } else {
      startAudio();
    }
    if (e.key === 't' || e.key === 'T') {
      nextTheme();
    } else if (e.key === 'c' || e.key === 'C') {
      // Exactly what the camera button does.
      controls.closeAll();
      controls.cycleCamera();
    } else if (e.key === ' ') {
      ui.paused = !ui.paused;
      e.preventDefault();
    } else if (e.key === 'h' || e.key === 'H') ui.hud = !ui.hud;
    else if (e.key >= '1' && e.key <= '5') {
      // Pick a chase framing (0 cycles automatically again).
      ui.camera = CameraMode.Chase;
      ui.shot = Number(e.key) - 1;
      apply('camera');
    } else if (e.key === '0') {
      ui.camera = CameraMode.Chase;
      ui.shot = undefined;
      apply('camera');
    }
    controls.refresh();
  });

  let last = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;
  function frame(now: number) {
    if (renderBlocked) {
      // Swapping in a new city: keep the last frame, keep the music going.
      audio.update();
      requestAnimationFrame(frame);
      return;
    }
    // rAF timestamps can precede the performance.now() taken at startup.
    const realDt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    fpsAccum += realDt;
    fpsFrames++;
    if (fpsAccum > 0.5) {
      fps = fpsFrames / fpsAccum;
      fpsAccum = 0;
      fpsFrames = 0;
    }
    const dt = ui.paused ? 0 : realDt * ui.timeScale;
    time += dt;
    const pose = flight.pose(time);
    renderer.carToWorld = pose.matrix;
    renderer.cameraMode = ui.camera;
    const orbitOn = orbit.active && ui.camera !== CameraMode.Map;
    // The auto director goes inside the car now and then (chase mode,
    // automatic framings only).
    const inside =
      ui.camera === CameraMode.Chase &&
      chase.fixedShot === undefined &&
      !orbitOn
        ? insideAt(time)
        : -1;
    const inCockpit =
      !orbitOn && (ui.camera === CameraMode.Cockpit || inside >= 0);
    // Driver's eye view, looking (yaw, pitch) away from straight ahead.
    const cockpitCam = (yaw: number, pitch: number) => {
      const m = pose.matrix;
      const eye = transformPoint(m, carEntry.driverEye);
      const cp = Math.cos(pitch);
      const look = transformDir(m, [
        Math.sin(yaw) * cp,
        Math.sin(pitch),
        -Math.cos(yaw) * cp,
      ]);
      camera.camToWorld = lookAtCamera(
        eye,
        [eye[0] + look[0] * 10, eye[1] + look[1] * 10, eye[2] + look[2] * 10],
        // Level the horizon most of the way (limit roll from the bank).
        [pose.up[0] * 0.35, 0.65 + pose.up[1] * 0.35, pose.up[2] * 0.35],
      );
      camera.fovY = (70 * Math.PI) / 180;
    };
    if (wasOrbit && !orbitOn && lastOrbit) {
      // Hand back to the chase camera without a cut.
      chase.resumeFrom(lastOrbit.eye, lastOrbit.target, pose, time);
    }
    wasOrbit = orbitOn;
    if (ui.camera === CameraMode.Map) {
      // Top-down view over the car (layout inspection).
      const p = pose.position;
      camera.camToWorld = lookAtCamera([p[0], 3200, p[2] + 1], [p[0], 0, p[2]]);
      camera.fovY = (50 * Math.PI) / 180;
    } else if (camParam === 'cable' && city.cables.length) {
      // Look along an inner street at a cable (lanterns first).
      const withLanterns = city.cables.filter(c => c.lanterns);
      const list = withLanterns.length ? withLanterns : city.cables;
      const c = list[inspectN % list.length];
      const mid: [number, number, number] = [
        (c.a[0] + c.b[0]) / 2,
        (c.a[1] + c.b[1]) / 2 - c.sag,
        (c.a[2] + c.b[2]) / 2,
      ];
      const dx = c.b[0] - c.a[0];
      const dz = c.b[2] - c.a[2];
      const l = Math.hypot(dx, dz) || 1;
      camera.camToWorld = lookAtCamera(
        [mid[0] - (dz / l) * 30, mid[1] + 4, mid[2] + (dx / l) * 30],
        mid,
      );
      camera.fovY = (60 * Math.PI) / 180;
    } else if (inspect === 'water') {
      // A harbour/river cell (n-th nearest the centre), seen from 150 m up
      // on its shore. Falls back to the centre for a drowned city.
      waterList ??= (() => {
        const out: Segment[] = [];
        for (let i = 0; i < city.segments.count; i++) {
          const g = city.segments.get(i);
          if (g.style === 11) out.push(g);
        }
        return out.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
      })();
      const g = waterList[inspectN % Math.max(1, waterList.length)];
      const c: [number, number, number] =
        g && g.sx < 2000 ? [g.x, 0, g.z] : [0, 0, 0];
      camera.camToWorld = lookAtCamera(
        [c[0] - 260, 45, c[2] - 160],
        [c[0] + 300, 20, c[2] + 200],
      );
      camera.fovY = (60 * Math.PI) / 180;
    } else if (inspect === 'horizon') {
      // Looking out from 500 m up at azimuth n x 45 degrees (landscape).
      const a = (inspectN * Math.PI) / 4;
      // (high=1: from 3 km up, above every building, at the horizon.)
      // 900 m up clears every tower, so the landscape is in view.
      const hy = params.get('high') === '1' ? 3000 : 900;
      // Start from the first spot (spiralling out from the centre) with a
      // clear 1.5 km line of sight, so no tower fills the frame.
      horizonEye ??= (() => {
        const clear = makeClearanceTest(city.segments);
        const dx = Math.cos(a);
        const dz = Math.sin(a);
        for (let r = 0; r < 4000; r += 150) {
          for (let k = 0; k < 8; k++) {
            const ox = Math.cos(k * 0.785) * r;
            const oz = Math.sin(k * 0.785) * r;
            let ok = true;
            for (let t = 0; t <= 1500 && ok; t += 100) {
              ok = clear(ox + dx * t, oz + dz * t, 40, hy - 120, hy + 40);
            }
            if (ok) return [ox, hy, oz] as [number, number, number];
          }
        }
        return [0, hy, 0] as [number, number, number];
      })();
      const e = horizonEye;
      camera.camToWorld = lookAtCamera(e, [
        e[0] + Math.cos(a) * 1000,
        hy - 30,
        e[2] + Math.sin(a) * 1000,
      ]);
      camera.fovY = (60 * Math.PI) / 180;
    } else if (inspect === 'facade') {
      // A residential/slum facade from ~30 m, slightly off-axis and above.
      // d=K limits it to one district (2 = slum, 3 = market...).
      const dist = params.has('d') ? Number(params.get('d')) : -1;
      facadeList ??= city.slots.filter(
        sl =>
          sl.width > 25 &&
          (dist >= 0
            ? sl.district === dist && sl.height > 20
            : sl.height > 40 && sl.district !== 0),
      );
      const sl = facadeList[inspectN % facadeList.length];
      const y = sl.y + Math.min(sl.height * 0.5, 60);
      const t: [number, number, number] = [sl.x, y, sl.z];
      camera.camToWorld = lookAtCamera(
        [sl.x + sl.nx * 30 + sl.nz * 12, y + 6, sl.z + sl.nz * 30 - sl.nx * 12],
        t,
      );
      camera.fovY = (55 * Math.PI) / 180;
    } else if (inspect === 'roof') {
      roofList ??= exposedRoofs(city.segments);
      const g = roofList[inspectN % roofList.length];
      const top: [number, number, number] = [g.x, g.y + g.sy, g.z];
      const r = Math.max(g.sx, g.sz) * g.taper;
      camera.camToWorld = lookAtCamera(
        [top[0] + r * 0.9, top[1] + r * 0.6, top[2] + r * 0.7],
        top,
      );
      camera.fovY = (55 * Math.PI) / 180;
    } else if (inspect === 'screen' && adData.screens.length) {
      const sc = adData.screens[inspectN % adData.screens.length];
      const dist = Math.max(sc.width, sc.height) * 1.3;
      const eye: [number, number, number] = [
        sc.pos[0] + sc.normal[0] * dist + sc.right[0] * dist * 0.3,
        sc.pos[1] + dist * 0.05,
        sc.pos[2] + sc.normal[2] * dist + sc.right[2] * dist * 0.3,
      ];
      camera.camToWorld = lookAtCamera(eye, sc.pos);
      camera.fovY = (50 * Math.PI) / 180;
    } else if (inspect === 'holo' && adData.holograms.length) {
      const h = adData.holograms[inspectN % adData.holograms.length];
      const c: [number, number, number] = [
        h.pos[0],
        h.pos[1] + h.scale,
        h.pos[2],
      ];
      const a = time * 0.05;
      // Giants stand in avenue intersections: look down the open avenue.
      const eye: [number, number, number] =
        h.pos[1] === 0
          ? [c[0] + h.scale * 3, c[1], c[2]]
          : [
              c[0] + Math.cos(a) * h.scale * 4,
              c[1] + h.scale * 0.3,
              c[2] + Math.sin(a) * h.scale * 4,
            ];
      camera.camToWorld = lookAtCamera(eye, c);
      camera.fovY = (50 * Math.PI) / 180;
    } else if (orbitOn) {
      const f = pose.forward;
      const cw = camera.camToWorld;
      const o = orbit.update(
        pose.position,
        Math.atan2(-f[0], -f[2]),
        camera.position,
        [
          camera.position[0] - cw[8],
          camera.position[1] - cw[9],
          camera.position[2] - cw[10],
        ],
        (camera.fovY * 180) / Math.PI,
        wasInside,
      );
      lastOrbit = o;
      camera.camToWorld = lookAtCamera(o.eye, o.target);
      camera.fovY = (orbit.fov * Math.PI) / 180;
    } else if (inside >= 0) {
      const [yaw, pitch] = lookAround(inside, time);
      cockpitCam(yaw, pitch);
    } else if (ui.camera === CameraMode.Skyline) {
      // Establishing shot: slowly orbit high above the car's area.
      const a = time * 0.02;
      const p = pose.position;
      camera.camToWorld = lookAtCamera(
        [p[0] + Math.cos(a) * 1600, 1150, p[2] + Math.sin(a) * 1600],
        [p[0], 250, p[2]],
      );
      camera.fovY = (50 * Math.PI) / 180;
    } else if (ui.camera === CameraMode.Chase) {
      const c = chase.update(pose, time, dt);
      camera.camToWorld = lookAtCamera(c.eye, c.target, c.up);
      camera.fovY = (chase.fov * Math.PI) / 180;
    } else {
      // Cockpit: the driver's eye, looking slightly down over the dash.
      cockpitCam(Math.sin(time * 0.6) * 0.03, -0.12);
    }
    if (!orbitOn) wasInside = inCockpit;
    const cl = carLights(pose.matrix, time);
    packLights(cl, dynamicLights);
    renderer.lights.writeDynamic(dynamicLights, 16);
    adState.time = time;
    adState.camVel = [
      pose.forward[0] * pose.speed,
      pose.forward[1] * pose.speed,
      pose.forward[2] * pose.speed,
    ];
    Object.assign(canopyState, {
      dt: Math.max(dt, ui.paused ? 1 / 60 : 0),
      time,
      speed: pose.speed,
      pov: inCockpit,
    });
    audio.update();
    rain.setFrame(camera.position, camera.forward, [
      pose.forward[0] * pose.speed,
      pose.forward[1] * pose.speed,
      pose.forward[2] * pose.speed,
    ]);
    renderer.volume.updateBeams(camera.position, time + animOffset);
    renderer.render(camera, time + animOffset, dt, settings);
    // Opt-in per-frame trace for tests: __debug.trace = [] starts recording.
    const trace = (window as unknown as {__debug: {trace?: number[][]}}).__debug
      .trace;
    if (trace) {
      const cw = camera.camToWorld;
      trace.push([
        time,
        dt,
        ...pose.position,
        cw[12],
        cw[13],
        cw[14],
        -cw[8],
        -cw[9],
        -cw[10],
        cw[4],
        cw[5],
        cw[6],
        cw[0],
        cw[1],
        cw[2],
        camera.fovY,
      ]);
    }
    controls.updateSound(ui.sound && audio.running);
    if (ui.hud) {
      hud.textContent =
        `${fps.toFixed(0)} fps  ${canvas.width}x${canvas.height}\n` +
        `segments ${renderer.city.count}  holograms ${adData.holograms.length}  screens ${adData.screens.length}  traffic ${traffic.count} (${trafficMesh.triangleCount} tris)  signs ${signs.count}  lights ${renderer.lights.staticCount}  gen ${genMs.toFixed(0)} ms\n` +
        `t ${time.toFixed(1)}s  speed ${(pose.speed * 3.6).toFixed(0)} km/h  alt ${pose.position[1].toFixed(0)} m` +
        `\nvisible segments ${renderer.city.visibleSegments}` +
        (renderer.timer.enabled
          ? '\n' +
            Object.entries(renderer.timer.results)
              .map(([k, v]) => `${k.padEnd(18)} ${v.toFixed(2)} ms`)
              .join('\n') +
            `\nGPU frame ${renderer.timer.frameMs.toFixed(2)} ms`
          : '\n(no timestamp-query)');
    } else {
      hud.textContent = '';
    }
    (window as unknown as {__stats: unknown}).__stats = {
      fps,
      segments: renderer.city.count,
      genMs,
      startupMs,
      time,
      visibleSegments: renderer.city.visibleSegments,
      holograms: adData.holograms.length,
      details: renderer.details.counts,
      detailSegs: renderer.details.nearCount,
      cables: cableRenderer.cableCount,
      lanterns: cableRenderer.lanternCount,
      gpu: renderer.timer.results,
      gpuFrameMs: renderer.timer.frameMs,
    };
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  startupMs.toReady = performance.now() - tShaders;
  startupMs.total = performance.now() - tStart;
  loadmsg.textContent = 'Ready';
  loadmsg.classList.add('done');
  (window as unknown as {__ready: boolean}).__ready = true;
}

main().catch(e => {
  console.error(e);
  loadmsg.textContent = `Failed: ${e.message ?? e}`;
  showError(String(e.stack ?? e));
});

/** Mid-height exposed roofs carrying rooftop massing (inspection camera). */
function exposedRoofs(segs: SegmentList): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < segs.count; i++) {
    const g = segs.get(i);
    const top = g.y + g.sy;
    if ((g.flags & SegFlags.RoofExposed) === 0 || top < 40 || top > 250)
      continue;
    if (Math.min(g.sx, g.sz) * g.taper < 18 || g.shape > 1) continue;
    out.push(g);
  }
  return out;
}
