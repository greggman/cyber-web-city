// Facade detail ("kitbash") renderer: GPU-generated instances of small
// meshes on the buildings near the camera (see details_emit.wgsl).
import {
  createBuffer,
  createBufferWithData,
  createComputePipeline,
  createRenderPipeline,
  createShaderModule,
  createTexture,
} from '../gpu/gpu';
import {tw} from '../gpu/timer';
import {bgl, pipelineLayout} from '../gpu/layout';
import {
  DETAIL_TYPES,
  DETAIL_VERTEX_FLOATS,
  buildDetailMeshes,
} from '../city/details';
import {frustumPlanes, type Mat4, type Vec3} from '../math/vec';
import {DEPTH_FORMAT, GEOMETRY_TARGETS} from './targets';
import emitWgsl from '../shaders/details_emit.wgsl';
import drawWgsl from '../shaders/details.wgsl';

/** A world-space rect hanging on a segment face (see `Screen`). */
export interface Blocker {
  pos: Vec3;
  right: Vec3;
  normal: Vec3;
  width: number;
  height: number;
  seg: number;
}

const INST_BYTES = 64;
const PARAMS_BYTES = 192;
const MAX_NEAR = 4096;
const BUCKET_STRIDE = 256;

export class DetailRenderer {
  private params: GPUBuffer;
  private near: GPUBuffer;
  private dispatch: GPUBuffer;
  private draws: GPUBuffer;
  private drawsInit: Uint32Array;
  private instances: GPUBuffer;
  private typeInfo: GPUBuffer;
  private buckets: GPUBuffer;
  private vb!: GPUBuffer;
  private ib!: GPUBuffer;
  private computeLayout: GPUBindGroupLayout;
  private computeBg!: GPUBindGroup;
  // The emit dispatch reads its workgroup count from `dispatch`, which
  // therefore can't also be bound writable: it gets a dummy in that slot.
  private emitBg!: GPUBindGroup;
  private dummyArgs!: GPUBuffer;
  private drawBg!: GPUBindGroup;
  private select!: GPUComputePipeline;
  private emit!: GPUComputePipeline;
  private drawPipe!: GPURenderPipeline;
  private depthPipe!: GPURenderPipeline;
  private hizView: GPUTextureView;
  private hizMips = 1;
  private hizSize: [number, number] = [1, 1];
  private segmentBuffer!: GPUBuffer;
  private segCount = 0;
  private segRange!: GPUBuffer;
  private blockers!: GPUBuffer;
  enabled = true;
  /** Generation distance multiplier (quality). */
  distScale = 1;
  useHiz = true;
  private readback: GPUBuffer | null = null;
  private readbackBusy = false;
  /** Instances drawn per type (sampled ~twice a second). */
  counts: number[] = [];
  /** Segments selected for detail generation. */
  nearCount = 0;

