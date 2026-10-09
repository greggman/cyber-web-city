// GPU-driven renderer for building segments.
//
// One compute dispatch culls every segment and appends visible ones into
// per-mesh buckets. Each bucket is then drawn with a single
// drawIndexedIndirect, so the CPU cost is independent of city size.
import {tw} from '../gpu/timer';
import {
  createBuffer,
  createBufferWithData,
  createComputePipeline,
  createRenderPipeline,
  createShaderModule,
  bindGroup,
  createTexture,
} from '../gpu/gpu';
import {bgl, pipelineLayout} from '../gpu/layout';
import {
  buildShapeLibrary,
  VERTEX_FLOATS,
  VERTEX_STRIDE,
  SHAPE_COUNT,
} from '../city/meshes';
import {SegmentList} from '../city/segments';
import {frustumPlanes, type Mat4, type Vec3} from '../math/vec';
import {DEPTH_FORMAT, GEOMETRY_TARGETS} from './targets';
import cityWgsl from '../shaders/city.wgsl';
import cullWgsl from '../shaders/city_cull.wgsl';

const BUCKET_UNIFORM_STRIDE = 256;
const CULL_PARAMS_SIZE = 208;

interface Bucket {
  name: string;
  indexCount: number;
  firstIndex: number;
  baseVertex: number;
  base: number; // offset into the visible array
}

export class CityRenderer {
  private buckets: Bucket[] = [];
  private vertexBuffer!: GPUBuffer;
  private indexBuffer!: GPUBuffer;
  private segmentBuffer!: GPUBuffer;
  private visibleBuffer!: GPUBuffer;
  private argsBuffer!: GPUBuffer;
  private argsInit!: Uint32Array;
  private bucketUniforms!: GPUBuffer;
  private cullParams!: GPUBuffer;
  private cullParamsData = new ArrayBuffer(CULL_PARAMS_SIZE);
  private cullPipeline!: GPUComputePipeline;
  private depthPipeline!: GPURenderPipeline;
  private colorPipeline!: GPURenderPipeline;
  private cullLayout!: GPUBindGroupLayout;
  private cullBindGroup!: GPUBindGroup;
  private drawBindGroup!: GPUBindGroup;
  private frameBindGroup!: GPUBindGroup;
  private dummyHiz!: GPUTexture;
  private hizView: GPUTextureView | null = null;
  private hizMips = 1;
  private hizSize: [number, number] = [1, 1];
  private segmentCount = 0;
  useHiz = false;

  constructor(private readonly device: GPUDevice) {}

