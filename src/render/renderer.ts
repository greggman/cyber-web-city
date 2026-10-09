// Frame orchestration: runs every pass in order each frame.
import {bindGroup, type Gpu} from '../gpu/gpu';
import {bgl} from '../gpu/layout';
import type {Camera} from '../camera/camera';
import type {SegmentList} from '../city/segments';
import {mat4, type Mat4, type Vec3} from '../math/vec';
import {FrameUniforms} from './frame';
import {Targets, HDR_FORMAT} from './targets';
import {CityRenderer} from './cityRenderer';
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
}

export class Renderer {
  readonly frame: FrameUniforms;
  readonly targets: Targets;
  readonly city: CityRenderer;
  readonly frameLayout: GPUBindGroupLayout;
  private frameBindGroup!: GPUBindGroup;
  private compositePipeline!: GPURenderPipeline;
  private compositeLayout!: GPUBindGroupLayout;
  private compositeBindGroup!: GPUBindGroup;
  private tonemapPipeline!: GPURenderPipeline;
  private tonemapLayout!: GPUBindGroupLayout;
  private tonemapBindGroup!: GPUBindGroup;
  private targetsVersion = -1;
  private frameIndex = 0;
  carToWorld: Mat4 = mat4();
  cameraMode = 0;

  constructor(private readonly gpu: Gpu) {
    const device = gpu.device;
    this.frame = new FrameUniforms(device);
    this.targets = new Targets(device);
    this.city = new CityRenderer(device);
    this.frameLayout = bgl(device, 'frame/layout', [['vfc', 'uniform']]);
  }

  async init(segments: SegmentList) {
    const device = this.gpu.device;
    this.frameBindGroup = bindGroup(device, 'frame', this.frameLayout, [
      {buffer: this.frame.buffer},
    ]);
    this.compositeLayout = bgl(device, 'composite/layout', [
      ['f', 'tex-float'],
      ['f', 'tex-depth'],
    ]);
    this.tonemapLayout = bgl(device, 'tonemap/layout', [['f', 'tex-float']]);
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
      this.city.init(segments, this.frame.buffer, this.frameLayout),
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
    this.tonemapBindGroup = bindGroup(device, 'tonemap', this.tonemapLayout, [
      v.lit,
    ]);
    this.targetsVersion = this.targets.version;
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
      jitter: [0, 0],
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
    opaque.end();

    runFullscreen(encoder, 'composite', v.lit, this.compositePipeline, [
      this.frameBindGroup,
      this.compositeBindGroup,
    ]);
    const swap = context.getCurrentTexture().createView({label: 'swapchain'});
    runFullscreen(encoder, 'tonemap', swap, this.tonemapPipeline, [
      this.frameBindGroup,
      this.tonemapBindGroup,
    ]);
    device.queue.submit([encoder.finish()]);
    this.frameIndex++;
  }
}
