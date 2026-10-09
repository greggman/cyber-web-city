// Procedural material atlas (ART_BIBLE.md 12.1 D): tileable micro-surface
// (height, normal, roughness) baked once at startup on the GPU, with mips,
// sampled by the facade and kit shaders. See shaders/atlas_bake.wgsl for
// the layers.
import {
  createBindGroup,
  createBindGroupLayout,
  createComputePipeline,
  createSampler,
  createShaderModule,
  createTexture,
} from '../gpu/gpu';
import {pipelineLayout} from '../gpu/layout';
import bakeWgsl from '../shaders/atlas_bake.wgsl';
import mipWgsl from '../shaders/atlas_mip.wgsl';

export const ATLAS_LAYERS = 8;
const SIZE = 256;
const MIPS = 9;

export class MaterialAtlas {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;

  constructor(private readonly device: GPUDevice) {
    this.texture = createTexture(device, {
      label: 'atlas/materials',
      size: [SIZE, SIZE, ATLAS_LAYERS],
      mipLevelCount: MIPS,
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    this.view = this.texture.createView({
      label: 'atlas/materials/view',
      dimension: '2d-array',
    });
    this.sampler = createSampler(device, {
      label: 'atlas/sampler',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 8,
    });
  }

  /** Bakes all layers and their mips. */
  async bake() {
    const d = this.device;
    const store = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: {
        access: 'write-only',
        format: 'rgba8unorm',
        viewDimension: '2d-array',
      },
    });
    const bakeLayout = createBindGroupLayout(d, {
      label: 'atlas/bake/layout',
      entries: [store(0)],
    });
    const mipLayout = createBindGroupLayout(d, {
      label: 'atlas/mip/layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: {sampleType: 'float', viewDimension: '2d-array'},
        },
        store(1),
      ],
    });
    const [bake, mip] = await Promise.all([
      createComputePipeline(d, {
        label: 'atlas/bake',
        layout: pipelineLayout(d, 'atlas/bake/pipelineLayout', [bakeLayout]),
        compute: {
          module: createShaderModule(d, {label: 'atlas/bake', code: bakeWgsl}),
          entryPoint: 'cs_bake',
        },
      }),
      createComputePipeline(d, {
        label: 'atlas/mip',
        layout: pipelineLayout(d, 'atlas/mip/pipelineLayout', [mipLayout]),
        compute: {
          module: createShaderModule(d, {label: 'atlas/mip', code: mipWgsl}),
          entryPoint: 'cs_mip',
        },
      }),
    ]);
    const level = (l: number) =>
      this.texture.createView({
        label: `atlas/materials/mip${l}`,
        dimension: '2d-array',
        baseMipLevel: l,
        mipLevelCount: 1,
      });
    const encoder = d.createCommandEncoder({label: 'atlas/bake'});
    const pass = encoder.beginComputePass({label: 'atlas/bake'});
    pass.setPipeline(bake);
    pass.setBindGroup(
      0,
      createBindGroup(d, {
        label: 'atlas/bake/bg',
        layout: bakeLayout,
        entries: [{binding: 0, resource: level(0)}],
      }),
    );
    pass.dispatchWorkgroups(SIZE / 8, SIZE / 8, ATLAS_LAYERS);
    pass.setPipeline(mip);
    for (let l = 1; l < MIPS; l++) {
      const s = Math.max(1, SIZE >> l);
      pass.setBindGroup(
        0,
        createBindGroup(d, {
          label: `atlas/mip${l}/bg`,
          layout: mipLayout,
          entries: [
            {binding: 0, resource: level(l - 1)},
            {binding: 1, resource: level(l)},
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), ATLAS_LAYERS);
    }
    pass.end();
    d.queue.submit([encoder.finish()]);
  }
}
