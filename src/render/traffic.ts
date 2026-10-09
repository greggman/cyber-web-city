// GPU flying traffic: cull, light sprites, instanced near meshes, headlights.
import {
  bindGroup,
  createBuffer,
  createBufferWithData,
  createComputePipeline,
  createRenderPipeline,
  createShaderModule,
} from '../gpu/gpu';
import {bgl, pipelineLayout} from '../gpu/layout';
import type {TrafficData} from '../city/traffic';
import {MODEL_VERTEX_STRIDE, type ModelMesh} from '../nurbs/model';
import {frustumPlanes, type Mat4, type Vec3} from '../math/vec';
import {DEPTH_FORMAT, GEOMETRY_TARGETS, HDR_FORMAT} from './targets';
import {LIGHT_FLOATS} from './lightClusters';
import trafficWgsl from '../shaders/traffic.wgsl';

const MAX_VISIBLE = 40000;

export class Traffic {
  private vehicles: GPUBuffer;
  private lanes: GPUBuffer;
  private params: GPUBuffer;
  private lists: GPUBuffer;
  private counters: GPUBuffer;
  private countersInit: Uint32Array;
  private computeBg!: GPUBindGroup;
  private renderBg!: GPUBindGroup;
  private matBg!: GPUBindGroup;
  private cull!: GPUComputePipeline;
  private sprites!: GPURenderPipeline;
  private meshes!: GPURenderPipeline;
  private vb!: GPUBuffer;
  private ib!: GPUBuffer;
  private zeroLights: Float32Array;
  readonly count: number;

  constructor(
    private readonly device: GPUDevice,
    data: TrafficData,
    private readonly lightBase: number,
    private readonly lightCap: number,
  ) {
    const d = device;
    const U = GPUBufferUsage;
    this.count = data.vehicleCount;
    this.vehicles = createBufferWithData(
      d,
      'traffic/vehicles',
      new Uint8Array(data.vehicles),
      U.STORAGE,
    );
    this.lanes = createBufferWithData(
      d,
      'traffic/lanes',
      data.lanes,
      U.STORAGE,
    );
    this.params = createBuffer(d, {
      label: 'traffic/params',
      size: 112,
      usage: U.UNIFORM | U.COPY_DST,
    });
    this.lists = createBuffer(d, {
      label: 'traffic/lists',
      size: MAX_VISIBLE * 2 * 4,
      usage: U.STORAGE,
    });
    this.counters = createBuffer(d, {
      label: 'traffic/counters',
      size: 48,
      usage: U.STORAGE | U.INDIRECT | U.COPY_DST,
    });
    this.countersInit = new Uint32Array(12);
    this.zeroLights = new Float32Array(lightCap * LIGHT_FLOATS);
  }

