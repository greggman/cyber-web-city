// CPU side of the Frame uniform struct (src/shaders/frame.wgsl).
import {createBuffer} from '../gpu/gpu';
import {
  invert,
  multiply,
  perspectiveReversedInfinite,
  mat4,
  type Mat4,
  type Vec3,
} from '../math/vec';

export const FRAME_UNIFORM_SIZE = 752;

export interface CameraState {
  camToWorld: Mat4;
  fovY: number;
  near: number;
}

export interface FrameParams {
  time: number;
  dt: number;
  frameIndex: number;
  width: number;
  height: number;
  jitter: [number, number]; // in pixels
  camera: CameraState;
  fogColor: Vec3;
  fogDensity: number;
  fogHeightFalloff: number;
  rain: number;
  wetness: number;
  exposure: number;
  cameraMode: number;
  carToWorld: Mat4;
  debugView: number;
  quality: number;
  cityGlow: number;
}

export class FrameUniforms {
  readonly buffer: GPUBuffer;
  private readonly data = new ArrayBuffer(FRAME_UNIFORM_SIZE);
  private readonly f32 = new Float32Array(this.data);
  private readonly u32 = new Uint32Array(this.data);
  private prevViewProj: Mat4 | null = null;
  private prevCarToWorld: Mat4 | null = null;

  viewProj = mat4();
  viewProjNoJitter = mat4();
  invViewProj = mat4();
  view = mat4();
  proj = mat4();
  camPos: Vec3 = [0, 0, 0];

  constructor(private readonly device: GPUDevice) {
    this.buffer = createBuffer(device, {
      label: 'frame/uniforms',
      size: FRAME_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  update(p: FrameParams) {
    const aspect = p.width / p.height;
    const proj = perspectiveReversedInfinite(
      p.camera.fovY,
      aspect,
      p.camera.near,
    );
    const projJ = proj.slice() as Mat4;
    // Jitter in clip space: offset of 2*px/width.
    projJ[8] += (2 * p.jitter[0]) / p.width;
    projJ[9] += (2 * p.jitter[1]) / p.height;
    const view = invert(p.camera.camToWorld);
    const vp = multiply(projJ, view);
    const vpNJ = multiply(proj, view);
    const prev = this.prevViewProj ?? vpNJ;
    const prevCar = this.prevCarToWorld ?? p.carToWorld;
    this.viewProj = vp;
    this.viewProjNoJitter = vpNJ;
    this.invViewProj = invert(vp);
    this.view = view;
    this.proj = projJ;
    const c = p.camera.camToWorld;
    this.camPos = [c[12], c[13], c[14]];

    const f = this.f32;
    f.set(vp, 0);
    f.set(vpNJ, 16);
    f.set(prev, 32);
    f.set(this.invViewProj, 48);
    f.set(view, 64);
    f.set(projJ, 80);
    f.set(invert(projJ), 96);
    f.set(c, 112);
    f.set(this.camPos, 128);
    f[131] = p.time;
    f[132] = p.width;
    f[133] = p.height;
    f[134] = 1 / p.width;
    f[135] = 1 / p.height;
    f[136] = p.jitter[0];
    f[137] = p.jitter[1];
    f[138] = p.camera.near;
    this.u32[139] = p.frameIndex;
    f.set(p.fogColor, 140);
    f[143] = p.fogDensity;
    f[144] = p.fogHeightFalloff;
    f[145] = p.rain;
    f[146] = p.wetness;
    f[147] = p.exposure;
    const tanY = Math.tan(p.camera.fovY / 2);
    f[148] = tanY * aspect;
    f[149] = tanY;
    f[150] = p.dt;
    this.u32[151] = p.cameraMode;
    f.set(p.carToWorld, 152);
    f.set(prevCar, 168);
    this.u32[184] = p.debugView;
    this.u32[185] = p.quality;
    f[186] = p.cityGlow;
    this.device.queue.writeBuffer(this.buffer, 0, this.data);
    this.prevViewProj = vpNJ;
    this.prevCarToWorld = p.carToWorld.slice() as Mat4;
  }
}
