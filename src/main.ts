// Entry point: boots WebGPU, generates the city and runs the main loop.
//
// URL params:
//   seed=N        world seed
//   t=SECONDS     start time along the flight path
//   cam=chase|pov camera mode
//   paused=1      freeze time (deterministic screenshots)
//   hud=1         show stats
//   debug=N       debug view (see renderer)
//   quality=low|high
import {initGpu, onGpuError} from './gpu/gpu';
import {Renderer, type RenderSettings} from './render/renderer';
import {Camera} from './camera/camera';
import {generateCity} from './city/generate';
import {FlightPath, ChaseCamera} from './camera/flight';
import {lookAtCamera} from './math/vec';

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
  const genMs = performance.now() - t0;
  const renderer = new Renderer(gpu);
  loadmsg.textContent = 'Compiling shaders';
  await renderer.init(city.segments);
  const camera = new Camera();
  const chase = new ChaseCamera();
  const settings: RenderSettings = {
    fogColor: [0.085, 0.045, 0.06],
    fogDensity: 0.0009,
    fogHeightFalloff: 0.0022,
    rain: 1,
    wetness: 1,
    exposure: 1,
    cityGlow: 1,
    debugView: Number(params.get('debug') ?? 0),
    quality: params.get('quality') === 'low' ? 0 : 1,
  };
  let cameraMode = params.get('cam') === 'pov' ? 1 : 0;
  let paused = params.get('paused') === '1';
  let showHud = params.get('hud') === '1';
  let time = Number(params.get('t') ?? 0);

  window.addEventListener('keydown', e => {
    if (e.key === 'c' || e.key === 'C') cameraMode = 1 - cameraMode;
    else if (e.key === ' ') paused = !paused;
    else if (e.key === 'h' || e.key === 'H') showHud = !showHud;
    else if (e.key >= '1' && e.key <= '5') time = [20, 95, 170, 260, 340][Number(e.key) - 1];
  });

  let last = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;
  function frame(now: number) {
    const realDt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fpsAccum += realDt;
    fpsFrames++;
    if (fpsAccum > 0.5) {
      fps = fpsFrames / fpsAccum;
      fpsAccum = 0;
      fpsFrames = 0;
    }
    const dt = paused ? 0 : realDt;
    time += dt;
    const pose = flight.pose(time);
    renderer.carToWorld = pose.matrix;
    renderer.cameraMode = cameraMode;
    if (cameraMode === 0) {
      const c = chase.update(pose, time, Math.max(dt, 1 / 60));
      camera.camToWorld = lookAtCamera(c.eye, c.target, c.up);
      camera.fovY = (55 * Math.PI) / 180;
    } else {
      const eye = pose.position;
      camera.camToWorld = lookAtCamera(
        [eye[0] + pose.up[0] * 1.2, eye[1] + pose.up[1] * 1.2, eye[2] + pose.up[2] * 1.2],
        [eye[0] + pose.forward[0] * 50, eye[1] + pose.forward[1] * 50 - 3, eye[2] + pose.forward[2] * 50],
        pose.up,
      );
      camera.fovY = (70 * Math.PI) / 180;
    }
    renderer.render(camera, time, dt, settings);
    if (showHud) {
      hud.textContent =
        `${fps.toFixed(0)} fps  ${canvas.width}x${canvas.height}\n` +
        `segments ${renderer.city.count}  gen ${genMs.toFixed(0)} ms\n` +
        `t ${time.toFixed(1)}s  speed ${(pose.speed * 3.6).toFixed(0)} km/h  alt ${pose.position[1].toFixed(0)} m`;
    } else {
      hud.textContent = '';
    }
    (window as unknown as {__stats: unknown}).__stats = {
      fps,
      segments: renderer.city.count,
      genMs,
      time,
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
