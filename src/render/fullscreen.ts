// Helper for fullscreen-triangle passes.
import {createRenderPipeline, createShaderModule} from '../gpu/gpu';
import {pipelineLayout} from '../gpu/layout';

export async function fullscreenPipeline(
  device: GPUDevice,
  label: string,
  code: string,
  layouts: GPUBindGroupLayout[],
  targets: GPUColorTargetState[],
  fragmentEntry = 'fs',
  constants?: Record<string, number>,
): Promise<GPURenderPipeline> {
  const module = createShaderModule(device, {label, code});
  return createRenderPipeline(device, {
    label,
    layout: pipelineLayout(device, `${label}/layout`, layouts),
    vertex: {module, entryPoint: 'vs'},
    fragment: {module, entryPoint: fragmentEntry, targets, constants},
    primitive: {topology: 'triangle-list'},
  });
}

export function runFullscreen(
  encoder: GPUCommandEncoder,
  label: string,
  target: GPUTextureView,
  pipeline: GPURenderPipeline,
  bindGroups: GPUBindGroup[],
  load: GPULoadOp = 'clear',
) {
  const pass = encoder.beginRenderPass({
    label,
    colorAttachments: [
      {view: target, loadOp: load, storeOp: 'store', clearValue: [0, 0, 0, 0]},
    ],
  });
  pass.setPipeline(pipeline);
  bindGroups.forEach((bg, i) => pass.setBindGroup(i, bg));
  pass.draw(3);
  pass.end();
}