  constructor(private readonly device: GPUDevice) {
    const d = device;
    const U = GPUBufferUsage;
    this.params = createBuffer(d, {
      label: 'details/params',
      size: PARAMS_BYTES,
      usage: U.UNIFORM | U.COPY_DST,
    });
    this.near = createBuffer(d, {
      label: 'details/near',
      size: MAX_NEAR * 4,
      usage: U.STORAGE,
    });
    this.dispatch = createBuffer(d, {
      label: 'details/dispatchArgs',
      size: 12,
      usage: U.STORAGE | U.INDIRECT | U.COPY_DST | U.COPY_SRC,
    });
    let total = 0;
    const info = new Uint32Array(DETAIL_TYPES.length * 4);
    const bucketData = new Uint32Array(
      (DETAIL_TYPES.length * BUCKET_STRIDE) / 4,
    );
    DETAIL_TYPES.forEach((t, i) => {
      info.set([total, t.cap], i * 4);
      bucketData[(i * BUCKET_STRIDE) / 4] = total;
      bucketData[(i * BUCKET_STRIDE) / 4 + 1] = i;
      total += t.cap;
    });
    this.instances = createBuffer(d, {
      label: 'details/instances',
      size: total * INST_BYTES,
      usage: U.STORAGE,
    });
    this.typeInfo = createBufferWithData(
      d,
      'details/typeInfo',
      info,
      U.STORAGE,
    );
    this.buckets = createBufferWithData(
      d,
      'details/buckets',
      bucketData,
      U.UNIFORM,
    );
    this.drawsInit = new Uint32Array(DETAIL_TYPES.length * 5);
    this.draws = createBuffer(d, {
      label: 'details/drawArgs',
      size: this.drawsInit.byteLength,
      usage: U.STORAGE | U.INDIRECT | U.COPY_DST | U.COPY_SRC,
    });
    const dummy = createTexture(d, {
      label: 'details/dummyHiz',
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.hizView = dummy.createView({label: 'details/dummyHiz/view'});
    this.computeLayout = bgl(d, 'details/emit/layout', [
      ['c', 'uniform'],
      ['c', 'storage-ro'],
      ['c', 'storage-rw'],
      ['c', 'storage-rw'],
      ['c', 'storage-rw'],
      ['c', 'storage-rw'],
      ['c', 'storage-ro'],
      ['c', 'tex-unfilterable'],
      ['c', 'storage-ro'],
      ['c', 'storage-ro'],
    ]);
  }

  private prepared: Promise<void> | null = null;

  /** Builds the meshes and compiles the pipelines (no city data needed). */
  prepare(sceneLayout: GPUBindGroupLayout, aoLayout: GPUBindGroupLayout) {
    this.prepared ??= this.preparePipelines(sceneLayout, aoLayout);
    return this.prepared;
  }

  async init(
    segmentBuffer: GPUBuffer,
    segCount: number,
    sceneLayout: GPUBindGroupLayout,
    aoLayout: GPUBindGroupLayout,
  ) {
    this.segmentBuffer = segmentBuffer;
    this.segCount = segCount;
    this.uploadBlockers([]);
    this.rebuildComputeBg();
    await this.prepare(sceneLayout, aoLayout);
  }

  private async preparePipelines(
    sceneLayout: GPUBindGroupLayout,
    aoLayout: GPUBindGroupLayout,
  ) {
    const d = this.device;
    // Merge the meshes.
    const meshes = buildDetailMeshes();
    const verts: number[] = [];
    const idx: number[] = [];
    meshes.forEach((m, i) => {
      this.drawsInit.set(
        [
          m.indices.length,
          0,
          idx.length,
          verts.length / DETAIL_VERTEX_FLOATS,
          0,
        ],
        i * 5,
      );
      verts.push(...m.vertices);
      idx.push(...m.indices);
    });
    this.vb = createBufferWithData(
      d,
      'details/vertices',
      new Float32Array(verts),
      GPUBufferUsage.VERTEX,
    );
    this.ib = createBufferWithData(
      d,
      'details/indices',
      new Uint32Array(idx),
      GPUBufferUsage.INDEX,
    );
    const drawLayout = bgl(d, 'details/draw/layout', [
      ['vf', 'storage-ro'],
      ['vf', 'uniform-dyn'],
    ]);
    this.drawBg = d.createBindGroup({
      label: 'details/draw',
      layout: drawLayout,
      entries: [
        {binding: 0, resource: {buffer: this.instances}},
        {binding: 1, resource: {buffer: this.buckets, size: 16}},
      ],
    });
    const emitModule = createShaderModule(d, {
      label: 'details/emit',
      code: emitWgsl,
    });
    const drawModule = createShaderModule(d, {
      label: 'details/draw',
      code: drawWgsl,
    });
    const cl = pipelineLayout(d, 'details/emit/pipelineLayout', [
      this.computeLayout,
    ]);
    const drawPl = pipelineLayout(d, 'details/draw/pipelineLayout', [
      sceneLayout,
      drawLayout,
      aoLayout,
    ]);
    const vbuf: GPUVertexBufferLayout[] = [
      {
        arrayStride: DETAIL_VERTEX_FLOATS * 4,
        attributes: [
          {shaderLocation: 0, offset: 0, format: 'float32x3'},
          {shaderLocation: 1, offset: 12, format: 'float32x3'},
          {shaderLocation: 2, offset: 24, format: 'float32x2'},
          {shaderLocation: 3, offset: 32, format: 'uint32'},
        ],
      },
    ];
    [this.select, this.emit, this.depthPipe, this.drawPipe] =
      (await Promise.all([
        createComputePipeline(d, {
          label: 'details/select',
          layout: cl,
          compute: {module: emitModule, entryPoint: 'cs_select'},
        }),
        createComputePipeline(d, {
          label: 'details/emit',
          layout: cl,
          compute: {module: emitModule, entryPoint: 'cs_emit'},
        }),
        createRenderPipeline(d, {
          label: 'details/depth',
          layout: drawPl,
          vertex: {module: drawModule, entryPoint: 'vs_depth', buffers: vbuf},
          primitive: {topology: 'triangle-list', cullMode: 'back'},
          depthStencil: {
            format: DEPTH_FORMAT,
            depthWriteEnabled: true,
            depthCompare: 'greater',
          },
        }),
        createRenderPipeline(d, {
          label: 'details/draw',
          layout: drawPl,
          vertex: {module: drawModule, entryPoint: 'vs', buffers: vbuf},
          fragment: {
            module: drawModule,
            entryPoint: 'fs',
            targets: GEOMETRY_TARGETS,
          },
          primitive: {topology: 'triangle-list', cullMode: 'back'},
          // Depth was laid down in the prepass: shade only the visible surface.
          depthStencil: {
            format: DEPTH_FORMAT,
            depthWriteEnabled: false,
            depthCompare: 'equal',
          },
        }),
      ])) as [
        GPUComputePipeline,
        GPUComputePipeline,
        GPURenderPipeline,
        GPURenderPipeline,
      ];
  }

  private rebuildComputeBg() {
    this.dummyArgs ??= createBuffer(this.device, {
      label: 'details/dummyDispatchArgs',
      size: 16,
      usage: GPUBufferUsage.STORAGE,
    });
    const make = (label: string, args: GPUBuffer) =>
      this.device.createBindGroup({
        label,
        layout: this.computeLayout,
        entries: [
          {binding: 0, resource: {buffer: this.params}},
          {binding: 1, resource: {buffer: this.segmentBuffer}},
          {binding: 2, resource: {buffer: this.near}},
          {binding: 3, resource: {buffer: args}},
          {binding: 4, resource: {buffer: this.draws}},
          {binding: 5, resource: {buffer: this.instances}},
          {binding: 6, resource: {buffer: this.typeInfo}},
          {binding: 7, resource: this.hizView},
          {binding: 8, resource: {buffer: this.segRange}},
          {binding: 9, resource: {buffer: this.blockers}},
        ],
      });
    this.computeBg = make('details/select', this.dispatch);
    this.emitBg = make('details/emit', this.dummyArgs);
  }

  /** Rects (ad screens) on segment faces that details must keep clear of. */
  setBlockers(rects: Blocker[]) {
    this.uploadBlockers(rects);
    this.rebuildComputeBg();
  }

  private uploadBlockers(rects: Blocker[]) {
    const sorted = rects
      .filter(r => r.seg >= 0 && r.seg < this.segCount)
      .sort((a, b) => a.seg - b.seg);
    const range = new Uint32Array(Math.max(this.segCount, 1) * 2);
    const data = new Float32Array(Math.max(sorted.length, 1) * 12);
    sorted.forEach((r, i) => {
      if (range[r.seg * 2 + 1] === 0) range[r.seg * 2] = i;
      range[r.seg * 2 + 1]++;
      data.set(
        [...r.pos, r.width / 2, ...r.right, r.height / 2, ...r.normal, 0],
        i * 12,
      );
    });
    this.segRange?.destroy();
    this.blockers?.destroy();
    const U = GPUBufferUsage.STORAGE;
    this.segRange = createBufferWithData(
      this.device,
      'details/segRange',
      range,
      U,
    );
    this.blockers = createBufferWithData(
      this.device,
      'details/blockers',
      data,
      U,
    );
  }

  setHiz(view: GPUTextureView, mips: number, width: number, height: number) {
    this.hizView = view;
    this.hizMips = mips;
    this.hizSize = [width, height];
    if (this.segmentBuffer) this.rebuildComputeBg();
  }

  /** Generates this frame's instances (after the city cull). */
  update(
    encoder: GPUCommandEncoder,
    viewProj: Mat4,
    prevViewProj: Mat4,
    camPos: Vec3,
    frameIndex: number,
  ) {
    if (!this.enabled) return;
    const p = new ArrayBuffer(PARAMS_BYTES);
    const f = new Float32Array(p);
    const u = new Uint32Array(p);
    frustumPlanes(viewProj).forEach((pl, i) => f.set(pl, i * 4));
    f.set(camPos, 20);
    u[23] = this.segCount;
    f.set(prevViewProj, 24);
    f[40] = this.hizSize[0];
    f[41] = this.hizSize[1];
    u[42] = this.hizMips;
    u[43] = this.useHiz && this.hizMips > 1 ? 1 : 0;
    f[44] = this.distScale;
    u[45] = MAX_NEAR;
    const q = this.device.queue;
    q.writeBuffer(this.params, 0, p);
    q.writeBuffer(this.draws, 0, this.drawsInit);
    q.writeBuffer(this.dispatch, 0, new Uint32Array([0, 1, 1]));
    const pass = encoder.beginComputePass({
      label: 'details/generate',
      timestampWrites: tw('details/generate'),
    });
    pass.setBindGroup(0, this.computeBg);
    pass.setPipeline(this.select);
    pass.dispatchWorkgroups(Math.ceil(this.segCount / 64));
    pass.setPipeline(this.emit);
    pass.setBindGroup(0, this.emitBg);
    pass.dispatchWorkgroupsIndirect(this.dispatch, 0);
    pass.end();
    this.sampleCounts(encoder, frameIndex);
  }

  private drawWith(
    pass: GPURenderPassEncoder,
    pipe: GPURenderPipeline,
    sceneBg: GPUBindGroup,
    aoBg: GPUBindGroup,
  ) {
    if (!this.enabled) return;
    pass.setPipeline(pipe);
    pass.setBindGroup(0, sceneBg);
    pass.setBindGroup(2, aoBg);
    pass.setVertexBuffer(0, this.vb);
    pass.setIndexBuffer(this.ib, 'uint32');
    for (let i = 0; i < DETAIL_TYPES.length; i++) {
      pass.setBindGroup(1, this.drawBg, [i * BUCKET_STRIDE]);
      pass.drawIndexedIndirect(this.draws, i * 20);
    }
  }

  drawDepth(
    pass: GPURenderPassEncoder,
    sceneBg: GPUBindGroup,
    aoBg: GPUBindGroup,
  ) {
    this.drawWith(pass, this.depthPipe, sceneBg, aoBg);
  }

  draw(pass: GPURenderPassEncoder, sceneBg: GPUBindGroup, aoBg: GPUBindGroup) {
    this.drawWith(pass, this.drawPipe, sceneBg, aoBg);
  }

  private sampleCounts(encoder: GPUCommandEncoder, frameIndex: number) {
    if (this.readbackBusy || frameIndex % 30 !== 15) return;
    this.readback ??= this.device.createBuffer({
      label: 'details/statsReadback',
      size: this.drawsInit.byteLength + 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    encoder.copyBufferToBuffer(
      this.draws,
      0,
      this.readback,
      0,
      this.drawsInit.byteLength,
    );
    encoder.copyBufferToBuffer(
      this.dispatch,
      0,
      this.readback,
      this.drawsInit.byteLength,
      12,
    );

    this.readbackBusy = true;
    const rb = this.readback;
    queueMicrotask(() => {
      void this.device.queue.onSubmittedWorkDone().then(() =>
        rb.mapAsync(GPUMapMode.READ).then(() => {
          const a = new Uint32Array(rb.getMappedRange());
          this.counts = DETAIL_TYPES.map((_, i) => a[i * 5 + 1]);
          this.nearCount = a[DETAIL_TYPES.length * 5];

          rb.unmap();
          this.readbackBusy = false;
        }),
      );
    });
  }
}
