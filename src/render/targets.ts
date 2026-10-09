// Screen-sized render targets, recreated on resize.
import {createTexture, deferDestroy} from '../gpu/gpu';

export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
export const NORMAL_FORMAT: GPUTextureFormat = 'rgba16float';
export const VELOCITY_FORMAT: GPUTextureFormat = 'rg16float';
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

/** The G-buffer-ish targets written by opaque geometry passes. */
export const GEOMETRY_TARGETS: GPUColorTargetState[] = [
  {format: HDR_FORMAT},
  {format: NORMAL_FORMAT},
  {format: VELOCITY_FORMAT},
];

export class Targets {
  width = 0;
  height = 0;
  /** Bumped whenever textures are recreated so passes rebuild bind groups. */
  version = 0;
  color!: GPUTexture; // opaque HDR output
  normal!: GPUTexture; // oct normal, roughness, reflectivity
  velocity!: GPUTexture;
  depth!: GPUTexture;
  lit!: GPUTexture; // after sky/fog/reflections composite
  litCopy!: GPUTexture; // copy of lit for refraction in the transparent pass
  views!: {
    color: GPUTextureView;
    normal: GPUTextureView;
    velocity: GPUTextureView;
    depth: GPUTextureView;
    lit: GPUTextureView;
    litCopy: GPUTextureView;
  };

  constructor(private readonly device: GPUDevice) {}

  resize(width: number, height: number): boolean {
    if (width === this.width && height === this.height) {
      return false;
    }
    for (const t of [
      this.color,
      this.normal,
      this.velocity,
      this.depth,
      this.lit,
      this.litCopy,
    ]) {
      deferDestroy(t);
    }
    this.width = width;
    this.height = height;
    this.version++;
    const d = this.device;
    const size = [width, height];
    const RT =
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.color = createTexture(d, {
      label: 'targets/color',
      size,
      format: HDR_FORMAT,
      usage: RT | GPUTextureUsage.COPY_SRC,
    });
    this.normal = createTexture(d, {
      label: 'targets/normal',
      size,
      format: NORMAL_FORMAT,
      usage: RT,
    });
    this.velocity = createTexture(d, {
      label: 'targets/velocity',
      size,
      format: VELOCITY_FORMAT,
      usage: RT,
    });
    this.depth = createTexture(d, {
      label: 'targets/depth',
      size,
      format: DEPTH_FORMAT,
      usage: RT,
    });
    this.lit = createTexture(d, {
      label: 'targets/lit',
      size,
      format: HDR_FORMAT,
      usage:
        RT |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    this.litCopy = createTexture(d, {
      label: 'targets/litCopy',
      size,
      format: HDR_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.views = {
      color: this.color.createView({label: 'targets/color/view'}),
      normal: this.normal.createView({label: 'targets/normal/view'}),
      velocity: this.velocity.createView({label: 'targets/velocity/view'}),
      depth: this.depth.createView({label: 'targets/depth/view'}),
      lit: this.lit.createView({label: 'targets/lit/view'}),
      litCopy: this.litCopy.createView({label: 'targets/litCopy/view'}),
    };
    return true;
  }
}
