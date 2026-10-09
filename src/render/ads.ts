// Giant animated ads and holograms.
//
// Ad scenes are raymarched into a 2048x2048 atlas (4x8 tiles of 512x256).
// Each frame the tiles on the closest screens are re-rendered and a couple
// of others round-robin, then the atlas gets a mip chain so distant screens
// don't alias. Screens sample the atlas; a compute pass turns each screen's
// average color into an area-light proxy in the dynamic light range.
import {tw} from '../gpu/timer';
import {
  bindGroup,
  createBuffer,
  createBufferWithData,
  createComputePipeline,
  createRenderPipeline,
  createSampler,
  createShaderModule,
  createTexture,
} from '../gpu/gpu';
import {bgl, pipelineLayout} from '../gpu/layout';
import {AD_TILES, type AdTile, type Hologram, type Screen} from '../city/ads';
import {distance, type Vec3} from '../math/vec';
import {fullscreenPipeline} from './fullscreen';
import {
  DEPTH_FORMAT,
  GEOMETRY_TARGETS,
  HDR_FORMAT,
  type Targets,
} from './targets';
import adScenesWgsl from '../shaders/ad_scenes.wgsl';
import screensWgsl from '../shaders/screens.wgsl';
import hologramWgsl from '../shaders/hologram.wgsl';

const ATLAS = 2048;
const TILE_W = 512;
const TILE_H = 256;
const TILE_STRIDE = 256;

