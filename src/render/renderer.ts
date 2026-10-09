// Frame orchestration: runs every pass in order each frame.
//
//  1. city cull (compute)      GPU-driven culling + LOD into indirect draws
//  2. light cull (compute)     visible lights -> clustered light lists
//  3. depth prepass            city
//  4. opaque                   city (depth-equal) + signs + car
//  5. composite                sky, height fog
//  6. transparent              (glass, holograms, rain: later milestones)
//  7. TAA                      jittered history resolve
//  8. bloom + streaks
//  9. tonemap + grade          to the swap chain
import {bindGroup, type Gpu} from '../gpu/gpu';
import {bgl} from '../gpu/layout';
import type {Camera} from '../camera/camera';
import type {SegmentList} from '../city/segments';
import type {Sign} from '../city/signs';
import {mat4, type Mat4, type Vec3} from '../math/vec';
import {FrameUniforms} from './frame';
import {Targets, HDR_FORMAT} from './targets';
import {CityRenderer} from './cityRenderer';
import {SignRenderer} from './signRenderer';
import {LightClusters, type LightDesc} from './lightClusters';
import {Post, taaJitter} from './post';
import {Ssr} from './ssr';
import {fullscreenPipeline, runFullscreen} from './fullscreen';
import compositeWgsl from '../shaders/composite.wgsl';
import tonemapWgsl from '../shaders/tonemap.wgsl';

export interface RenderSettings {
  fogColor: Vec3;
  fogDensity: number;
  fogHeightFalloff: number;
  rain: number;
  wetness: number;
  exposure: number;
  cityGlow: number;
  debugView: number;
  quality: number;
  taa: boolean;
}

export interface SceneData {
  segments: SegmentList;
  signs: Sign[];
  lights: LightDesc[];
}

/** Dynamic light slots reserved for traffic and the player's car. */
export const DYNAMIC_LIGHTS = 2048;

export class Renderer {
  readonly frame: FrameUniforms;
  readonly targets: Targets;
  readonly city: CityRenderer;
  readonly signs: SignRenderer;
  readonly post: Post;
  readonly ssr: Ssr;
  lights!: LightClusters;
  readonly frameLayout: GPUBindGroupLayout;
  readonly sceneLayout: GPUBindGroupLayout;
  frameBindGroup!: GPUBindGroup;
  sceneBindGroup!: GPUBindGroup;
  private compositePipeline!: GPURenderPipeline;
  private compositeLayout: GPUBindGroupLayout;
  private compositeBindGroup!: GPUBindGroup;
  private tonemapPipeline!: GPURenderPipeline;
  private tonemapLayout: GPUBindGroupLayout;
  private tonemapBindGroup: GPUBindGroup | null = null;
  private tonemapKey = '';
  private targetsVersion = -1;
  private frameIndex = 0;
  carToWorld: Mat4 = mat4();
  cameraMode = 0;
  /** Extra opaque/transparent drawers registered by other systems. */
  opaqueDrawers: ((pass: GPURenderPassEncoder) => void)[] = [];
  transparentDrawers: ((pass: GPURenderPassEncoder) => void)[] = [];
  computeHooks: ((encoder: GPUCommandEncoder) => void)[] = [];
  /** Run after opaque + composite (depth available), before transparents. */
  postOpaqueHooks: ((encoder: GPUCommandEncoder) => void)[] = [];

  constructor(private readonly gpu: Gpu) {
    const device = gpu.device;
    this.frame = new FrameUniforms(device);
    this.targets = new Targets(device);
    this.city = new CityRenderer(device);
    this.signs = new SignRenderer(device);
    this.post = new Post(device);
    this.ssr = new Ssr(device);
    this.frameLayout = bgl(device, 'frame/layout', [['vfc', 'uniform']]);
    this.sceneLayout = bgl(device, 'scene/layout', [
      ['vfc', 'uniform'],
      ['fc', 'storage-ro'],
      ['fc', 'storage-ro'],
      ['fc', 'storage-ro'],
    ]);
    this.compositeLayout = bgl(device, 'composite/layout', [
      ['f', 'tex-float'],
      ['f', 'tex-depth'],
    ]);
    this.tonemapLayout = bgl(device, 'tonemap/layout', [
      ['f', 'tex-float'],
      ['f', 'tex-float'],
      ['f', 'tex-float'],
      ['f', 'sampler'],
    ]);
  }

  get device() {
    return this.gpu.device;
  }