  async init(
    frameLayout: GPUBindGroupLayout,
    sceneLayout: GPUBindGroupLayout,
    lightBuffer: GPUBuffer,
    mesh: ModelMesh,
  ) {
    const d = this.device;
    const U = GPUBufferUsage;
    const indices = new Uint32Array(
      mesh.opaqueIndices.length + mesh.glassIndices.length,
    );
    indices.set(mesh.opaqueIndices);
    indices.set(mesh.glassIndices, mesh.opaqueIndices.length);
    this.vb = createBufferWithData(
      d,
      'traffic/meshVertices',
      mesh.vertices,
      U.VERTEX,
    );
    this.ib = createBufferWithData(d, 'traffic/meshIndices', indices, U.INDEX);
    this.countersInit.set([24, 0, 0, 0, indices.length, 0, 0, 0, 0, 0, 0, 0]);
    const mats = createBufferWithData(
      d,
      'traffic/materials',
      mesh.materials,
      U.STORAGE,
    );
    const cl = bgl(d, 'traffic/compute/layout', [
      ['c', 'storage-ro', 0],
      ['c', 'storage-ro', 1],
      ['c', 'uniform', 2],
      ['c', 'storage-rw', 3],
      ['c', 'storage-rw', 4],
      ['c', 'storage-rw', 5],
    ]);
    const rl = bgl(d, 'traffic/render/layout', [
      ['v', 'storage-ro', 0],
      ['v', 'storage-ro', 1],
      ['v', 'uniform', 2],
      ['v', 'storage-ro', 6],
    ]);
    const ml = bgl(d, 'traffic/materials/layout', [['f', 'storage-ro']]);
    this.computeBg = d.createBindGroup({
      label: 'traffic/compute',
      layout: cl,
      entries: [
        {binding: 0, resource: {buffer: this.vehicles}},
        {binding: 1, resource: {buffer: this.lanes}},
        {binding: 2, resource: {buffer: this.params}},
        {binding: 3, resource: {buffer: this.lists}},
        {binding: 4, resource: {buffer: this.counters}},
        {binding: 5, resource: {buffer: lightBuffer}},
      ],
    });
    this.renderBg = d.createBindGroup({
      label: 'traffic/render',
      layout: rl,
      entries: [
        {binding: 0, resource: {buffer: this.vehicles}},
        {binding: 1, resource: {buffer: this.lanes}},
        {binding: 2, resource: {buffer: this.params}},
        {binding: 6, resource: {buffer: this.lists}},
      ],
    });
    this.matBg = bindGroup(d, 'traffic/materials', ml, [{buffer: mats}]);
    const module = createShaderModule(d, {label: 'traffic', code: trafficWgsl});
    const additive: GPUBlendState = {
      color: {srcFactor: 'one', dstFactor: 'one'},
      alpha: {srcFactor: 'zero', dstFactor: 'one'},
    };
    [this.cull, this.sprites, this.meshes] = (await Promise.all([
      createComputePipeline(d, {
        label: 'traffic/cull',
        layout: pipelineLayout(d, 'traffic/cull/pipelineLayout', [
          frameLayout,
          cl,
        ]),
        compute: {module, entryPoint: 'cs_cull'},
      }),
      createRenderPipeline(d, {
        label: 'traffic/sprites',
        layout: pipelineLayout(d, 'traffic/sprites/pipelineLayout', [
          sceneLayout,
          rl,
        ]),
        vertex: {module, entryPoint: 'vs_sprite'},
        fragment: {
          module,
          entryPoint: 'fs_sprite',
          targets: [{format: HDR_FORMAT, blend: additive}],
        },
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: false,
          depthCompare: 'greater',
        },
      }),
      createRenderPipeline(d, {
        label: 'traffic/meshes',
        layout: pipelineLayout(d, 'traffic/meshes/pipelineLayout', [
          sceneLayout,
          rl,
          ml,
        ]),
        vertex: {
          module,
          entryPoint: 'vs_mesh',
          buffers: [
            {
              arrayStride: MODEL_VERTEX_STRIDE,
              attributes: [
                {shaderLocation: 0, offset: 0, format: 'float32x3'},
                {shaderLocation: 1, offset: 12, format: 'float32x3'},
                {shaderLocation: 2, offset: 24, format: 'float32x2'},
                {shaderLocation: 3, offset: 32, format: 'uint32'},
              ],
            },
          ],
        },
        fragment: {module, entryPoint: 'fs_mesh', targets: GEOMETRY_TARGETS},
        primitive: {topology: 'triangle-list', cullMode: 'none'},
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: true,
          depthCompare: 'greater',
        },
      }),
    ])) as [GPUComputePipeline, GPURenderPipeline, GPURenderPipeline];
  }

  /** Culls vehicles and writes their headlights (call before light culling). */
  update(
    encoder: GPUCommandEncoder,
    frameBg: GPUBindGroup,
    lightBuffer: GPUBuffer,
    staticLights: number,
    viewProj: Mat4,
    camVel: Vec3,
  ) {
    const p = new ArrayBuffer(112);
    const u = new Uint32Array(p);
    const f = new Float32Array(p);
    u[0] = this.count;
    u[1] = staticLights + this.lightBase;
    u[2] = this.lightCap;
    u[3] = MAX_VISIBLE;
    f.set(camVel, 4);
    f[7] = 1 / 30;
    frustumPlanes(viewProj).forEach((pl, i) => f.set(pl, 8 + i * 4));
    const q = this.device.queue;
    q.writeBuffer(this.params, 0, p);
    q.writeBuffer(this.counters, 0, this.countersInit);
    q.writeBuffer(
      lightBuffer,
      (staticLights + this.lightBase) * LIGHT_FLOATS * 4,
      this.zeroLights,
    );
    const pass = encoder.beginComputePass({label: 'traffic/cull'});
    pass.setPipeline(this.cull);
    pass.setBindGroup(0, frameBg);
    pass.setBindGroup(1, this.computeBg);
    pass.dispatchWorkgroups(Math.ceil(this.count / 64));
    pass.end();
  }

  drawMeshes(pass: GPURenderPassEncoder, sceneBg: GPUBindGroup) {
    pass.setPipeline(this.meshes);
    pass.setBindGroup(0, sceneBg);
    pass.setBindGroup(1, this.renderBg);
    pass.setBindGroup(2, this.matBg);
    pass.setVertexBuffer(0, this.vb);
    pass.setIndexBuffer(this.ib, 'uint32');
    pass.drawIndexedIndirect(this.counters, 16);
  }

  drawSprites(pass: GPURenderPassEncoder, sceneBg: GPUBindGroup) {
    pass.setPipeline(this.sprites);
    pass.setBindGroup(0, sceneBg);
    pass.setBindGroup(1, this.renderBg);
    pass.drawIndirect(this.counters, 0);
  }
}
