// Rain particles (see src/shaders/rain.wgsl).
import {tw} from '../gpu/timer';
import {
  bindGroup,
  createBuffer,
  createBufferWithData,
  createComputePipeline,
  createRenderPipeline,
  createShaderModule,
} from '../gpu/gpu';
import {bgl, pipelineLayout} from '../gpu/layout';
import {Rng} from '../math/random';
import type {Vec3} from '../math/vec';
import {DEPTH_FORMAT, HDR_FORMAT} from './targets';
import rainWgsl from '../shaders/rain.wgsl';

const BOX: Vec3 = [70, 60, 70];

export class Rain {
  private drops: GPUBuffer;
  private params: GPUBuffer;
  private computeBg!: GPUBindGroup;
  private renderBg!: GPUBindGroup;
  private update!: GPUComputePipeline;
  private draw!: GPURenderPipeline;
  private prevCam: Vec3 | null = null;
  intensity = 1;

  constructor(
    private readonly device: GPUDevice,
    readonly count = 60000,
  ) {
    const rng = new Rng(9);
    const data = new Float32Array(count * 8);
    for (let i = 0; i < count; i++) {
      data.set(
        [
          rng.range(-35, 35),
          rng.range(-30, 30),
          rng.range(-35, 35),
          rng.next(),
        ],
        i * 8,
      );
    }
    this.drops = createBufferWithData(
      device,
      'rain/drops',
      data,
      GPUBufferUsage.STORAGE,
    );
    this.params = createBuffer(device, {
      label: 'rain/params',
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  async init(sceneLayout: GPUBindGroupLayout) {
    const d = this.device;
    const cl = bgl(d, 'rain/compute/layout', [
      ['c', 'storage-rw'],
      ['c', 'uniform'],
    ]);
    const rl = bgl(d, 'rain/render/layout', [
      ['c', 'uniform'], // binding 0 unused by the render stages (placeholder)
      ['v', 'uniform'],
      ['v', 'storage-ro'],
    ]);
    this.computeBg = bindGroup(d, 'rain/compute', cl, [
      {buffer: this.drops},
      {buffer: this.params},
    ]);
    this.renderBg = bindGroup(d, 'rain/render', rl, [
      {buffer: this.params},
      {buffer: this.params},
      {buffer: this.drops},
    ]);
    const module = createShaderModule(d, {label: 'rain', code: rainWgsl});
    const additive: GPUBlendState = {
      color: {srcFactor: 'one', dstFactor: 'one'},
      alpha: {srcFactor: 'zero', dstFactor: 'one'},
    };
    [this.update, this.draw] = await Promise.all([
      createComputePipeline(d, {
        label: 'rain/update',
        layout: pipelineLayout(d, 'rain/update/pipelineLayout', [
          sceneLayout,
          cl,
        ]),
        compute: {module, entryPoint: 'cs_update'},
      }),
      createRenderPipeline(d, {
        label: 'rain/draw',
        layout: pipelineLayout(d, 'rain/draw/pipelineLayout', [
          sceneLayout,
          rl,
        ]),
        vertex: {module, entryPoint: 'vs'},
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [{format: HDR_FORMAT, blend: additive}],
        },
        primitive: {topology: 'triangle-list'},
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: false,
          depthCompare: 'greater',
        },
      }),
    ]);
  }

  /** Call once per frame before rendering. */
  setFrame(camPos: Vec3, forward: Vec3, vel: Vec3) {
    this.prevCam = camPos;
    const center: Vec3 = [
      camPos[0] + forward[0] * 20,
      camPos[1] + forward[1] * 20,
      camPos[2] + forward[2] * 20,
    ];
    const p = new Float32Array(16);
    p.set(vel, 0);
    new Uint32Array(p.buffer)[3] = this.count;
    p.set(center, 4);
    p[7] = this.intensity * 3;
    p.set(BOX, 8);
    p[11] = 1 / 40; // streak exposure (s)
    p.set([2.5, 0, 1.2], 12);
    p[15] = 10;
    this.device.queue.writeBuffer(this.params, 0, p);
  }

  compute(encoder: GPUCommandEncoder, sceneBg: GPUBindGroup) {
    if (this.intensity <= 0) return;
    const pass = encoder.beginComputePass({
      label: 'rain/update',
      timestampWrites: tw('rain/update'),
    });
    pass.setPipeline(this.update);
    pass.setBindGroup(0, sceneBg);
    pass.setBindGroup(1, this.computeBg);
    pass.dispatchWorkgroups(Math.ceil(this.count / 64));
    pass.end();
  }

  render(pass: GPURenderPassEncoder, sceneBg: GPUBindGroup) {
    if (this.intensity <= 0) return;
    pass.setPipeline(this.draw);
    pass.setBindGroup(0, sceneBg);
    pass.setBindGroup(1, this.renderBg);
    pass.draw(6, this.count);
  }
}
