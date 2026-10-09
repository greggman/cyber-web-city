// Froxel volumetric in-scattering (see src/shaders/volumetric.wgsl).
import {
  bindGroup,
  createBufferWithData,
  createComputePipeline,
  createShaderModule,
  createTexture,
} from '../gpu/gpu';
import {tw} from '../gpu/timer';
import {bgl, pipelineLayout} from '../gpu/layout';
import volumetricWgsl from '../shaders/volumetric.wgsl';

const VX = 160;
const VY = 90;
const VZ = 64;

export class Volumetrics {
  private inject: GPUTexture;
  private integrated: GPUTexture;
  private injectPipe!: GPUComputePipeline;
  private integratePipe!: GPUComputePipeline;
  private injectBg!: GPUBindGroup;
  private integrateBg!: GPUBindGroup;
  readonly view: GPUTextureView;
  enabled = true;

  constructor(private readonly device: GPUDevice) {
    const usage =
      GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    this.inject = createTexture(device, {
      label: 'volume/inject',
      size: [VX, VY, VZ],
      dimension: '3d',
      format: 'rgba16float',
      usage,
    });
    this.integrated = createTexture(device, {
      label: 'volume/integrated',
      size: [VX, VY, VZ],
      dimension: '3d',
      format: 'rgba16float',
      usage,
    });
    this.view = this.integrated.createView({label: 'volume/integrated/view'});
  }

  async init(sceneLayout: GPUBindGroupLayout, strength = 1) {
    const d = this.device;
    const strengthBuf = createBufferWithData(
      d,
      'volume/strength',
      new Float32Array([strength, 0, 0, 0]),
      GPUBufferUsage.UNIFORM,
    );
    const il = bgl(d, 'volume/inject/layout', [
      ['c', 'storage-tex-3d:rgba16float', 0],
      ['c', 'uniform', 3],
    ]);
    const gl = bgl(d, 'volume/integrate/layout', [
      ['c', 'tex-float-3d', 1],
      ['c', 'storage-tex-3d:rgba16float', 2],
      ['c', 'uniform', 3],
    ]);
    this.injectBg = d.createBindGroup({
      label: 'volume/inject',
      layout: il,
      entries: [
        {
          binding: 0,
          resource: this.inject.createView({label: 'volume/inject/storage'}),
        },
        {binding: 3, resource: {buffer: strengthBuf}},
      ],
    });
    this.integrateBg = d.createBindGroup({
      label: 'volume/integrate',
      layout: gl,
      entries: [
        {
          binding: 1,
          resource: this.inject.createView({label: 'volume/inject/sampled'}),
        },
        {
          binding: 2,
          resource: this.integrated.createView({
            label: 'volume/integrated/storage',
          }),
        },
        {binding: 3, resource: {buffer: strengthBuf}},
      ],
    });
    void bindGroup;
    const module = createShaderModule(d, {
      label: 'volumetric',
      code: volumetricWgsl,
    });
    [this.injectPipe, this.integratePipe] = await Promise.all([
      createComputePipeline(d, {
        label: 'volume/inject',
        layout: pipelineLayout(d, 'volume/inject/pipelineLayout', [
          sceneLayout,
          il,
        ]),
        compute: {module, entryPoint: 'cs_inject'},
      }),
      createComputePipeline(d, {
        label: 'volume/integrate',
        layout: pipelineLayout(d, 'volume/integrate/pipelineLayout', [
          sceneLayout,
          gl,
        ]),
        compute: {module, entryPoint: 'cs_integrate'},
      }),
    ]);
  }

  run(encoder: GPUCommandEncoder, sceneBg: GPUBindGroup) {
    if (!this.enabled) return;
    let pass = encoder.beginComputePass({
      label: 'volume/inject',
      timestampWrites: tw('volume/inject'),
    });
    pass.setPipeline(this.injectPipe);
    pass.setBindGroup(0, sceneBg);
    pass.setBindGroup(1, this.injectBg);
    pass.dispatchWorkgroups(Math.ceil(VX / 8), Math.ceil(VY / 8), VZ);
    pass.end();
    pass = encoder.beginComputePass({
      label: 'volume/integrate',
      timestampWrites: tw('volume/integrate'),
    });
    pass.setPipeline(this.integratePipe);
    pass.setBindGroup(0, sceneBg);
    pass.setBindGroup(1, this.integrateBg);
    pass.dispatchWorkgroups(Math.ceil(VX / 8), Math.ceil(VY / 8), 1);
    pass.end();
  }
}
