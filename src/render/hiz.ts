// Builds a Hi-Z depth pyramid after the depth prepass; the city cull uses
// it (with the previous frame's view-projection) for occlusion culling.
import {tw} from '../gpu/timer';
import {
  createComputePipeline,
  createShaderModule,
  createTexture,
} from '../gpu/gpu';
import type {Targets} from './targets';
import hizWgsl from '../shaders/hiz.wgsl';

export class HiZ {
  private first!: GPUComputePipeline;
  private down!: GPUComputePipeline;
  private tex: GPUTexture | null = null;
  private bgs: GPUBindGroup[] = [];
  private sizes: [number, number][] = [];
  private version = -1;
  view!: GPUTextureView;
  mips = 0;
  width = 0;
  height = 0;

  constructor(private readonly device: GPUDevice) {}

  async init() {
    const module = createShaderModule(this.device, {
      label: 'hiz',
      code: hizWgsl,
    });
    [this.first, this.down] = await Promise.all([
      createComputePipeline(this.device, {
        label: 'hiz/first',
        layout: 'auto',
        compute: {module, entryPoint: 'cs_first'},
      }),
      createComputePipeline(this.device, {
        label: 'hiz/down',
        layout: 'auto',
        compute: {module, entryPoint: 'cs_down'},
      }),
    ]);
  }

  /** Returns true when the pyramid was recreated (consumers must rebind). */
  private rebuild(t: Targets): boolean {
    if (this.version === t.version) return false;
    this.tex?.destroy();
    const w = Math.max(1, t.width >> 1);
    const h = Math.max(1, t.height >> 1);
    this.mips = Math.floor(Math.log2(Math.max(w, h))) + 1;
    this.width = w;
    this.height = h;
    this.tex = createTexture(this.device, {
      label: 'hiz/pyramid',
      size: [w, h],
      format: 'r32float',
      mipLevelCount: this.mips,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.view = this.tex.createView({label: 'hiz/pyramid/view'});
    const mip = (m: number) =>
      this.tex!.createView({
        label: `hiz/mip${m}`,
        baseMipLevel: m,
        mipLevelCount: 1,
      });
    this.sizes = [];
    this.bgs = [];
    for (let m = 0; m < this.mips; m++) {
      this.sizes.push([Math.max(1, w >> m), Math.max(1, h >> m)]);
      if (m === 0) {
        this.bgs.push(
          this.device.createBindGroup({
            label: 'hiz/first',
            layout: this.first.getBindGroupLayout(0),
            entries: [
              {binding: 0, resource: t.views.depth},
              {binding: 1, resource: mip(0)},
            ],
          }),
        );
      } else {
        this.bgs.push(
          this.device.createBindGroup({
            label: `hiz/down${m}`,
            layout: this.down.getBindGroupLayout(0),
            entries: [
              {binding: 2, resource: mip(m - 1)},
              {binding: 3, resource: mip(m)},
            ],
          }),
        );
      }
    }
    this.version = t.version;
    return true;
  }

  build(encoder: GPUCommandEncoder, t: Targets): boolean {
    const changed = this.rebuild(t);
    const pass = encoder.beginComputePass({
      label: 'hiz/build',
      timestampWrites: tw('hiz/build'),
    });
    for (let m = 0; m < this.mips; m++) {
      pass.setPipeline(m === 0 ? this.first : this.down);
      pass.setBindGroup(0, this.bgs[m]);
      const [w, h] = this.sizes[m];
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    }
    pass.end();
    return changed;
  }
}
