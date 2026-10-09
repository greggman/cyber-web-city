// Draws neon signs as instanced procedural boxes, GPU-culled into an
// indirect draw.
import {tw} from '../gpu/timer';
import {
  bindGroup,
  createBuffer,
  createBufferWithData,
  createComputePipeline,
  createRenderPipeline,
  createSampler,
  createShaderModule,
} from '../gpu/gpu';
import {bgl, pipelineLayout} from '../gpu/layout';
import {packSigns, type Sign} from '../city/signs';
import {frustumPlanes, type Mat4, type Vec3} from '../math/vec';
import {createGlyphAtlas} from './glyphs';
import {DEPTH_FORMAT, GEOMETRY_TARGETS} from './targets';
import signsWgsl from '../shaders/signs.wgsl';

export class SignRenderer {
  private pipeline!: GPURenderPipeline;
  private cullPipeline!: GPUComputePipeline;
  private bg!: GPUBindGroup;
  private cullBg!: GPUBindGroup;
  private cullParams!: GPUBuffer;
  private camBuf!: GPUBuffer;
  private args!: GPUBuffer;
  private count = 0;
  glyphAtlas!: GPUTexture;

  constructor(private readonly device: GPUDevice) {}

  async init(signs: Sign[], sceneLayout: GPUBindGroupLayout) {
    const d = this.device;
    const U = GPUBufferUsage;
    this.count = signs.length;
    const buffer = createBufferWithData(
      d,
      'signs/instances',
      new Uint8Array(packSigns(signs)),
      U.STORAGE,
    );
    const visible = createBuffer(d, {
      label: 'signs/visible',
      size: Math.max(1, this.count) * 4,
      usage: U.STORAGE,
    });
    this.args = createBuffer(d, {
      label: 'signs/indirectArgs',
      size: 16,
      usage: U.STORAGE | U.INDIRECT | U.COPY_DST,
    });
    this.cullParams = createBuffer(d, {
      label: 'signs/cullParams',
      size: 96,
      usage: U.UNIFORM | U.COPY_DST,
    });
    this.camBuf = createBuffer(d, {
      label: 'signs/camPos',
      size: 16,
      usage: U.UNIFORM | U.COPY_DST,
    });
    const atlas = createGlyphAtlas(d);
    this.glyphAtlas = atlas;
    const sampler = createSampler(d, {
      label: 'signs/sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 8,
    });
    const layout = bgl(d, 'signs/layout', [
      ['vf', 'storage-ro'],
      ['f', 'tex-float'],
      ['f', 'sampler'],
      ['v', 'storage-ro'],
    ]);
    this.bg = bindGroup(d, 'signs', layout, [
      {buffer},
      atlas.createView({label: 'signs/glyphAtlas/view'}),
      sampler,
      {buffer: visible},
    ]);
    const cl = bgl(d, 'signs/cull/layout', [
      ['c', 'uniform'],
      ['c', 'storage-ro'],
      ['c', 'storage-rw'],
      ['c', 'storage-rw'],
      ['c', 'uniform'],
    ]);
    this.cullBg = bindGroup(d, 'signs/cull', cl, [
      {buffer: this.cullParams},
      {buffer},
      {buffer: visible},
      {buffer: this.args},
      {buffer: this.camBuf},
    ]);
    const module = createShaderModule(d, {label: 'signs', code: signsWgsl});
    [this.pipeline, this.cullPipeline] = (await Promise.all([
      createRenderPipeline(d, {
        label: 'signs',
        layout: pipelineLayout(d, 'signs/pipelineLayout', [
          sceneLayout,
          layout,
        ]),
        vertex: {module, entryPoint: 'vs'},
        fragment: {module, entryPoint: 'fs', targets: GEOMETRY_TARGETS},
        primitive: {topology: 'triangle-list', cullMode: 'back'},
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: true,
          depthCompare: 'greater',
        },
      }),
      createComputePipeline(d, {
        label: 'signs/cull',
        layout: pipelineLayout(d, 'signs/cull/pipelineLayout', [cl]),
        compute: {module, entryPoint: 'cs_cull'},
      }),
    ])) as [GPURenderPipeline, GPUComputePipeline];
  }

  cull(encoder: GPUCommandEncoder, viewProj: Mat4, camPos: Vec3) {
    if (this.count === 0) return;
    const p = new ArrayBuffer(96);
    const f = new Float32Array(p);
    frustumPlanes(viewProj).forEach((pl, i) => f.set(pl, i * 4));
    new Uint32Array(p)[20] = this.count;
    const q = this.device.queue;
    q.writeBuffer(this.cullParams, 0, p);
    q.writeBuffer(this.camBuf, 0, new Float32Array([...camPos, 0]));
    q.writeBuffer(this.args, 0, new Uint32Array([36, 0, 0, 0]));
    const pass = encoder.beginComputePass({
      label: 'signs/cull',
      timestampWrites: tw('signs/cull'),
    });
    pass.setPipeline(this.cullPipeline);
    pass.setBindGroup(0, this.cullBg);
    pass.dispatchWorkgroups(Math.ceil(this.count / 64));
    pass.end();
  }

  draw(pass: GPURenderPassEncoder, sceneBindGroup: GPUBindGroup) {
    if (this.count === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, sceneBindGroup);
    pass.setBindGroup(1, this.bg);
    pass.drawIndirect(this.args, 0);
  }
}