  async init(
    segments: SegmentList,
    sceneBindGroup: GPUBindGroup,
    sceneLayout: GPUBindGroupLayout,
  ) {
    const device = this.device;
    const lib = buildShapeLibrary();
    const vertices: number[] = [];
    const indices: number[] = [];
    const shapeInfo = new ArrayBuffer(SHAPE_COUNT * 32);
    const shapeU32 = new Uint32Array(shapeInfo);
    const shapeF32 = new Float32Array(shapeInfo);
    let visibleTotal = 0;
    for (const s of lib) {
      shapeU32[s.shape * 8 + 0] = this.buckets.length;
      shapeU32[s.shape * 8 + 1] = s.meshes.length;
      s.lodRatios.forEach((r, i) => (shapeF32[s.shape * 8 + 4 + i] = r));
      const cap = Math.max(1, segments.shapeCounts[s.shape]);
      for (const m of s.meshes) {
        this.buckets.push({
          name: m.name,
          indexCount: m.indices.length,
          firstIndex: indices.length,
          baseVertex: vertices.length / VERTEX_FLOATS,
          base: visibleTotal,
        });
        visibleTotal += cap;
        vertices.push(...m.vertices);
        indices.push(...m.indices);
      }
    }
    const U = GPUBufferUsage;
    this.vertexBuffer = createBufferWithData(
      device,
      'city/vertices',
      new Float32Array(vertices),
      U.VERTEX,
    );
    this.indexBuffer = createBufferWithData(
      device,
      'city/indices',
      new Uint32Array(indices),
      U.INDEX,
    );
    const shapeBuffer = createBufferWithData(
      device,
      'city/shapeInfo',
      new Uint8Array(shapeInfo),
      U.STORAGE,
    );
    this.segmentCount = segments.count;
    this.segmentBuffer = createBufferWithData(
      device,
      'city/segments',
      segments.bytes(),
      U.STORAGE,
    );
    this.visibleBuffer = createBuffer(device, {
      label: 'city/visible',
      size: visibleTotal * 4,
      usage: U.STORAGE,
    });
    this.argsInit = new Uint32Array(this.buckets.length * 5);
    const bases = new Uint32Array(this.buckets.length);
    const bucketData = new Uint32Array(
      (this.buckets.length * BUCKET_UNIFORM_STRIDE) / 4,
    );
    this.buckets.forEach((b, i) => {
      this.argsInit.set(
        [b.indexCount, 0, b.firstIndex, b.baseVertex, 0],
        i * 5,
      );
      bases[i] = b.base;
      bucketData[(i * BUCKET_UNIFORM_STRIDE) / 4] = b.base;
    });
    this.argsBuffer = createBuffer(device, {
      label: 'city/indirectArgs',
      size: this.argsInit.byteLength,
      usage: U.INDIRECT | U.STORAGE | U.COPY_DST | U.COPY_SRC,
    });
    const baseBuffer = createBufferWithData(
      device,
      'city/bucketBase',
      bases,
      U.STORAGE,
    );
    this.bucketUniforms = createBufferWithData(
      device,
      'city/bucketUniforms',
      bucketData,
      U.UNIFORM,
    );
    this.cullParams = createBuffer(device, {
      label: 'city/cullParams',
      size: CULL_PARAMS_SIZE,
      usage: U.UNIFORM | U.COPY_DST,
    });
    this.dummyHiz = createTexture(device, {
      label: 'city/dummyHiz',
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });

    // Culling pipeline.
    this.cullLayout = bgl(device, 'city/cull/layout', [
      ['c', 'uniform'],
      ['c', 'storage-ro'],
      ['c', 'storage-ro'],
      ['c', 'storage-rw'],
      ['c', 'storage-rw'],
      ['c', 'storage-ro'],
      ['c', 'tex-unfilterable'],
    ]);
    this.cullBindGroupParts = [shapeBuffer, baseBuffer];
    this.rebuildCullBindGroup();
    const cullModule = createShaderModule(device, {
      label: 'city/cull',
      code: cullWgsl,
    });
    const cullPromise = createComputePipeline(device, {
      label: 'city/cull',
      layout: pipelineLayout(device, 'city/cull/pipelineLayout', [
        this.cullLayout,
      ]),
      compute: {module: cullModule, entryPoint: 'cs_cull'},
    });

    // Draw pipelines.
    const drawLayout = bgl(device, 'city/draw/layout', [
      ['vf', 'storage-ro'],
      ['v', 'storage-ro'],
      ['v', 'uniform-dyn'],
    ]);
    this.drawBindGroup = device.createBindGroup({
      label: 'city/draw',
      layout: drawLayout,
      entries: [
        {binding: 0, resource: {buffer: this.segmentBuffer}},
        {binding: 1, resource: {buffer: this.visibleBuffer}},
        {binding: 2, resource: {buffer: this.bucketUniforms, size: 16}},
      ],
    });
    this.frameBindGroup = sceneBindGroup;
    const layout = pipelineLayout(device, 'city/draw/pipelineLayout', [
      sceneLayout,
      drawLayout,
    ]);
    const module = createShaderModule(device, {label: 'city', code: cityWgsl});
    const vertexState: GPUVertexState = {
      module,
      entryPoint: 'vs_depth',
      buffers: [
        {
          arrayStride: VERTEX_STRIDE,
          attributes: [
            {shaderLocation: 0, offset: 0, format: 'float32x3'},
            {shaderLocation: 1, offset: 12, format: 'float32x3'},
            {shaderLocation: 2, offset: 24, format: 'float32x2'},
          ],
        },
      ],
    };
    const primitive: GPUPrimitiveState = {
      topology: 'triangle-list',
      cullMode: 'back',
    };
    const depthPromise = createRenderPipeline(device, {
      label: 'city/depth',
      layout,
      vertex: vertexState,
      primitive,
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: 'greater',
      },
    });
    const colorPromise = createRenderPipeline(device, {
      label: 'city/color',
      layout,
      vertex: {...vertexState, entryPoint: 'vs_main'},
      fragment: {module, entryPoint: 'fs_main', targets: GEOMETRY_TARGETS},
      primitive,
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: 'equal',
      },
    });
    [this.cullPipeline, this.depthPipeline, this.colorPipeline] =
      await Promise.all([cullPromise, depthPromise, colorPromise]);
  }

  private cullBindGroupParts: GPUBuffer[] = [];

  private rebuildCullBindGroup() {
    const [shapeBuffer, baseBuffer] = this.cullBindGroupParts;
    this.cullBindGroup = bindGroup(this.device, 'city/cull', this.cullLayout, [
      {buffer: this.cullParams},
      {buffer: this.segmentBuffer},
      {buffer: shapeBuffer},
      {buffer: this.argsBuffer},
      {buffer: this.visibleBuffer},
      {buffer: baseBuffer},
      this.hizView ?? this.dummyHiz.createView({label: 'city/dummyHiz/view'}),
    ]);
  }

  /** Supplies last frame's Hi-Z pyramid for occlusion culling. */
  setHiz(view: GPUTextureView, mips: number, width: number, height: number) {
    this.hizView = view;
    this.hizMips = mips;
    this.hizSize = [width, height];
    this.rebuildCullBindGroup();
  }

  cull(
    encoder: GPUCommandEncoder,
    viewProj: Mat4,
    prevViewProj: Mat4,
    camPos: Vec3,
    screenHeight: number,
    fovY: number,
  ) {
    const f = new Float32Array(this.cullParamsData);
    const u = new Uint32Array(this.cullParamsData);
    frustumPlanes(viewProj).forEach((p, i) => f.set(p, i * 4));
    f.set(camPos, 20);
    u[23] = this.segmentCount;
    f[24] = screenHeight / (2 * Math.tan(fovY / 2));
    f[25] = 0.6;
    u[26] = this.useHiz && this.hizView ? 1 : 0;
    u[27] = this.hizMips;
    f.set(prevViewProj, 28);
    f[44] = this.hizSize[0];
    f[45] = this.hizSize[1];
    this.device.queue.writeBuffer(this.cullParams, 0, this.cullParamsData);
    this.device.queue.writeBuffer(this.argsBuffer, 0, this.argsInit);
    const pass = encoder.beginComputePass({
      label: 'city/cull',
      timestampWrites: tw('city/cull'),
    });
    pass.setPipeline(this.cullPipeline);
    pass.setBindGroup(0, this.cullBindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.segmentCount / 64));
    pass.end();
  }

  private draw(pass: GPURenderPassEncoder, pipeline: GPURenderPipeline) {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.frameBindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    this.buckets.forEach((_, i) => {
      pass.setBindGroup(1, this.drawBindGroup, [i * BUCKET_UNIFORM_STRIDE]);
      pass.drawIndexedIndirect(this.argsBuffer, i * 20);
    });
  }

  drawDepth(pass: GPURenderPassEncoder) {
    this.draw(pass, this.depthPipeline);
  }

  drawColor(pass: GPURenderPassEncoder) {
    this.draw(pass, this.colorPipeline);
  }

  private readback: GPUBuffer | null = null;
  private readbackBusy = false;
  /** Segments that survived culling (sampled every ~half second). */
  visibleSegments = 0;

  /** Copies the indirect args for an async read of visible counts. */
  sampleStats(encoder: GPUCommandEncoder, frameIndex: number) {
    if (this.readbackBusy || frameIndex % 30 !== 0) return;
    this.readback ??= this.device.createBuffer({
      label: 'city/statsReadback',
      size: this.argsInit.byteLength,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    encoder.copyBufferToBuffer(
      this.argsBuffer,
      0,
      this.readback,
      0,
      this.argsInit.byteLength,
    );
    this.readbackBusy = true;
    const rb = this.readback;
    queueMicrotask(() => {
      void this.device.queue.onSubmittedWorkDone().then(() =>
        rb.mapAsync(GPUMapMode.READ).then(() => {
          const a = new Uint32Array(rb.getMappedRange());
          let n = 0;
          for (let i = 1; i < a.length; i += 5) n += a[i];
          this.visibleSegments = n;
          rb.unmap();
          this.readbackBusy = false;
        }),
      );
    });
  }

  get count() {
    return this.segmentCount;
  }
}
