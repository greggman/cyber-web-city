// Post-processing: TAA, bloom mip chain, anamorphic streaks.
import {
  bindGroup,
  createBuffer,
  createSampler,
  createTexture,
} from '../gpu/gpu';
import {bgl} from '../gpu/layout';
import {fullscreenPipeline, runFullscreen} from './fullscreen';
import {HDR_FORMAT, type Targets} from './targets';
import taaWgsl from '../shaders/taa.wgsl';
import bloomWgsl from '../shaders/bloom.wgsl';

const BLOOM_MIPS = 6;

/** Halton sequence for TAA jitter. */
function halton(i: number, b: number): number {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}

export function taaJitter(frameIndex: number): [number, number] {
  const i = (frameIndex % 8) + 1;
  return [halton(i, 2) - 0.5, halton(i, 3) - 0.5];
}

export class Post {
  private sampler: GPUSampler;
  private taaLayout: GPUBindGroupLayout;
  private bloomLayout: GPUBindGroupLayout;
  private taaPipeline!: GPURenderPipeline;
  private downPipeline!: GPURenderPipeline;
  private upPipeline!: GPURenderPipeline;
  private streakPrePipeline!: GPURenderPipeline;
  private streakPipeline!: GPURenderPipeline;
  private history: GPUTexture[] = [];
  private bloom!: GPUTexture;
  private streak: GPUTexture[] = [];
  private version = -1;
  private taaBgs: GPUBindGroup[] = [];
  private downBgs: GPUBindGroup[] = [];
  private upBgs: GPUBindGroup[] = [];
  private streakBgs: GPUBindGroup[] = [];
  private params: GPUBuffer[] = [];
  private mipViews: GPUTextureView[] = [];
  private flip = 0;
  /** The TAA output of the current frame (input to bloom and tonemap). */
  resolved!: GPUTextureView;
  bloomView!: GPUTextureView;
  streakView!: GPUTextureView;

