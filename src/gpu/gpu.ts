// WebGPU device setup, error reporting and labeled-resource helpers.
//
// Every helper here requires a `label`, so it is a type error to create an
// unlabeled GPU object through them. Uncaptured errors and device loss are
// printed with a `[WebGPU]` prefix so tests can detect them.

export type Labeled<T> = T & {label: string};

export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  canvas: HTMLCanvasElement;
  presentationFormat: GPUTextureFormat;
  hasTimestamps: boolean;
  hasRG11B10: boolean;
}

const errorListeners: ((msg: string) => void)[] = [];

export function onGpuError(fn: (msg: string) => void) {
  errorListeners.push(fn);
}

export function reportGpuError(msg: string) {
  console.error(`[WebGPU] ${msg}`);
  for (const fn of errorListeners) {
    fn(msg);
  }
}

const OPTIONAL_FEATURES: GPUFeatureName[] = [
  'timestamp-query',
  'rg11b10ufloat-renderable',
  'float32-filterable',
  'indirect-first-instance',
];

export async function initGpu(canvas: HTMLCanvasElement): Promise<Gpu> {
  if (!navigator.gpu) {
    throw new Error('WebGPU is not supported in this browser');
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) {
    throw new Error('No WebGPU adapter available');
  }
  const requiredFeatures = OPTIONAL_FEATURES.filter(f =>
    adapter.features.has(f),
  );
  const lim = adapter.limits;
  const device = await adapter.requestDevice({
    label: 'cyber-web-city device',
    requiredFeatures,
    requiredLimits: {
      maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
      maxBufferSize: lim.maxBufferSize,
      maxStorageBuffersPerShaderStage: Math.min(
        lim.maxStorageBuffersPerShaderStage,
        10,
      ),
      maxComputeWorkgroupStorageSize: lim.maxComputeWorkgroupStorageSize,
      maxColorAttachmentBytesPerSample: lim.maxColorAttachmentBytesPerSample,
    },
  });
  device.addEventListener('uncapturederror', ev => {
    reportGpuError(`uncapturederror: ${ev.error.message}`);
  });
  void device.lost.then(info => {
    reportGpuError(`device lost (${info.reason}): ${info.message}`);
  });

  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('Could not get a webgpu canvas context');
  }
  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format: presentationFormat,
    alphaMode: 'opaque',
  });
  return {
    adapter,
    device,
    context,
    canvas,
    presentationFormat,
    hasTimestamps: device.features.has('timestamp-query'),
    hasRG11B10: device.features.has('rg11b10ufloat-renderable'),
  };
}

/** Creates a shader module and reports compilation errors with its label. */
export function createShaderModule(
  device: GPUDevice,
  desc: Labeled<GPUShaderModuleDescriptor>,
): GPUShaderModule {
  const module = device.createShaderModule(desc);
  void module.getCompilationInfo().then(info => {
    const lines = desc.code.split('\n');
    for (const m of info.messages) {
      if (m.type === 'info') {
        continue;
      }
      const src = lines[m.lineNum - 1] ?? '';
      const text = `${m.type} in shader "${desc.label}" at ${m.lineNum}:${m.linePos}: ${m.message}\n  ${src}`;
      if (m.type === 'error') {
        reportGpuError(text);
      } else {
        console.warn(text);
      }
    }
  });
  return module;
}

export async function createRenderPipeline(
  device: GPUDevice,
  desc: Labeled<GPURenderPipelineDescriptor>,
): Promise<GPURenderPipeline> {
  device.pushErrorScope('validation');
  const p = device.createRenderPipelineAsync(desc).catch(e => {
    reportGpuError(`render pipeline "${desc.label}": ${e.message ?? e}`);
    throw e;
  });
  const err = await device.popErrorScope();
  if (err) {
    reportGpuError(`render pipeline "${desc.label}": ${err.message}`);
  }
  return p;
}

export async function createComputePipeline(
  device: GPUDevice,
  desc: Labeled<GPUComputePipelineDescriptor>,
): Promise<GPUComputePipeline> {
  device.pushErrorScope('validation');
  const p = device.createComputePipelineAsync(desc).catch(e => {
    reportGpuError(`compute pipeline "${desc.label}": ${e.message ?? e}`);
    throw e;
  });
  const err = await device.popErrorScope();
  if (err) {
    reportGpuError(`compute pipeline "${desc.label}": ${err.message}`);
  }
  return p;
}

export function createBuffer(
  device: GPUDevice,
  desc: Labeled<GPUBufferDescriptor>,
): GPUBuffer {
  const size = Math.max(16, Math.ceil(desc.size / 4) * 4);
  return device.createBuffer({...desc, size});
}

export function createBufferWithData(
  device: GPUDevice,
  label: string,
  data: ArrayBufferView,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: Math.max(16, Math.ceil(data.byteLength / 4) * 4),
    usage: usage | GPUBufferUsage.COPY_DST,
  });
  // writeBuffer requires a multiple of 4 bytes.
  if (data.byteLength % 4 === 0) {
    device.queue.writeBuffer(
      buffer,
      0,
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
  } else {
    const padded = new Uint8Array(Math.ceil(data.byteLength / 4) * 4);
    padded.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    device.queue.writeBuffer(buffer, 0, padded);
  }
  return buffer;
}

export function createTexture(
  device: GPUDevice,
  desc: Labeled<GPUTextureDescriptor>,
): GPUTexture {
  return device.createTexture(desc);
}

export function createSampler(
  device: GPUDevice,
  desc: Labeled<GPUSamplerDescriptor>,
): GPUSampler {
  return device.createSampler(desc);
}

export function createBindGroup(
  device: GPUDevice,
  desc: Labeled<GPUBindGroupDescriptor>,
): GPUBindGroup {
  return device.createBindGroup(desc);
}

export function createBindGroupLayout(
  device: GPUDevice,
  desc: Labeled<GPUBindGroupLayoutDescriptor>,
): GPUBindGroupLayout {
  return device.createBindGroupLayout(desc);
}

export function createPipelineLayout(
  device: GPUDevice,
  desc: Labeled<GPUPipelineLayoutDescriptor>,
): GPUPipelineLayout {
  return device.createPipelineLayout(desc);
}

/** Shorthand for a bind group whose entries are bound in order 0..n-1. */
export function bindGroup(
  device: GPUDevice,
  label: string,
  layout: GPUBindGroupLayout,
  resources: GPUBindingResource[],
): GPUBindGroup {
  return device.createBindGroup({
    label,
    layout,
    entries: resources.map((resource, binding) => ({binding, resource})),
  });
}
