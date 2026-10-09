import {initGpu, onGpuError} from './gpu/gpu';
import {Renderer, type RenderSettings} from './render/renderer';
import {Camera} from './camera/camera';
import {generateCity} from './city/generate';

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
  const segments = generateCity(seed);
  const renderer = new Renderer(gpu);
  loadmsg.textContent = 'Compiling shaders';
  await renderer.init(segments);
  const camera = new Camera();
  const settings: RenderSettings = {
    fogColor: [0.18, 0.09, 0.12],
    fogDensity: 0.0012,
    fogHeightFalloff: 0.0025,
    rain: 1,
    wetness: 1,
    exposure: 1,
    cityGlow: 1,
    debugView: 0,
    quality: 1,
  };

  let last = performance.now();
  let time = Number(params.get('t') ?? 0);
  function frame(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    time += dt;
    const z = -time * 60;
    camera.lookAt([0, 180, z], [0, 160, z - 100]);
    renderer.render(camera, time, dt, settings);
    hud.textContent = `segments ${renderer.city.count}`;
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
