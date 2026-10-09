// Draws neon signs as instanced procedural boxes.
import {
  bindGroup,
  createBufferWithData,
  createRenderPipeline,
  createSampler,
  createShaderModule,
} from '../gpu/gpu';
import {bgl, pipelineLayout} from '../gpu/layout';
import {packSigns, type Sign} from '../city/signs';
import {createGlyphAtlas} from './glyphs';
import {DEPTH_FORMAT, GEOMETRY_TARGETS} from './targets';
import signsWgsl from '../shaders/signs.wgsl';

export class SignRenderer {
  private pipeline!: GPURenderPipeline;
  private bg!: GPUBindGroup;
  private count = 0;

  constructor(private readonly device: GPUDevice) {}

  async init(signs: Sign[], sceneLayout: GPUBindGroupLayout) {
    const d = this.device;
    this.count = signs.length;
    const buffer = createBufferWithData(
      d,
      'signs/instances',
      new Uint8Array(packSigns(signs)),
      GPUBufferUsage.STORAGE,
    );
    const atlas = createGlyphAtlas(d);
    const sampler = createSampler(d, {
      label: 'signs/sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 8,
    });
    const layout = bgl(d, 'signs/layout', [
      ['vf', 'storage-ro'],
      ['f', 'tex-float'],
      ['f', 'sampler'],
    ]);
    this.bg = bindGroup(d, 'signs', layout, [
      {buffer},
      atlas.createView({label: 'signs/glyphAtlas/view'}),
      sampler,
    ]);
    const module = createShaderModule(d, {label: 'signs', code: signsWgsl});
    this.pipeline = await createRenderPipeline(d, {
      label: 'signs',
      layout: pipelineLayout(d, 'signs/pipelineLayout', [sceneLayout, layout]),
      vertex: {module, entryPoint: 'vs'},
      fragment: {module, entryPoint: 'fs', targets: GEOMETRY_TARGETS},
      primitive: {topology: 'triangle-list', cullMode: 'back'},
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: 'greater',
      },
    });
  }

  draw(pass: GPURenderPassEncoder, sceneBindGroup: GPUBindGroup) {
    if (this.count === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, sceneBindGroup);
    pass.setBindGroup(1, this.bg);
    pass.draw(36, this.count);
  }
}
