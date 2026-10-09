// Canopy droplets and condensation (see src/shaders/canopy.wgsl). Produces a
// 512x512 texture in canopy uv space sampled by the car's glass shader.
import {tw} from '../gpu/timer';
import {
  createBuffer,
  createBufferWithData,
  createComputePipeline,
  createRenderPipeline,
  createSampler,
  createShaderModule,
  createTexture,
} from '../gpu/gpu';
import {Rng} from '../math/random';
import canopyWgsl from '../shaders/canopy.wgsl';

const SIZE = 512;
const DROPS = 650;

export class Canopy {
  private params: GPUBuffer;
  private drops: GPUBuffer;
  private fog: GPUTexture[];
  private dropTex: GPUTexture;
  readonly fx: GPUTexture;
  readonly fxView: GPUTextureView;
  private sampler: GPUSampler;
  private update!: GPUComputePipeline;
  private dropPipe!: GPURenderPipeline;
  private wipePipe!: GPURenderPipeline;
  private fogPipe!: GPURenderPipeline;
  private combinePipe!: GPURenderPipeline;
  private bgs: Record<string, GPUBindGroup> = {};
  private flip = 0;
  private frame = 0;

  constructor(private readonly device: GPUDevice) {
    const d = device;
    this.params = createBuffer(d, {
      label: 'canopy/params',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const rng = new Rng(77);
    const init = new Float32Array(DROPS * 8);
    for (let i = 0; i < DROPS; i++) {
      // Start with a scattering of static drops already on the glass.
      init.set(
        [
          rng.next(),
          rng.next(),
          0,
          0,
          rng.range(0.0012, 0.005),
          rng.range(0, 20),
          rng.next(),
          rng.next(),
        ],
        i * 8,
      );
    }
    this.drops = createBufferWithData(
      d,
      'canopy/drops',
      init,
      GPUBufferUsage.STORAGE,
    );
    const RT =
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.fog = [0, 1].map(i =>
      createTexture(d, {
        label: `canopy/fog${i}`,
        size: [SIZE, SIZE],
        format: 'r8unorm',
        usage: RT,
      }),
    );
    this.dropTex = createTexture(d, {
      label: 'canopy/drops',
      size: [SIZE, SIZE],
      format: 'rgba8unorm',
      usage: RT,
    });
    this.fx = createTexture(d, {
      label: 'canopy/fx',
      size: [SIZE, SIZE],
      format: 'rgba8unorm',
      usage: RT,
    });
    this.fxView = this.fx.createView({label: 'canopy/fx/view'});
    this.sampler = createSampler(d, {
      label: 'canopy/sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  async init() {
    const d = this.device;
    const module = createShaderModule(d, {label: 'canopy', code: canopyWgsl});
    const over: GPUBlendState = {
      color: {srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha'},
      alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha'},
    };
    const min: GPUBlendState = {
      color: {srcFactor: 'one', dstFactor: 'one', operation: 'min'},
      alpha: {srcFactor: 'one', dstFactor: 'one', operation: 'min'},
    };
    const full = (label: string, fs: string, format: GPUTextureFormat) =>
      createRenderPipeline(d, {
        label,
        layout: 'auto',
        vertex: {module, entryPoint: 'vs_full'},
        fragment: {module, entryPoint: fs, targets: [{format}]},
      });
    [
      this.update,
      this.dropPipe,
      this.wipePipe,
      this.fogPipe,
      this.combinePipe,
    ] = (await Promise.all([
      createComputePipeline(d, {
        label: 'canopy/update',
        layout: 'auto',
        compute: {module, entryPoint: 'cs_update'},
      }),
      createRenderPipeline(d, {
        label: 'canopy/drops',
        layout: 'auto',
        vertex: {module, entryPoint: 'vs_drop'},
        fragment: {
          module,
          entryPoint: 'fs_drop',
          targets: [{format: 'rgba8unorm', blend: over}],
        },
      }),
      createRenderPipeline(d, {
        label: 'canopy/wipe',
        layout: 'auto',
        vertex: {module, entryPoint: 'vs_drop'},
        fragment: {
          module,
          entryPoint: 'fs_wipe',
          targets: [{format: 'r8unorm', blend: min}],
        },
      }),
      full('canopy/fog', 'fs_fog', 'r8unorm'),
      full('canopy/combine', 'fs_combine', 'rgba8unorm'),
    ])) as [
      GPUComputePipeline,
      GPURenderPipeline,
      GPURenderPipeline,
      GPURenderPipeline,
      GPURenderPipeline,
    ];
    const bg = (
      label: string,
      p: GPUComputePipeline | GPURenderPipeline,
      entries: [number, GPUBindingResource][],
    ) =>
      d.createBindGroup({
        label,
        layout: p.getBindGroupLayout(0),
        entries: entries.map(([binding, resource]) => ({binding, resource})),
      });
    const fogViews = this.fog.map((t, i) =>
      t.createView({label: `canopy/fog${i}/view`}),
    );
    this.fogViews = fogViews;
    this.bgs.update = bg('canopy/update', this.update, [
      [0, {buffer: this.params}],
      [1, {buffer: this.drops}],
    ]);
    // 'auto' layouts only contain bindings each entry point uses.
    this.bgs.drops = bg('canopy/drops', this.dropPipe, [
      [2, {buffer: this.drops}],
    ]);
    this.bgs.wipe = bg('canopy/wipe', this.wipePipe, [
      [2, {buffer: this.drops}],
    ]);
    for (const i of [0, 1]) {
      this.bgs[`fog${i}`] = bg(`canopy/fog${i}`, this.fogPipe, [
        [0, {buffer: this.params}],
        [3, fogViews[1 - i]],
        [5, this.sampler],
      ]);
      this.bgs[`combine${i}`] = bg(`canopy/combine${i}`, this.combinePipe, [
        [0, {buffer: this.params}],
        [4, this.dropTex.createView({label: 'canopy/drops/view'})],
        [5, this.sampler],
        [6, fogViews[i]],
      ]);
    }
  }

  private fogViews: GPUTextureView[] = [];

  run(
    encoder: GPUCommandEncoder,
    dt: number,
    time: number,
    speed: number,
    rain: number,
    pov: boolean,
  ) {
    const p = new ArrayBuffer(32);
    const f = new Float32Array(p);
    const u = new Uint32Array(p);
    f[0] = Math.min(dt, 0.1);
    f[1] = time;
    f[2] = speed;
    f[3] = rain;
    u[4] = this.frame++;
    u[5] = DROPS;
    f[6] = pov ? 1 : 0;
    this.device.queue.writeBuffer(this.params, 0, p);
    const cur = this.flip;
    this.flip = 1 - this.flip;

    const cp = encoder.beginComputePass({
      label: 'canopy/update',
      timestampWrites: tw('canopy/update'),
    });
    cp.setPipeline(this.update);
    cp.setBindGroup(0, this.bgs.update);
    cp.dispatchWorkgroups(Math.ceil(DROPS / 64));
    cp.end();

    const pass = (
      label: string,
      view: GPUTextureView,
      load: GPULoadOp,
      fn: (p: GPURenderPassEncoder) => void,
    ) => {
      const rp = encoder.beginRenderPass({
        label,
        colorAttachments: [
          {view, loadOp: load, storeOp: 'store', clearValue: [0.5, 0.5, 0, 0]},
        ],
      });
      fn(rp);
      rp.end();
    };
    pass('canopy/fog', this.fogViews[cur], 'clear', rp => {
      rp.setPipeline(this.fogPipe);
      rp.setBindGroup(0, this.bgs[`fog${cur}`]);
      rp.draw(3);
    });
    pass('canopy/wipe', this.fogViews[cur], 'load', rp => {
      rp.setPipeline(this.wipePipe);
      rp.setBindGroup(0, this.bgs.wipe);
      rp.draw(6, DROPS);
    });
    pass(
      'canopy/drops',
      this.dropTex.createView({label: 'canopy/drops/rt'}),
      'clear',
      rp => {
        rp.setPipeline(this.dropPipe);
        rp.setBindGroup(0, this.bgs.drops);
        rp.draw(6, DROPS);
      },
    );
    pass('canopy/combine', this.fxView, 'clear', rp => {
      rp.setPipeline(this.combinePipe);
      rp.setBindGroup(0, this.bgs[`combine${cur}`]);
      rp.draw(3);
    });
  }
}
