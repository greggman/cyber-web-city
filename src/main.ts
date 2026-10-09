// Entry point: boots WebGPU, generates the city and runs the main loop.
//
// URL params:
//   seed=N        world seed
//   t=SECONDS     start time along the flight path
//   cam=chase|pov|skyline|map camera mode (skyline: establishing shot; map: top-down)
//   paused=1      freeze time (deterministic screenshots)
//   anim=S        animation time S with the camera at t (flicker tests)
//   hud=1         show stats
//   debug=N       debug view (see renderer)
//   quality=low|high
import {initGpu, onGpuError} from './gpu/gpu';
import {Renderer, type RenderSettings} from './render/renderer';
import {Camera} from './camera/camera';
import {generateCity, makeClearanceTest} from './city/generate';
import {unwarp} from './city/warp';
import {generateSigns, brandGlyphs} from './city/signs';
import {generateAds} from './city/ads';
import {AdSystem, SCREEN_LIGHT_SLOT, SCREEN_LIGHT_SLOTS} from './render/ads';
import {FlightPath, ChaseCamera} from './camera/flight';
import {lookAtCamera, transformPoint, transformDir} from './math/vec';
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
const seed = Number(params.get('seed') ?? 1);

async function main() {
  onGpuError(showError);
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const gpu = await initGpu(canvas);
  loadmsg.textContent = 'Generating city';
  await new Promise(r => setTimeout(r, 0));
  const t0 = performance.now();
  const city = generateCity(seed);
  const flight = new FlightPath(seed, city.obstacles);
  const {signs, lights} = generateSigns(seed, city.slots);
  const genMs = performance.now() - t0;
  const renderer = new Renderer(gpu);
  loadmsg.textContent = 'Compiling shaders';
  await renderer.init({segments: city.segments, signs, lights});
  // Quality preset: low drops SSR and thins the rain.
  renderer.ssr.enabled =
    params.get('quality') !== 'low' && params.get('ssr') !== '0';
  const carEntry = MODELS.spinner;
  const carMesh = buildModelMesh(carEntry.build());
  const car = new CarRenderer(gpu.device);
  await car.init(carMesh, renderer.sceneLayout);
  renderer.opaqueDrawers.push(pass =>
    car.drawOpaque(pass, renderer.sceneBindGroup, renderer.targets),
  );
  renderer.transparentDrawers.push(pass =>
    car.drawGlass(pass, renderer.sceneBindGroup, renderer.targets),
  );
  renderer.transparentDrawers.push(pass =>
    car.drawGlow(pass, renderer.sceneBindGroup, renderer.targets),
  );
  // Dynamic light slots: 0-15 the car (CPU), 16-1023 ad screens (GPU),
  // 1024+ traffic (GPU).
  const cableRenderer = new CableRenderer(gpu.device, city.cables);
  await cableRenderer.init(renderer.sceneLayout);
  renderer.opaqueDrawers.push(p =>
    cableRenderer.draw(p, renderer.sceneBindGroup),
  );
  const dynamicLights = new Float32Array(16 * LIGHT_FLOATS);
  void DYNAMIC_LIGHTS;
  const adData = generateAds(
    seed,
    city.slots,
    city.roofs,
    city.landmarks,
    r => brandGlyphs(r, false),
    makeClearanceTest(city.segments),
    flight.intersections,
  );
  // Exposed for test scripts (hologram visibility along the route, etc.).
  (window as unknown as {__debug: unknown}).__debug = {
    holograms: adData.holograms,
    pose: (t: number) => flight.pose(t),
    unwarp,
    track: (t: number) => flight.trackPoint(t),
    isClear: makeClearanceTest(city.segments),
    duration: flight.duration,
  };
  const ads = new AdSystem(
    gpu.device,
    adData.tiles,
    adData.screens,
    adData.holograms,
    renderer.lights.staticCount + SCREEN_LIGHT_SLOT,
    SCREEN_LIGHT_SLOTS,
  );
  await ads.init(
    renderer.sceneLayout,
    renderer.signs.glyphAtlas,
    renderer.lights.lightBuffer,
  );
  const adState = {time: 0, camVel: [0, 0, 0] as [number, number, number]};
  // Traffic: a coarse tessellation of the hero car stands in for traffic.
  const trafficMesh = buildModelMesh(carEntry.build(), 3);
  const traffic = new Traffic(gpu.device, generateTraffic(seed), 1024, 1024);
  await traffic.init(
    renderer.frameLayout,
    renderer.sceneLayout,
    renderer.lights.lightBuffer,
    trafficMesh,
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
  const lowQuality = params.get('quality') === 'low';
  const rain = new Rain(gpu.device, lowQuality ? 18000 : 35000);
  await rain.init(renderer.sceneLayout);
  rain.intensity = Number(params.get('rain') ?? 1);
  renderer.computeHooks.push(e => rain.compute(e, renderer.sceneBindGroup));
  renderer.transparentDrawers.push(p =>
    rain.render(p, renderer.sceneBindGroup),
  );
  const canopy = new Canopy(gpu.device);
  await canopy.init();
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
  if (params.get('shot') !== null) chase.fixedShot = Number(params.get('shot'));
  const settings: RenderSettings = {
    fogColor: [0.06, 0.035, 0.055],
    fogDensity: 0.0009,
    fogHeightFalloff: 0.0022,
    rain: 1,
    wetness: 1,
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
  // Inspection cameras: cam=screen&n=K or cam=holo&n=K frame an ad/hologram.
  const inspect =
    camParam === 'screen' || camParam === 'holo' ? camParam : null;
  const inspectN = Number(params.get('n') ?? 0);
  let time = Number(params.get('t') ?? 0);
  // anim=S offsets animation time only (camera stays put): for flicker tests.
  const animOffset =
    Number(params.get('anim') ?? 0) - (params.has('anim') ? time : 0);

  const audio = new Ambience(seed);
  audio.setMuted(!ui.sound);
  const startAudio = () => {
    if (ui.sound) audio.start();
  };
  window.addEventListener('pointerdown', startAudio);

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
        audio.setRain(ui.rain);
        rain.intensity = ui.rain;
        settings.rain = ui.rain;
        settings.wetness = Math.min(1, ui.rain * 2);
        break;
      case 'haze':
        settings.fogDensity = 0.0009 * ui.haze;
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
    if (e.key === 'c' || e.key === 'C') {
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
      const c = chase.update(pose, time, Math.max(dt, 1 / 60));
      camera.camToWorld = lookAtCamera(c.eye, c.target, c.up);
      camera.fovY = (chase.fov * Math.PI) / 180;
    } else {
      // Cockpit: the driver's eye, looking slightly down over the dash.
      const m = pose.matrix;
      const eye = transformPoint(m, carEntry.driverEye);
      const sway = Math.sin(time * 0.6) * 0.03;
      const look = transformDir(m, [sway, -0.12, -1]);
      camera.camToWorld = lookAtCamera(
        eye,
        [eye[0] + look[0] * 10, eye[1] + look[1] * 10, eye[2] + look[2] * 10],
        pose.up,
      );
      camera.fovY = (70 * Math.PI) / 180;
    }
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
      pov: ui.camera === CameraMode.Cockpit,
    });
    audio.setInterior(ui.camera === CameraMode.Cockpit);
    audio.update();
    rain.setFrame(camera.position, camera.forward, [
      pose.forward[0] * pose.speed,
      pose.forward[1] * pose.speed,
      pose.forward[2] * pose.speed,
    ]);
    renderer.render(camera, time + animOffset, dt, settings);
    if (ui.hud) {
      hud.textContent =
        `${fps.toFixed(0)} fps  ${canvas.width}x${canvas.height}\n` +
        `segments ${renderer.city.count}  holograms ${adData.holograms.length}  screens ${adData.screens.length}  traffic ${traffic.count} (${trafficMesh.triangleCount} tris)  signs ${signs.length}  lights ${lights.length}  gen ${genMs.toFixed(0)} ms\n` +
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
  loadmsg.textContent = 'Ready';
  loadmsg.classList.add('done');
  (window as unknown as {__ready: boolean}).__ready = true;
}

main().catch(e => {
  console.error(e);
  loadmsg.textContent = `Failed: ${e.message ?? e}`;
  showError(String(e.stack ?? e));
});
