// Renders the player's NURBS car with scene lighting, plus its lights.
import {
  bindGroup,
  createBufferWithData,
  createRenderPipeline,
  createSampler,
  createShaderModule,
  createTexture,
} from '../gpu/gpu';
import {bgl, pipelineLayout} from '../gpu/layout';
import {MODEL_VERTEX_STRIDE, type ModelMesh} from '../nurbs/model';
import {
  DEPTH_FORMAT,
  GEOMETRY_TARGETS,
  HDR_FORMAT,
  type Targets,
} from './targets';
import {transformDir, transformPoint, type Mat4, type Vec3} from '../math/vec';
import type {LightDesc} from './lightClusters';
import carWgsl from '../shaders/car.wgsl';

export class CarRenderer {
  private opaquePipeline!: GPURenderPipeline;
  private glassPipeline!: GPURenderPipeline;
  private glowPipeline!: GPURenderPipeline;
  private glowIb!: GPUBuffer;
  private glowCount = 0;
  private layout!: GPUBindGroupLayout;
  private bg: GPUBindGroup | null = null;
  private bgVersion = -1;
  private vb!: GPUBuffer;
  private ib!: GPUBuffer;
  private gb!: GPUBuffer;
  private mb!: GPUBuffer;
  private sampler!: GPUSampler;
  private opaqueCount = 0;
  private glassCount = 0;
  /** Canopy droplet/condensation texture (rg = droplet normal, b = fog). */
  canopyFx: GPUTextureView;
  private defaultFx: GPUTexture;
  visible = true;

