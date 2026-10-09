// Cable bundles and paper-lantern strings across the inner streets.
import {
  bindGroup,
  createBufferWithData,
  createRenderPipeline,
  createShaderModule,
} from '../gpu/gpu';
import {bgl, pipelineLayout} from '../gpu/layout';
import type {Cable} from '../city/generate';
import {DEPTH_FORMAT, GEOMETRY_TARGETS} from './targets';
import cablesWgsl from '../shaders/cables.wgsl';

const LANTERN_COLORS: [number, number, number][] = [
  [1, 0.1, 0.04],
  [1, 0.5, 0.12],
  [1, 0.46, 0.15], // tungsten (red and tungsten only: ART_BIBLE.md 15.6)
  [1, 0.75, 0.45],
];

export class CableRenderer {
  private cablePipe!: GPURenderPipeline;
  private lanternPipe!: GPURenderPipeline;
  private bg!: GPUBindGroup;
  readonly cableCount: number;
  readonly lanternCount: number;
  private cableData: Float32Array;
  private lanternData: Float32Array;

  constructor(
    private readonly device: GPUDevice,
    cables: Cable[],
  ) {
    this.cableCount = cables.length;
    this.cableData = new Float32Array(Math.max(1, cables.length) * 8);
    const lanterns: number[] = [];
    cables.forEach((c, i) => {
      this.cableData.set([...c.a, c.radius, ...c.b, c.sag], i * 8);
      if (!c.lanterns) return;
      const span = Math.hypot(c.b[0] - c.a[0], c.b[2] - c.a[2]);
      const n = Math.max(2, Math.floor(span / 1.7));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const col =
          c.lanterns === 4
            ? LANTERN_COLORS[k % 4]
            : LANTERN_COLORS[c.lanterns - 1];
        lanterns.push(
          c.a[0] + (c.b[0] - c.a[0]) * t,
          c.a[1] + (c.b[1] - c.a[1]) * t - c.sag * 4 * t * (1 - t) - 0.45,
          c.a[2] + (c.b[2] - c.a[2]) * t,
          0.42,
          ...col,
          0,
        );
      }
    });
    this.lanternCount = lanterns.length / 8;
    this.lanternData = new Float32Array(
      lanterns.length ? lanterns : new Array(8).fill(0),
    );
  }

  async init(sceneLayout: GPUBindGroupLayout) {
    const d = this.device;
    const layout = bgl(d, 'cables/layout', [
      ['v', 'storage-ro'],
      ['v', 'storage-ro'],
    ]);
    this.bg = bindGroup(d, 'cables', layout, [
      {
        buffer: createBufferWithData(
          d,
          'cables/cables',
          this.cableData,
          GPUBufferUsage.STORAGE,
        ),
      },
      {
        buffer: createBufferWithData(
          d,
          'cables/lanterns',
          this.lanternData,
          GPUBufferUsage.STORAGE,
        ),
      },
    ]);
    const module = createShaderModule(d, {label: 'cables', code: cablesWgsl});
    const pl = pipelineLayout(d, 'cables/pipelineLayout', [
      sceneLayout,
      layout,
    ]);
    const mk = (label: string, entryPoint: string) =>
      createRenderPipeline(d, {
        label,
        layout: pl,
        vertex: {module, entryPoint},
        fragment: {module, entryPoint: 'fs', targets: GEOMETRY_TARGETS},
        primitive: {topology: 'triangle-list', cullMode: 'none'},
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: true,
          depthCompare: 'greater',
        },
      });
    [this.cablePipe, this.lanternPipe] = await Promise.all([
      mk('cables/tubes', 'vs_cable'),
      mk('cables/lanterns', 'vs_lantern'),
    ]);
  }

  draw(pass: GPURenderPassEncoder, sceneBg: GPUBindGroup) {
    pass.setBindGroup(0, sceneBg);
    pass.setBindGroup(1, this.bg);
    if (this.cableCount) {
      pass.setPipeline(this.cablePipe);
      pass.draw(12 * 4 * 6, this.cableCount);
    }
    if (this.lanternCount) {
      pass.setPipeline(this.lanternPipe);
      pass.draw(96, this.lanternCount);
    }
  }
}
