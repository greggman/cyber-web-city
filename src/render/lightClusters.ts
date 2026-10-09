// Clustered light culling (see src/shaders/light_cull.wgsl).
//
// Static lights are uploaded once; dynamic lights (traffic, the player's car)
// occupy a reserved range at the end of the same buffer and are written by
// the CPU or compute passes each frame.
import {tw} from '../gpu/timer';
import {
  bindGroup,
  createBuffer,
  createBufferWithData,
  createComputePipeline,
  createShaderModule,
} from '../gpu/gpu';
import {bgl, pipelineLayout} from '../gpu/layout';
import cullWgsl from '../shaders/light_cull.wgsl';

export const TILES_X = 16;
export const TILES_Y = 9;
export const SLICES = 24;
export const MAX_PER_CLUSTER = 64;
export const LIGHT_FLOATS = 12;
export const MAX_VISIBLE = 8192;

export interface LightDesc {
  pos: [number, number, number];
  radius: number;
  color: [number, number, number]; // linear HDR (intensity premultiplied)
  spot?: {dir: [number, number, number]; cosCone: number};
}

export function packLights(lights: LightDesc[], out: Float32Array, offset = 0) {
  const u = new Uint32Array(out.buffer, out.byteOffset, out.length);
  lights.forEach((l, i) => {
    const o = (offset + i) * LIGHT_FLOATS;
    out.set(l.pos, o);
    out[o + 3] = l.radius;
    out.set(l.color, o + 4);
    u[o + 7] = l.spot ? 1 : 0;
    out.set(l.spot?.dir ?? [0, -1, 0], o + 8);
    out[o + 11] = l.spot?.cosCone ?? -1;
  });
}

export class LightClusters {
  readonly lightBuffer: GPUBuffer;
  readonly clusterCounts: GPUBuffer;
  readonly clusterLights: GPUBuffer;
  readonly staticCount: number;
  readonly dynamicCapacity: number;
  private visible: GPUBuffer;
  private visibleCount: GPUBuffer;
  private info: GPUBuffer;
  private bg!: GPUBindGroup;
  private pVisible!: GPUComputePipeline;
  private pCluster!: GPUComputePipeline;
  private pReset!: GPUComputePipeline;
  dynamicCount = 0;

  constructor(
    private readonly device: GPUDevice,
    /** Light list, or already packed (LIGHT_FLOATS per light). */
    staticLights: LightDesc[] | Float32Array,
    dynamicCapacity: number,
  ) {
    const packed = staticLights instanceof Float32Array;
    this.staticCount = packed
      ? staticLights.length / LIGHT_FLOATS
      : staticLights.length;
    this.dynamicCapacity = dynamicCapacity;
    const total = Math.max(1, this.staticCount + dynamicCapacity);
    const data = new Float32Array(total * LIGHT_FLOATS);
    if (packed) data.set(staticLights);
    else packLights(staticLights, data);
    const U = GPUBufferUsage;
    this.lightBuffer = createBufferWithData(
      device,
      'lights/all',
      data,
      U.STORAGE | U.COPY_DST,
    );
    this.visible = createBuffer(device, {
      label: 'lights/visible',
      size: MAX_VISIBLE * 4,
      usage: U.STORAGE,
    });
    this.visibleCount = createBuffer(device, {
      label: 'lights/visibleCount',
      size: 16,
      usage: U.STORAGE,
    });
    const clusters = TILES_X * TILES_Y * SLICES;
    this.clusterCounts = createBuffer(device, {
      label: 'lights/clusterCounts',
      size: clusters * 4,
      usage: U.STORAGE,
    });
    this.clusterLights = createBuffer(device, {
      label: 'lights/clusterLights',
      size: clusters * MAX_PER_CLUSTER * 4,
      usage: U.STORAGE,
    });
    this.info = createBuffer(device, {
      label: 'lights/cullInfo',
      size: 16,
      usage: U.UNIFORM | U.COPY_DST,
    });
  }

  async init(frameBuffer: GPUBuffer) {
    const d = this.device;
    const layout = bgl(d, 'lights/cull/layout', [
      ['c', 'uniform'],
      ['c', 'uniform'],
      ['c', 'storage-ro'],
      ['c', 'storage-rw'],
      ['c', 'storage-rw'],
      ['c', 'storage-rw'],
      ['c', 'storage-rw'],
    ]);
    this.bg = bindGroup(d, 'lights/cull', layout, [
      {buffer: frameBuffer},
      {buffer: this.info},
      {buffer: this.lightBuffer},
      {buffer: this.visible},
      {buffer: this.visibleCount},
      {buffer: this.clusterCounts},
      {buffer: this.clusterLights},
    ]);
    const module = createShaderModule(d, {
      label: 'lights/cull',
      code: cullWgsl,
    });
    const pl = pipelineLayout(d, 'lights/cull/pipelineLayout', [layout]);
    [this.pVisible, this.pCluster, this.pReset] = await Promise.all(
      ['cs_visible', 'cs_cluster', 'cs_reset'].map(entryPoint =>
        createComputePipeline(d, {
          label: `lights/${entryPoint}`,
          layout: pl,
          compute: {module, entryPoint},
        }),
      ),
    );
  }

  /** Writes dynamic lights (packed) after the static range. */
  writeDynamic(data: Float32Array, count: number) {
    this.dynamicCount = Math.min(count, this.dynamicCapacity);
    if (this.dynamicCount > 0) {
      this.device.queue.writeBuffer(
        this.lightBuffer,
        this.staticCount * LIGHT_FLOATS * 4,
        data.buffer,
        data.byteOffset,
        this.dynamicCount * LIGHT_FLOATS * 4,
      );
    }
  }

  get totalCount() {
    return this.staticCount + this.dynamicCount;
  }

  run(encoder: GPUCommandEncoder, maxDistance = 2500) {
    const info = new ArrayBuffer(16);
    new Uint32Array(info, 0, 2).set([
      this.staticCount + this.dynamicCapacity,
      MAX_VISIBLE,
    ]);
    new Float32Array(info, 8, 1)[0] = maxDistance;
    this.device.queue.writeBuffer(this.info, 0, info);
    const pass = encoder.beginComputePass({
      label: 'lights/cull',
      timestampWrites: tw('lights/cull'),
    });
    pass.setBindGroup(0, this.bg);
    pass.setPipeline(this.pReset);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.pVisible);
    pass.dispatchWorkgroups(
      Math.ceil((this.staticCount + this.dynamicCapacity) / 64),
    );
    pass.setPipeline(this.pCluster);
    pass.dispatchWorkgroups(TILES_X * TILES_Y);
    pass.end();
  }
}