  constructor(private readonly device: GPUDevice) {
    this.sampler = createSampler(device, {
      label: 'post/linearClamp',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.taaLayout = bgl(device, 'taa/layout', [
      ['f', 'tex-float'],
      ['f', 'tex-float'],
      ['f', 'tex-float'],
      ['f', 'tex-depth'],
      ['f', 'sampler'],
    ]);
    this.bloomLayout = bgl(device, 'bloom/layout', [
      ['f', 'tex-float'],
      ['f', 'sampler'],
      ['f', 'uniform'],
    ]);
  }

  async init(frameLayout: GPUBindGroupLayout) {
    const d = this.device;
    const additive: GPUBlendState = {
      color: {srcFactor: 'one', dstFactor: 'one'},
      alpha: {srcFactor: 'one', dstFactor: 'one'},
    };
    [
      this.taaPipeline,
      this.downPipeline,
      this.upPipeline,
      this.streakPrePipeline,
      this.streakPipeline,
    ] = await Promise.all([
      fullscreenPipeline(
        d,
        'taa',
        taaWgsl,
        [frameLayout, this.taaLayout],
        [{format: HDR_FORMAT}],
      ),
      fullscreenPipeline(
        d,
        'bloom/down',
        bloomWgsl,
        [this.bloomLayout],
        [{format: HDR_FORMAT}],
        'fs_down',
      ),
      fullscreenPipeline(
        d,
        'bloom/up',
        bloomWgsl,
        [this.bloomLayout],
        [{format: HDR_FORMAT, blend: additive}],
        'fs_up',
      ),
      fullscreenPipeline(
        d,
        'streak/prefilter',
        bloomWgsl,
        [this.bloomLayout],
        [{format: HDR_FORMAT}],
        'fs_streak_prefilter',
      ),
      fullscreenPipeline(
        d,
        'streak/blur',
        bloomWgsl,
        [this.bloomLayout],
        [{format: HDR_FORMAT}],
        'fs_streak',
      ),
    ]);
  }

  private makeParams(
    label: string,
    texel: [number, number],
    karis: number,
    step: number,
  ): GPUBuffer {
    const b = createBuffer(this.device, {
      label,
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(
      b,
      0,
      new Float32Array([texel[0], texel[1], karis, step]),
    );
    this.params.push(b);
    return b;
  }

  private rebuild(t: Targets) {
    const d = this.device;
    for (const x of [...this.history, this.bloom, ...this.streak]) x?.destroy();
    for (const p of this.params) p.destroy();
    this.params = [];
    const w = t.width;
    const h = t.height;
    const RT =
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.history = [0, 1].map(i =>
      createTexture(d, {
        label: `taa/history${i}`,
        size: [w, h],
        format: HDR_FORMAT,
        usage: RT,
      }),
    );
    const bw = Math.max(1, w >> 1);
    const bh = Math.max(1, h >> 1);
    const mips = Math.min(BLOOM_MIPS, Math.floor(Math.log2(Math.min(bw, bh))));
    this.bloom = createTexture(d, {
      label: 'bloom/chain',
      size: [bw, bh],
      format: HDR_FORMAT,
      mipLevelCount: mips,
      usage: RT,
    });
    this.mipViews = Array.from({length: mips}, (_, m) =>
      this.bloom.createView({
        label: `bloom/mip${m}`,
        baseMipLevel: m,
        mipLevelCount: 1,
      }),
    );
    this.bloomView = this.mipViews[0];
    const sw = Math.max(1, w >> 2);
    const sh = Math.max(1, h >> 3);
    this.streak = [0, 1].map(i =>
      createTexture(d, {
        label: `streak/${i}`,
        size: [sw, sh],
        format: HDR_FORMAT,
        usage: RT,
      }),
    );
    const views = this.history.map((x, i) =>
      x.createView({label: `taa/history${i}/view`}),
    );
    const tv = t.views;
    this.taaBgs = [0, 1].map(i =>
      bindGroup(d, `taa/${i}`, this.taaLayout, [
        tv.lit,
        views[1 - i],
        tv.velocity,
        tv.depth,
        this.sampler,
      ]),
    );
    this.historyViews = views;
    // Down chain: source is TAA output for mip 0, then the previous mip.
    this.downBgs = [];
    for (let m = 0; m < mips; m++) {
      const srcW = m === 0 ? w : bw >> (m - 1);
      const srcH = m === 0 ? h : bh >> (m - 1);
      const params = this.makeParams(
        `bloom/down${m}/params`,
        [1 / srcW, 1 / srcH],
        m === 0 ? 1 : 0,
        1,
      );
      if (m === 0) {
        // Two variants for the two history textures.
        this.downBgs.push(
          bindGroup(d, 'bloom/down0/a', this.bloomLayout, [
            views[0],
            this.sampler,
            {buffer: params},
          ]),
          bindGroup(d, 'bloom/down0/b', this.bloomLayout, [
            views[1],
            this.sampler,
            {buffer: params},
          ]),
        );
      } else {
        this.downBgs.push(
          bindGroup(d, `bloom/down${m}`, this.bloomLayout, [
            this.mipViews[m - 1],
            this.sampler,
            {buffer: params},
          ]),
        );
      }
    }
    this.upBgs = [];
    for (let m = mips - 1; m > 0; m--) {
      const params = this.makeParams(
        `bloom/up${m}/params`,
        [1 / (bw >> m), 1 / (bh >> m)],
        0,
        1,
      );
      this.upBgs.push(
        bindGroup(d, `bloom/up${m}`, this.bloomLayout, [
          this.mipViews[m],
          this.sampler,
          {buffer: params},
        ]),
      );
    }
    const sv = this.streak.map((x, i) =>
      x.createView({label: `streak/${i}/view`}),
    );
    const pre = this.makeParams(
      'streak/pre/params',
      [1 / (bw >> 1), 1 / (bh >> 1)],
      0,
      1,
    );
    this.streakBgs = [
      bindGroup(d, 'streak/pre', this.bloomLayout, [
        this.mipViews[Math.min(1, mips - 1)],
        this.sampler,
        {buffer: pre},
      ]),
    ];
    // Ping-pong horizontal blurs with growing step.
    const steps = [1, 3, 9];
    steps.forEach((st, k) => {
      const params = this.makeParams(
        `streak/blur${k}/params`,
        [1 / sw, 1 / sh],
        0,
        st,
      );
      this.streakBgs.push(
        bindGroup(d, `streak/blur${k}`, this.bloomLayout, [
          sv[k % 2],
          this.sampler,
          {buffer: params},
        ]),
      );
    });
    this.streakViews = sv;
    this.version = t.version;
  }

  private historyViews: GPUTextureView[] = [];
  private streakViews: GPUTextureView[] = [];

  run(encoder: GPUCommandEncoder, t: Targets, frameBindGroup: GPUBindGroup) {
    if (this.version !== t.version) this.rebuild(t);
    const cur = this.flip;
    this.flip = 1 - this.flip;
    runFullscreen(encoder, 'taa', this.historyViews[cur], this.taaPipeline, [
      frameBindGroup,
      this.taaBgs[cur],
    ]);
    this.resolved = this.historyViews[cur];
    // Bloom down.
    const mips = this.mipViews.length;
    for (let m = 0; m < mips; m++) {
      const bg = m === 0 ? this.downBgs[cur] : this.downBgs[m + 1];
      runFullscreen(
        encoder,
        `bloom/down${m}`,
        this.mipViews[m],
        this.downPipeline,
        [bg],
      );
    }
    // Bloom up (additive into the finer level).
    this.upBgs.forEach((bg, k) => {
      const m = mips - 1 - k;
      runFullscreen(
        encoder,
        `bloom/up${m}`,
        this.mipViews[m - 1],
        this.upPipeline,
        [bg],
        'load',
      );
    });
    // Streaks.
    const sv = this.streakViews;
    runFullscreen(encoder, 'streak/pre', sv[0], this.streakPrePipeline, [
      this.streakBgs[0],
    ]);
    runFullscreen(encoder, 'streak/blur0', sv[1], this.streakPipeline, [
      this.streakBgs[1],
    ]);
    runFullscreen(encoder, 'streak/blur1', sv[0], this.streakPipeline, [
      this.streakBgs[2],
    ]);
    runFullscreen(encoder, 'streak/blur2', sv[1], this.streakPipeline, [
      this.streakBgs[3],
    ]);
    this.streakView = sv[1];
  }
}