  async init(scene: SceneData) {
    const device = this.gpu.device;
    this.lights = new LightClusters(device, scene.lights, DYNAMIC_LIGHTS);
    this.frameBindGroup = bindGroup(device, 'frame', this.frameLayout, [
      {buffer: this.frame.buffer},
    ]);
    this.sceneBindGroup = bindGroup(device, 'scene', this.sceneLayout, [
      {buffer: this.frame.buffer},
      {buffer: this.lights.lightBuffer},
      {buffer: this.lights.clusterCounts},
      {buffer: this.lights.clusterLights},
    ]);
    const [composite, tonemap] = await Promise.all([
      fullscreenPipeline(
        device,
        'composite',
        compositeWgsl,
        [this.frameLayout, this.compositeLayout],
        [{format: HDR_FORMAT}],
      ),
      fullscreenPipeline(
        device,
        'tonemap',
        tonemapWgsl,
        [this.frameLayout, this.tonemapLayout],
        [{format: this.gpu.presentationFormat}],
      ),
      this.city.init(scene.segments, this.sceneBindGroup, this.sceneLayout),
      this.signs.init(scene.signs, this.sceneLayout),
      this.lights.init(this.frame.buffer),
      this.post.init(this.frameLayout),
      this.ssr.init(this.frameLayout),
    ]);
    this.compositePipeline = composite;
    this.tonemapPipeline = tonemap;
  }

  private rebuildScreenBindGroups() {
    const device = this.gpu.device;
    const v = this.targets.views;
    this.compositeBindGroup = bindGroup(
      device,
      'composite',
      this.compositeLayout,
      [v.color, v.depth],
    );
    this.targetsVersion = this.targets.version;
    this.tonemapKey = '';
  }

  render(camera: Camera, time: number, dt: number, s: RenderSettings) {
    const {device, canvas, context} = this.gpu;
    // Render at CSS resolution; no devicePixelRatio scaling.
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.targets.resize(width, height);
    if (this.targetsVersion !== this.targets.version) {
      this.rebuildScreenBindGroups();
    }
    const prevViewProj = this.frame.viewProjNoJitter;
    this.frame.update({
      time,
      dt,
      frameIndex: this.frameIndex,
      width,
      height,
      jitter: s.taa ? taaJitter(this.frameIndex) : [0, 0],
      camera,
      fogColor: s.fogColor,
      fogDensity: s.fogDensity,
      fogHeightFalloff: s.fogHeightFalloff,
      rain: s.rain,
      wetness: s.wetness,
      exposure: s.exposure,
      cameraMode: this.cameraMode,
      carToWorld: this.carToWorld,
      debugView: s.debugView,
      quality: s.quality,
      cityGlow: s.cityGlow,
    });

    const encoder = device.createCommandEncoder({label: 'frame'});
    this.city.cull(
      encoder,
      this.frame.viewProjNoJitter,
      prevViewProj,
      this.frame.camPos,
      height,
      camera.fovY,
    );
    this.lights.run(encoder);
    for (const hook of this.computeHooks) hook(encoder);

    const v = this.targets.views;
    const depthPass = encoder.beginRenderPass({
      label: 'depthPrepass',
      colorAttachments: [],
      depthStencilAttachment: {
        view: v.depth,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    this.city.drawDepth(depthPass);
    depthPass.end();

    const opaque = encoder.beginRenderPass({
      label: 'opaque',
      colorAttachments: [
        {
          view: v.color,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
        {
          view: v.normal,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 1, 0],
        },
        {
          view: v.velocity,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
      depthStencilAttachment: {
        view: v.depth,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });
    this.city.drawColor(opaque);
    this.signs.draw(opaque, this.sceneBindGroup);
    for (const d of this.opaqueDrawers) d(opaque);
    opaque.end();

    runFullscreen(encoder, 'composite', v.lit, this.compositePipeline, [
      this.frameBindGroup,
      this.compositeBindGroup,
    ]);

    this.ssr.run(encoder, this.targets, this.frameBindGroup);
    for (const hook of this.postOpaqueHooks) hook(encoder);

    if (this.transparentDrawers.length) {
      encoder.copyTextureToTexture(
        {texture: this.targets.lit},
        {texture: this.targets.litCopy},
        [width, height],
      );
      const tp = encoder.beginRenderPass({
        label: 'transparent',
        colorAttachments: [{view: v.lit, loadOp: 'load', storeOp: 'store'}],
        depthStencilAttachment: {view: v.depth, depthReadOnly: true},
      });
      for (const d of this.transparentDrawers) d(tp);
      tp.end();
    }

    this.post.run(encoder, this.targets, this.frameBindGroup);
    const key = `${this.targets.version}:${this.post.resolved.label}:${this.post.streakView.label}`;
    if (key !== this.tonemapKey || !this.tonemapBindGroup) {
      this.tonemapBindGroup = bindGroup(
        device,
        `tonemap/${key}`,
        this.tonemapLayout,
        [
          this.post.resolved,
          this.post.bloomView,
          this.post.streakView,
          this.postSampler(),
        ],
      );
      this.tonemapKey = key;
    }
    const swap = context.getCurrentTexture().createView({label: 'swapchain'});
    runFullscreen(encoder, 'tonemap', swap, this.tonemapPipeline, [
      this.frameBindGroup,
      this.tonemapBindGroup,
    ]);
    device.queue.submit([encoder.finish()]);
    this.frameIndex++;
  }

  private sampler: GPUSampler | null = null;
  private postSampler(): GPUSampler {
    this.sampler ??= this.gpu.device.createSampler({
      label: 'tonemap/sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    return this.sampler;
  }
}
