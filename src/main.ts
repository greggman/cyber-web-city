// Entry point: boots WebGPU, generates the city and runs the main loop.
//
// URL params:
//   seed=N        world seed
//   t=SECONDS     start time along the flight path
//   cam=chase|pov|skyline|map camera mode (skyline: establishing shot; map: top-down)
//   cam=facade&n=K[&d=D]  inspect a building face (optionally of district D)
//   paused=1      freeze time (deterministic screenshots)
//   anim=S        animation time S with the camera at t (flicker tests)
//   hud=1         show stats
//   debug=N       debug view (see renderer)
//   quality=low|high
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
const seed = Number(params.get('seed') ?? 1);

const tStart = performance.now();
const startupMs: Record<string, number> = {};

async function main() {
  onGpuError(showError);
  const canvas = document.getElementById('c') as HTMLCanvasElement;
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
    loadmsg.textContent = `${g}\nCompiling shaders ${shadersDone}/${shadersTotal}`;
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
  const worker = new Worker('city-worker.js', {type: 'module'});
  const generated = new Promise<GeneratedCity>((resolve, reject) => {
    worker.onerror = e => reject(new Error(`city worker: ${e.message}`));
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'progress') {
        genF = e.data.f;
        showProgress();
      } else {
        genF = 1;
        showProgress();
        resolve(e.data as GeneratedCity);
        worker.terminate();
      }
    };
  });
  worker.postMessage({seed});
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
  const gen = await generated;
  startupMs.cityArrived = performance.now() - tStart;
  const city = {
    ...gen.city,
    segments: SegmentList.fromTransfer(gen.city.segments),
  };
  const {signs, lights} = gen;
  const genMs = gen.genMs;
  const flight = new FlightPath(seed, city.obstacles);
  await renderer.initScene({
    segments: city.segments,
    signs,
    lights,
    districts: city.districts,
  });
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
  // Dynamic light slots: 0-15 the car (CPU), 16-1023 ad screens (GPU),
  // 1024+ traffic (GPU).
  const cableRenderer = new CableRenderer(gpu.device, city.cables);
  const lateInits: Promise<unknown>[] = [
    track(cableRenderer.init(renderer.sceneLayout)),
  ];
  renderer.opaqueDrawers.push(p =>
    cableRenderer.draw(p, renderer.sceneBindGroup),
  );
  const dynamicLights = new Float32Array(16 * LIGHT_FLOATS);
  void DYNAMIC_LIGHTS;
  const adData = gen.ads;
  // Exposed for test scripts (hologram visibility along the route, etc.).
  (window as unknown as {__debug: unknown}).__debug = {
    holograms: adData.holograms,
    pose: (t: number) => flight.pose(t),
    unwarp,
    track: (t: number) => flight.trackPoint(t),
    isClear: makeClearanceTest(city.segments),
    duration: flight.duration,
  };
  renderer.details.setBlockers(adData.screens);
  // Xenon searchlights from the tallest roofs, at least 350 m apart
  // (ART_BIBLE.md 15.5).
  for (const r of [...city.roofs].sort((a, b) => b[1] - a[1])) {
    if (r[1] < 280) break;
    const src = renderer.volume.beamSources;
    if (src.some(q => Math.hypot(q[0] - r[0], q[2] - r[2]) < 350)) continue;
    src.push([r[0], r[1] + 2, r[2]]);
  }
  const ads = new AdSystem(
    gpu.device,
    adData.tiles,
    adData.screens,
    adData.holograms,
    renderer.lights.staticCount + SCREEN_LIGHT_SLOT,
    SCREEN_LIGHT_SLOTS,
  );
  lateInits.push(
    track(
      ads.init(
        renderer.sceneLayout,
        renderer.signs.glyphAtlas,
        renderer.lights.lightBuffer,
      ),
    ),
  );
  const adState = {time: 0, camVel: [0, 0, 0] as [number, number, number]};
  // Traffic: a coarse tessellation of the hero car stands in for traffic.
  const trafficMesh = buildModelMesh(carEntry.build(), 3);
  const traffic = new Traffic(gpu.device, generateTraffic(seed), 1024, 1024);
  lateInits.push(
    track(
      traffic.init(
        renderer.frameLayout,
        renderer.sceneLayout,
        renderer.lights.lightBuffer,
        trafficMesh,
      ),
    ),
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
  rain.intensity = Number(params.get('rain') ?? 1);
  renderer.computeHooks.push(e => rain.compute(e, renderer.sceneBindGroup));
  renderer.transparentDrawers.push(p =>
    rain.render(p, renderer.sceneBindGroup),
  );
  await Promise.all([staticReady, ...lateInits]);
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
    fogColor: [0.05, 0.035, 0.022], // Smog Amber (ART_BIBLE.md 15.5)
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
  // Inspection cameras: cam=screen|holo|roof&n=K frame an ad, a hologram
  // or an exposed roof.
  const inspect =
    camParam === 'screen' ||
    camParam === 'holo' ||
    camParam === 'roof' ||
    camParam === 'facade'
      ? camParam
      : null;
  const inspectN = Number(params.get('n') ?? 0);
  let roofList: Segment[] | undefined;
  let facadeList: typeof city.slots | undefined;
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
    if (e.key === 'c' || e.key === 'C') {
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