  constructor(private readonly device: GPUDevice) {
    this.defaultFx = createTexture(device, {
      label: 'car/defaultCanopyFx',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      {texture: this.defaultFx},
      new Uint8Array([128, 128, 0, 255]),
      {},
      [1, 1],
    );
    this.canopyFx = this.defaultFx.createView({
      label: 'car/defaultCanopyFx/view',
    });
  }

  async init(mesh: ModelMesh, sceneLayout: GPUBindGroupLayout) {
    const d = this.device;
    const U = GPUBufferUsage;
    this.vb = createBufferWithData(d, 'car/vertices', mesh.vertices, U.VERTEX);
    this.ib = createBufferWithData(
      d,
      'car/opaqueIndices',
      mesh.opaqueIndices,
      U.INDEX,
    );
    this.gb = createBufferWithData(
      d,
      'car/glassIndices',
      mesh.glassIndices.length ? mesh.glassIndices : new Uint32Array(3),
      U.INDEX,
    );
    this.mb = createBufferWithData(
      d,
      'car/materials',
      mesh.materials,
      U.STORAGE,
    );
    this.glowCount = mesh.glowIndices.length;
    this.glowIb = createBufferWithData(
      d,
      'car/glowIndices',
      mesh.glowIndices.length ? mesh.glowIndices : new Uint32Array(3),
      U.INDEX,
    );
    this.opaqueCount = mesh.opaqueIndices.length;
    this.glassCount = mesh.glassIndices.length;
    this.sampler = createSampler(d, {
      label: 'car/sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.layout = bgl(d, 'car/layout', [
      ['vf', 'storage-ro'],
      ['f', 'tex-float'],
      ['f', 'sampler'],
      ['f', 'tex-float'],
    ]);
    const module = createShaderModule(d, {label: 'car', code: carWgsl});
    const pl = pipelineLayout(d, 'car/pipelineLayout', [
      sceneLayout,
      this.layout,
    ]);
    const vertex: GPUVertexState = {
      module,
      entryPoint: 'vs',
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
    };
    [this.opaquePipeline, this.glassPipeline, this.glowPipeline] =
      await Promise.all([
        createRenderPipeline(d, {
          label: 'car/opaque',
          layout: pl,
          vertex,
          fragment: {
            module,
            entryPoint: 'fs_opaque',
            targets: GEOMETRY_TARGETS,
          },
          primitive: {topology: 'triangle-list', cullMode: 'back'},
          depthStencil: {
            format: DEPTH_FORMAT,
            depthWriteEnabled: true,
            depthCompare: 'greater',
          },
        }),
        createRenderPipeline(d, {
          label: 'car/glass',
          layout: pl,
          vertex,
          fragment: {
            module,
            entryPoint: 'fs_glass',
            targets: [{format: HDR_FORMAT}],
          },
          primitive: {topology: 'triangle-list', cullMode: 'none'},
          depthStencil: {
            format: DEPTH_FORMAT,
            depthWriteEnabled: false,
            depthCompare: 'greater',
          },
        }),
        createRenderPipeline(d, {
          label: 'car/glow',
          layout: pl,
          vertex,
          fragment: {
            module,
            entryPoint: 'fs_glow',
            targets: [
              {
                format: HDR_FORMAT,
                blend: {
                  color: {srcFactor: 'one', dstFactor: 'one'},
                  alpha: {srcFactor: 'zero', dstFactor: 'one'},
                },
              },
            ],
          },
          primitive: {topology: 'triangle-list', cullMode: 'none'},
          depthStencil: {
            format: DEPTH_FORMAT,
            depthWriteEnabled: false,
            depthCompare: 'greater',
          },
        }),
      ]);
  }

  private bindGroupFor(targets: Targets): GPUBindGroup {
    if (!this.bg || this.bgVersion !== targets.version || this.fxDirty) {
      this.bg = bindGroup(this.device, 'car', this.layout, [
        {buffer: this.mb},
        targets.views.litCopy,
        this.sampler,
        this.canopyFx,
      ]);
      this.bgVersion = targets.version;
      this.fxDirty = false;
    }
    return this.bg;
  }

  private fxDirty = false;
  setCanopyFx(view: GPUTextureView) {
    this.canopyFx = view;
    this.fxDirty = true;
  }

  drawOpaque(
    pass: GPURenderPassEncoder,
    sceneBg: GPUBindGroup,
    targets: Targets,
  ) {
    if (!this.visible) return;
    pass.setPipeline(this.opaquePipeline);
    pass.setBindGroup(0, sceneBg);
    pass.setBindGroup(1, this.bindGroupFor(targets));
    pass.setVertexBuffer(0, this.vb);
    pass.setIndexBuffer(this.ib, 'uint32');
    pass.drawIndexed(this.opaqueCount);
  }

  drawGlass(
    pass: GPURenderPassEncoder,
    sceneBg: GPUBindGroup,
    targets: Targets,
  ) {
    if (!this.visible || this.glassCount === 0) return;
    pass.setPipeline(this.glassPipeline);
    pass.setBindGroup(0, sceneBg);
    pass.setBindGroup(1, this.bindGroupFor(targets));
    pass.setVertexBuffer(0, this.vb);
    pass.setIndexBuffer(this.gb, 'uint32');
    pass.drawIndexed(this.glassCount);
  }

  drawGlow(
    pass: GPURenderPassEncoder,
    sceneBg: GPUBindGroup,
    targets: Targets,
  ) {
    if (!this.visible || this.glowCount === 0) return;
    pass.setPipeline(this.glowPipeline);
    pass.setBindGroup(0, sceneBg);
    pass.setBindGroup(1, this.bindGroupFor(targets));
    pass.setVertexBuffer(0, this.vb);
    pass.setIndexBuffer(this.glowIb, 'uint32');
    pass.drawIndexed(this.glowCount);
  }
}

/** The car's own lights (headlights, tail lights, thruster glow) in world space. */
export function carLights(m: Mat4, time: number): LightDesc[] {
  const P = (p: Vec3) => transformPoint(m, p);
  const D = (d: Vec3) => transformDir(m, d);
  const fwd = D([0, 0, -1]);
  const flick = 0.9 + 0.1 * Math.sin(time * 37);
  return [
    {
      pos: P([-0.6, 0.7, -2.9]),
      radius: 60,
      color: [16, 15, 13],
      spot: {dir: fwd, cosCone: Math.cos(0.45)},
    },
    {
      pos: P([0.6, 0.7, -2.9]),
      radius: 60,
      color: [16, 15, 13],
      spot: {dir: fwd, cosCone: Math.cos(0.45)},
    },
    {
      pos: P([0, 0.7, 3.2]),
      radius: 12,
      color: [6, 0.3, 0.2],
      spot: {dir: D([0, 0, 1]), cosCone: Math.cos(1.0)},
    },
    {
      pos: P([0, -0.4, 0]),
      radius: 7,
      color: [0.8 * flick, 2.0 * flick, 4.0 * flick],
    },
  ];
}
