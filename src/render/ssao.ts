// Half-resolution SSAO from the depth prepass (see shaders/ssao.wgsl).
// Scene shaders that bind `aoLayout` at group 2 multiply ambient light by it.
import {bindGroup, createSampler, createTexture} from '../gpu/gpu';
import {bgl} from '../gpu/layout';
import {fullscreenPipeline, runFullscreen} from './fullscreen';
import type {Targets} from './targets';
import type {MaterialAtlas} from './materialAtlas';
import ssaoWgsl from '../shaders/ssao.wgsl';
import blurWgsl from '../shaders/ssao_blur.wgsl';

export class Ssao {
  readonly aoLayout: GPUBindGroupLayout;
  private inLayout: GPUBindGroupLayout;
  private pipeline!: GPURenderPipeline;
  private blurPipeline!: GPURenderPipeline;
  private blurLayout: GPUBindGroupLayout;
  private blurBg!: GPUBindGroup;
  private raw: GPUTexture | null = null;
  private sampler: GPUSampler;
  private tex: GPUTexture | null = null;
  private white: GPUTexture;
  private inBg!: GPUBindGroup;
  private version = -1;
  /** Group-2 bind group for scene shaders (AO texture + sampler). */
  aoBindGroup!: GPUBindGroup;
  private whiteBg: GPUBindGroup;
  enabled = true;

  constructor(
    private readonly device: GPUDevice,
    private readonly atlas: MaterialAtlas,
  ) {
    // Group 2 of the scene shaders: AO, plus the material atlas (it rides
    // along here so the city and kit pipelines need no extra group).
    this.aoLayout = bgl(device, 'ssao/sample/layout', [
      ['f', 'tex-float'],
      ['f', 'sampler'],
      ['f', 'tex-float-2d-array'],
      ['f', 'sampler'],
    ]);
    this.inLayout = bgl(device, 'ssao/in/layout', [['f', 'tex-depth']]);
    this.blurLayout = bgl(device, 'ssao/blur/layout', [
      ['f', 'tex-unfilterable'],
      ['f', 'tex-depth'],
    ]);
    this.sampler = createSampler(device, {
      label: 'ssao/sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.white = createTexture(device, {
      label: 'ssao/white',
      size: [1, 1],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      {texture: this.white},
      new Uint8Array([255]),
      {},
      [1, 1],
    );
    this.whiteBg = bindGroup(device, 'ssao/whiteAo', this.aoLayout, [
      this.white.createView({label: 'ssao/white/view'}),
      this.sampler,
      this.atlas.view,
      this.atlas.sampler,
    ]);
    this.aoBindGroup = this.whiteBg;
  }

  async init(frameLayout: GPUBindGroupLayout) {
    [this.pipeline, this.blurPipeline] = await Promise.all([
      fullscreenPipeline(
        this.device,
        'ssao',
        ssaoWgsl,
        [frameLayout, this.inLayout],
        [{format: 'r8unorm'}],
      ),
      fullscreenPipeline(
        this.device,
        'ssao/blur',
        blurWgsl,
        [frameLayout, this.blurLayout],
        [{format: 'r8unorm'}],
      ),
    ]);
  }

  private rebuild(t: Targets) {
    this.tex?.destroy();
    this.raw?.destroy();
    this.raw = createTexture(this.device, {
      label: 'ssao/half/raw',
      size: [Math.max(1, t.width >> 1), Math.max(1, t.height >> 1)],
      format: 'r8unorm',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.tex = createTexture(this.device, {
      label: 'ssao/half',
      size: [Math.max(1, t.width >> 1), Math.max(1, t.height >> 1)],
      format: 'r8unorm',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.inBg = bindGroup(this.device, 'ssao/in', this.inLayout, [
      t.views.depth,
    ]);
    this.blurBg = bindGroup(this.device, 'ssao/blur', this.blurLayout, [
      this.raw.createView({label: 'ssao/half/raw/view'}),
      t.views.depth,
    ]);
    this.aoBindGroup = bindGroup(this.device, 'ssao/ao', this.aoLayout, [
      this.tex.createView({label: 'ssao/half/view'}),
      this.sampler,
      this.atlas.view,
      this.atlas.sampler,
    ]);
    this.version = t.version;
  }

  /** Call after the depth prepass. */
  run(encoder: GPUCommandEncoder, t: Targets, frameBg: GPUBindGroup) {
    if (!this.enabled) {
      this.aoBindGroup = this.whiteBg;
      this.version = -1;
      return;
    }
    if (this.version !== t.version) this.rebuild(t);
    runFullscreen(
      encoder,
      'ssao',
      this.raw!.createView({label: 'ssao/half/raw/rt'}),
      this.pipeline,
      [frameBg, this.inBg],
    );
    runFullscreen(
      encoder,
      'ssao/blur',
      this.tex!.createView({label: 'ssao/half/rt'}),
      this.blurPipeline,
      [frameBg, this.blurBg],
    );
  }
}
