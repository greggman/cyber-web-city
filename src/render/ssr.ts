// Screen-space reflections at half resolution, added onto the lit image.
import {bindGroup, createSampler, createTexture} from '../gpu/gpu';
import {bgl} from '../gpu/layout';
import {fullscreenPipeline, runFullscreen} from './fullscreen';
import {HDR_FORMAT, type Targets} from './targets';
import ssrWgsl from '../shaders/ssr.wgsl';

export class Ssr {
  private traceLayout: GPUBindGroupLayout;
  private applyLayout: GPUBindGroupLayout;
  private tracePipeline!: GPURenderPipeline;
  private applyPipeline!: GPURenderPipeline;
  private sampler: GPUSampler;
  private tex: GPUTexture | null = null;
  private traceBg!: GPUBindGroup;
  private applyBg!: GPUBindGroup;
  private version = -1;
  enabled = true;

  constructor(private readonly device: GPUDevice) {
    this.traceLayout = bgl(device, 'ssr/trace/layout', [
      ['f', 'tex-depth'],
      ['f', 'tex-float'],
      ['f', 'tex-float'],
      ['f', 'sampler'],
    ]);
    this.applyLayout = bgl(device, 'ssr/apply/layout', [
      ['f', 'tex-float'],
      ['f', 'sampler'],
    ]);
    this.sampler = createSampler(device, {
      label: 'ssr/sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  async init(frameLayout: GPUBindGroupLayout) {
    const additive: GPUBlendState = {
      color: {srcFactor: 'one', dstFactor: 'one'},
      alpha: {srcFactor: 'zero', dstFactor: 'one'},
    };
    [this.tracePipeline, this.applyPipeline] = await Promise.all([
      fullscreenPipeline(
        this.device,
        'ssr/trace',
        ssrWgsl,
        [frameLayout, this.traceLayout],
        [{format: HDR_FORMAT}],
      ),
      fullscreenPipeline(
        this.device,
        'ssr/apply',
        ssrWgsl,
        [frameLayout, this.applyLayout],
        [{format: HDR_FORMAT, blend: additive}],
        'fs_apply',
      ),
    ]);
  }

  private rebuild(t: Targets) {
    this.tex?.destroy();
    this.tex = createTexture(this.device, {
      label: 'ssr/half',
      size: [Math.max(1, t.width >> 1), Math.max(1, t.height >> 1)],
      format: HDR_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const v = t.views;
    // Trace reads the lit copy (the lit image is the apply target).
    this.traceBg = bindGroup(this.device, 'ssr/trace', this.traceLayout, [
      v.depth,
      v.normal,
      v.litCopy,
      this.sampler,
    ]);
    this.applyBg = bindGroup(this.device, 'ssr/apply', this.applyLayout, [
      this.tex.createView({label: 'ssr/half/view'}),
      this.sampler,
    ]);
    this.version = t.version;
  }

  run(encoder: GPUCommandEncoder, t: Targets, frameBg: GPUBindGroup) {
    if (!this.enabled) return;
    if (this.version !== t.version) this.rebuild(t);
    encoder.copyTextureToTexture({texture: t.lit}, {texture: t.litCopy}, [
      t.width,
      t.height,
    ]);
    runFullscreen(
      encoder,
      'ssr/trace',
      this.tex!.createView({label: 'ssr/half/rt'}),
      this.tracePipeline,
      [frameBg, this.traceBg],
    );
    runFullscreen(
      encoder,
      'ssr/apply',
      t.views.lit,
      this.applyPipeline,
      [frameBg, this.applyBg],
      'load',
    );
  }
}
