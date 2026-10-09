// Froxel volumetric in-scattering (see src/shaders/volumetric.wgsl).
import {
  createBuffer,
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

const BEAMS = 16;

export class Volumetrics {
  /** Searchlight beams (16 x {origin, len, dir, intensity}). */
  beamBuf!: GPUBuffer;
  private inject: GPUTexture;
  private integrated: GPUTexture;
  private injectPipe!: GPUComputePipeline;
  private integratePipe!: GPUComputePipeline;
  private injectBg!: GPUBindGroup;
  private integrateBg!: GPUBindGroup;
  readonly view: GPUTextureView;
  enabled = true;
  private strengthBuf!: GPUBuffer;
  private strength = 1;
  private written = -1;

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
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.strengthBuf = strengthBuf;
    this.strength = strength;
    const il = bgl(d, 'volume/inject/layout', [
      ['c', 'storage-tex-3d:rgba16float', 0],
      ['c', 'uniform', 3],
      ['c', 'uniform', 4],
    ]);
    this.beamBuf = createBuffer(d, {
      label: 'volume/beams',
      size: BEAMS * 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
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
        {binding: 4, resource: {buffer: this.beamBuf}},
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

  /** Searchlight sources (rooftops of tall Core/Corporate towers). */
  beamSources: [number, number, number][] = [];

  /** Uploads the beams nearest the camera, sweeping over time. */
  updateBeams(camPos: [number, number, number], time: number) {
    const near = this.beamSources
      .map((s, i) => ({
        s,
        i,
        d: Math.hypot(s[0] - camPos[0], s[2] - camPos[2]),
      }))
      .filter(b => b.d < 2500)
      .sort((a, b) => a.d - b.d)
      .slice(0, BEAMS);
    const data = new Float32Array(BEAMS * 8);
    near.forEach(({s, i}, k) => {
      // Slow sweep (0.05-0.15 rad/s) at 55-80 degrees elevation.
      const h = Math.sin(i * 12.9898) * 43758.5453;
      const r = h - Math.floor(h);
      const az = r * Math.PI * 2 + time * (0.05 + 0.1 * r) * (i % 2 ? 1 : -1);
      const el = 0.96 + 0.3 * Math.sin(time * 0.07 + i);
      const ce = Math.cos(el);
      data.set(
        [
          s[0],
          s[1],
          s[2],
          1400,
          Math.cos(az) * ce,
          Math.sin(el),
          Math.sin(az) * ce,
          20.0,
        ],
        k * 8,
      );
    });
    this.device.queue.writeBuffer(this.beamBuf, 0, data);
  }

  run(encoder: GPUCommandEncoder, sceneBg: GPUBindGroup) {
    // Disabled: integrate once with zero strength so the composite reads
    // an empty volume, then skip the work entirely.
    const want = this.enabled ? this.strength : 0;
    if (want !== this.written) {
      this.device.queue.writeBuffer(
        this.strengthBuf,
        0,
        new Float32Array([want, 0, 0, 0]),
      );
    }
    if (!this.enabled && this.written === 0) return;
    this.written = want;
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