const MIP_WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> V {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: V; o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0); o.uv = vec2f(p.x, 1.0 - p.y); return o;
}
@fragment fn fs(i: V) -> @location(0) vec4f { return textureSampleLevel(src, samp, i.uv, 0.0); }
`;

export class AdSystem {
  readonly atlas: GPUTexture;
  private mipCount: number;
  private tileUniforms: GPUBuffer;
  private scenePipe!: GPURenderPipeline;
  private sceneBg!: GPUBindGroup;
  private mipPipe!: GPURenderPipeline;
  private mipBgs: GPUBindGroup[] = [];
  private mipViews: GPUTextureView[] = [];
  private screenBuf: GPUBuffer;
  private screenPipe!: GPURenderPipeline;
  private screenBg!: GPUBindGroup;
  private lightPipe!: GPUComputePipeline;
  private lightBg!: GPUBindGroup;
  private holoBuf: GPUBuffer;
  private holoPipe!: GPURenderPipeline;
  private holoLayout!: GPUBindGroupLayout;
  private holoBg: GPUBindGroup | null = null;
  private holoVersion = -1;
  private rr = 0;
  private first = true;
  private sampler: GPUSampler;

  constructor(
    private readonly device: GPUDevice,
    private readonly tiles: AdTile[],
    private readonly screens: Screen[],
    private readonly holos: Hologram[],
    /** First dynamic light slot for screen lights, and how many. */
    private readonly lightSlot: number,
    private readonly lightSlots: number,
  ) {
    const d = device;
    this.mipCount = Math.log2(ATLAS) + 1;
    this.atlas = createTexture(d, {
      label: 'ads/atlas',
      size: [ATLAS, ATLAS],
      format: HDR_FORMAT,
      mipLevelCount: this.mipCount,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.tileUniforms = createBuffer(d, {
      label: 'ads/tileUniforms',
      size: AD_TILES * TILE_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const sd = new Float32Array(Math.max(1, screens.length) * 12);
    const su = new Uint32Array(sd.buffer);
    screens.forEach((s, i) => {
      sd.set(s.pos, i * 12);
      su[i * 12 + 3] = s.tile;
      sd.set(s.right, i * 12 + 4);
      sd[i * 12 + 7] = s.width;
      sd.set(s.normal, i * 12 + 8);
      sd[i * 12 + 11] = s.height;
    });
    this.screenBuf = createBufferWithData(
      d,
      'ads/screens',
      sd,
      GPUBufferUsage.STORAGE,
    );
    const hd = new Float32Array(Math.max(1, holos.length) * 12);
    const hu = new Uint32Array(hd.buffer);
    holos.forEach((h, i) => {
      hd.set(h.pos, i * 12);
      hd[i * 12 + 3] = h.scale;
      hd.set(h.color, i * 12 + 4);
      hu[i * 12 + 7] = h.kind;
      hd.set(h.color2, i * 12 + 8);
      hd[i * 12 + 11] = h.rot;
    });
    this.holoBuf = createBufferWithData(
      d,
      'ads/holograms',
      hd,
      GPUBufferUsage.STORAGE,
    );
    this.sampler = createSampler(d, {
      label: 'ads/sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 8,
    });
  }

  async init(
    sceneLayout: GPUBindGroupLayout,
    glyphAtlas: GPUTexture,
    lightBuffer: GPUBuffer,
  ) {
    const d = this.device;
    const glyphView = glyphAtlas.createView({label: 'ads/glyphAtlas/view'});
    // Scene tiles.
    const tl = bgl(d, 'ads/scene/layout', [
      ['f', 'uniform-dyn'],
      ['f', 'tex-float'],
      ['f', 'sampler'],
    ]);
    this.sceneBg = d.createBindGroup({
      label: 'ads/scene',
      layout: tl,
      entries: [
        {binding: 0, resource: {buffer: this.tileUniforms, size: 64}},
        {binding: 1, resource: glyphView},
        {binding: 2, resource: this.sampler},
      ],
    });
    // Mips.
    const ml = bgl(d, 'ads/mip/layout', [
      ['f', 'tex-float'],
      ['f', 'sampler'],
    ]);
    const linear = createSampler(d, {
      label: 'ads/mipSampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.mipViews = Array.from({length: this.mipCount}, (_, m) =>
      this.atlas.createView({
        label: `ads/atlas/mip${m}`,
        baseMipLevel: m,
        mipLevelCount: 1,
      }),
    );
    this.mipBgs = this.mipViews
      .slice(0, -1)
      .map((v, m) => bindGroup(d, `ads/mip${m}`, ml, [v, linear]));
    // Screens.
    const sl = bgl(d, 'ads/screens/layout', [
      ['vf', 'storage-ro'],
      ['f', 'tex-float'],
      ['f', 'sampler'],
    ]);
    const atlasView = this.atlas.createView({label: 'ads/atlas/view'});
    this.screenBg = bindGroup(d, 'ads/screens', sl, [
      {buffer: this.screenBuf},
      atlasView,
      this.sampler,
    ]);
    // Screen lights.
    const ll = bgl(d, 'ads/lights/layout', [
      ['c', 'storage-rw'],
      ['c', 'storage-ro'],
      ['c', 'tex-float'],
      ['c', 'uniform'],
    ]);
    const info = createBufferWithData(
      d,
      'ads/lights/info',
      new Uint32Array([
        this.lightSlot,
        Math.min(this.screens.length, this.lightSlots),
        0,
        0,
      ]),
      GPUBufferUsage.UNIFORM,
    );
    this.lightBg = bindGroup(d, 'ads/lights', ll, [
      {buffer: lightBuffer},
      {buffer: this.screenBuf},
      atlasView,
      {buffer: info},
    ]);
    // Holograms.
    this.holoLayout = bgl(d, 'ads/holo/layout', [
      ['vf', 'storage-ro'],
      ['f', 'tex-depth'],
    ]);
    const additive: GPUBlendState = {
      color: {srcFactor: 'one', dstFactor: 'one'},
      alpha: {srcFactor: 'zero', dstFactor: 'one'},
    };
    const screenModule = createShaderModule(d, {
      label: 'ads/screens',
      code: screensWgsl,
    });
    const holoModule = createShaderModule(d, {
      label: 'ads/holograms',
      code: hologramWgsl,
    });
    const sceneModule = createShaderModule(d, {
      label: 'ads/scenes',
      code: adScenesWgsl,
    });
    [
      this.scenePipe,
      this.mipPipe,
      this.screenPipe,
      this.lightPipe,
      this.holoPipe,
    ] = (await Promise.all([
      createRenderPipeline(d, {
        label: 'ads/scene',
        layout: pipelineLayout(d, 'ads/scene/pipelineLayout', [tl]),
        vertex: {module: sceneModule, entryPoint: 'vs'},
        fragment: {
          module: sceneModule,
          entryPoint: 'fs',
          targets: [{format: HDR_FORMAT}],
        },
      }),
      fullscreenPipeline(d, 'ads/mip', MIP_WGSL, [ml], [{format: HDR_FORMAT}]),
      createRenderPipeline(d, {
        label: 'ads/screens',
        layout: pipelineLayout(d, 'ads/screens/pipelineLayout', [
          sceneLayout,
          sl,
        ]),
        vertex: {module: screenModule, entryPoint: 'vs'},
        fragment: {
          module: screenModule,
          entryPoint: 'fs',
          targets: GEOMETRY_TARGETS,
        },
        primitive: {topology: 'triangle-list', cullMode: 'none'},
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: true,
          depthCompare: 'greater',
        },
      }),
      createComputePipeline(d, {
        label: 'ads/screenLights',
        layout: pipelineLayout(d, 'ads/lights/pipelineLayout', [ll]),
        compute: {module: screenModule, entryPoint: 'cs_lights'},
      }),
      createRenderPipeline(d, {
        label: 'ads/holograms',
        layout: pipelineLayout(d, 'ads/holo/pipelineLayout', [
          sceneLayout,
          this.holoLayout,
        ]),
        vertex: {module: holoModule, entryPoint: 'vs'},
        fragment: {
          module: holoModule,
          entryPoint: 'fs',
          targets: [{format: HDR_FORMAT, blend: additive}],
        },
        primitive: {topology: 'triangle-list', cullMode: 'front'},
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: false,
          depthCompare: 'always',
        },
      }),
    ])) as [
      GPURenderPipeline,
      GPURenderPipeline,
      GPURenderPipeline,
      GPUComputePipeline,
      GPURenderPipeline,
    ];
  }

  /** Re-renders the most important tiles and rebuilds the atlas mips. */
  update(encoder: GPUCommandEncoder, camPos: Vec3, time: number) {
    const prio = new Array(AD_TILES).fill(Infinity);
    for (const s of this.screens) {
      prio[s.tile] = Math.min(
        prio[s.tile],
        distance(s.pos, camPos) / Math.sqrt(s.width * s.height),
      );
    }
    let todo: number[];
    if (this.first) {
      todo = Array.from({length: AD_TILES}, (_, i) => i);
      this.first = false;
    } else {
      const order = Array.from({length: AD_TILES}, (_, i) => i).sort(
        (a, b) => prio[a] - prio[b],
      );
      todo = order.slice(0, 3);
      for (let k = 0; k < 2; k++) {
        this.rr = (this.rr + 1) % AD_TILES;
        if (!todo.includes(this.rr)) todo.push(this.rr);
      }
    }
    const data = new ArrayBuffer(AD_TILES * TILE_STRIDE);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    this.tiles.forEach((t, i) => {
      const o = (i * TILE_STRIDE) / 4;
      u[o] = t.scene;
      u[o + 1] = i;
      let lo = 0;
      let hi = 0;
      t.glyphs.forEach((g, j) => {
        if (j < 4) lo |= (g & 255) << (j * 8);
        else if (j < 8) hi |= (g & 255) << ((j - 4) * 8);
      });
      u[o + 2] = lo >>> 0;
      u[o + 3] = hi >>> 0;
      f.set(t.colorA, o + 4);
      f[o + 7] = time + i * 3.7;
      f.set(t.colorB, o + 8);
      f[o + 11] = Math.min(8, t.glyphs.length);
    });
    this.device.queue.writeBuffer(this.tileUniforms, 0, data);
    for (const i of todo) {
      const pass = encoder.beginRenderPass({
        label: `ads/tile${i}`,
        colorAttachments: [
          {view: this.mipViews[0], loadOp: 'load', storeOp: 'store'},
        ],
      });
      const x = (i % 4) * TILE_W;
      const y = Math.floor(i / 4) * TILE_H;
      pass.setViewport(x, y, TILE_W, TILE_H, 0, 1);
      pass.setScissorRect(x, y, TILE_W, TILE_H);
      pass.setPipeline(this.scenePipe);
      pass.setBindGroup(0, this.sceneBg, [i * TILE_STRIDE]);
      pass.draw(3);
      pass.end();
    }
    for (let m = 1; m < this.mipCount; m++) {
      const pass = encoder.beginRenderPass({
        label: `ads/mip${m}`,
        colorAttachments: [
          {view: this.mipViews[m], loadOp: 'clear', storeOp: 'store'},
        ],
      });
      pass.setPipeline(this.mipPipe);
      pass.setBindGroup(0, this.mipBgs[m - 1]);
      pass.draw(3);
      pass.end();
    }
  }

  /** Writes screen area lights into the dynamic light range. */
  writeLights(encoder: GPUCommandEncoder) {
    const n = Math.min(this.screens.length, this.lightSlots);
    if (n === 0) return;
    const pass = encoder.beginComputePass({
      label: 'ads/screenLights',
      timestampWrites: tw('ads/screenLights'),
    });
    pass.setPipeline(this.lightPipe);
    pass.setBindGroup(0, this.lightBg);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
  }

  drawScreens(pass: GPURenderPassEncoder, sceneBg: GPUBindGroup) {
    if (!this.screens.length) return;
    pass.setPipeline(this.screenPipe);
    pass.setBindGroup(0, sceneBg);
    pass.setBindGroup(1, this.screenBg);
    pass.draw(6, this.screens.length);
  }

  drawHolograms(
    pass: GPURenderPassEncoder,
    sceneBg: GPUBindGroup,
    targets: Targets,
  ) {
    if (!this.holos.length) return;
    if (!this.holoBg || this.holoVersion !== targets.version) {
      this.holoBg = bindGroup(this.device, 'ads/holo', this.holoLayout, [
        {buffer: this.holoBuf},
        targets.views.depth,
      ]);
      this.holoVersion = targets.version;
    }
    pass.setPipeline(this.holoPipe);
    pass.setBindGroup(0, sceneBg);
    pass.setBindGroup(1, this.holoBg);
    pass.draw(36, this.holos.length);
  }
}

export const SCREEN_LIGHT_SLOT = 16;
export const SCREEN_LIGHT_SLOTS = 1008;
