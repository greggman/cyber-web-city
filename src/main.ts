import {initGpu, onGpuError} from './gpu/gpu';

const loadmsg = document.getElementById('loadmsg')!;
const errors = document.getElementById('errors')!;

function showError(msg: string) {
  errors.style.display = 'block';
  errors.textContent += msg + '\n';
}

async function main() {
  onGpuError(showError);
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const gpu = await initGpu(canvas);
  const {device, context} = gpu;

  function frame() {
    // Render at CSS resolution (no devicePixelRatio scaling).
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const encoder = device.createCommandEncoder({label: 'frame'});
    const pass = encoder.beginRenderPass({
      label: 'clear',
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView({label: 'swapchain'}),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0.05, 0.02, 0.1, 1],
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
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
