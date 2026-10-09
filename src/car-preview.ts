// Car design preview: renders a NURBS model on a turntable.
//
// URL params:
//   model=spinner|<traffic variant>   which model to show (see src/car/models.ts)
//   view=three-quarter|front|side|rear|top|rear-three-quarter|interior|pov|low
//   env=studio|city
//   spin=1        rotate the turntable
//   lod=1         tessellation coarseness multiplier
//   nocanopy=1    hide glass (inspect the interior)
import {
  initGpu,
  onGpuError,
  createShaderModule,
  createBufferWithData,
  createBuffer,
  createRenderPipeline,
} from './gpu/gpu';
import {bgl, pipelineLayout} from './gpu/layout';
import {
  invert,
  multiply,
  lookAtCamera,
  rotationY,
  type Mat4,
  type Vec3,
} from './math/vec';
import {buildModelMesh, MODEL_VERTEX_STRIDE} from './nurbs/model';
import {MODELS} from './car/models';
import previewWgsl from './shaders/car_preview.wgsl';
import agxWgsl from './shaders/agx.wgsl';
import commonWgsl from './shaders/common.wgsl';

const params = new URLSearchParams(location.search);
const loadmsg = document.getElementById('loadmsg')!;
const info = document.getElementById('hud')!;
const errors = document.getElementById('errors')!;

function showError(msg: string) {
  errors.style.display = 'block';
  errors.textContent += msg + '\n';
}

function perspective(
  fovY: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (near * far) / (near - far);
  return m;
}

async function main() {
  onGpuError(showError);
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const gpu = await initGpu(canvas);
  const {device, context} = gpu;
  const modelName = params.get('model') ?? 'spinner';
  const entry = MODELS[modelName];
  if (!entry) throw new Error(`unknown model ${modelName}`);
  const t0 = performance.now();
  const model = entry.build();
  const mesh = buildModelMesh(model, Number(params.get('lod') ?? 1));
  const buildMs = performance.now() - t0;
  const noCanopy = params.get('nocanopy') === '1';

  const U = GPUBufferUsage;
  const vb = createBufferWithData(
    device,
    'preview/vertices',
    mesh.vertices,
    U.VERTEX,
  );
  const ib = createBufferWithData(
    device,
    'preview/opaqueIndices',
    mesh.opaqueIndices,
    U.INDEX,
  );
  const gb = createBufferWithData(
    device,
    'preview/glassIndices',
    mesh.glassIndices.length ? mesh.glassIndices : new Uint32Array(3),
    U.INDEX,
  );
  const mb = createBufferWithData(
    device,
    'preview/materials',
    mesh.materials,
    U.STORAGE,
  );
  const ub = createBuffer(device, {
    label: 'preview/uniforms',
    size: 160,
    usage: U.UNIFORM | U.COPY_DST,
  });
  const ivb = createBuffer(device, {
    label: 'preview/invViewProj',
    size: 64,
    usage: U.UNIFORM | U.COPY_DST,
  });

  const layout = bgl(device, 'preview/layout', [
    ['vf', 'uniform'],
    ['f', 'storage-ro'],
    ['f', 'uniform'],
  ]);
  const bg = device.createBindGroup({
    label: 'preview',
    layout,
    entries: [
      {binding: 0, resource: {buffer: ub}},
      {binding: 1, resource: {buffer: mb}},
      {binding: 2, resource: {buffer: ivb}},
    ],
  });
  const code = previewWgsl;
  const module = createShaderModule(device, {label: 'preview', code});
  const pl = pipelineLayout(device, 'preview/pipelineLayout', [layout]);
  const sampleCount = 4;
  const vertex: GPUVertexState = {
    module,
    entryPoint: 'vs',
    buffers: [
      {
        arrayStride: MODEL_VERTEX_STRIDE,
        attributes: [
          {shaderLocation: 0, offset: 0, format: 'float32x3'},
          {shaderLocation: 1, offset: 12, format: 'float32x3'},
          {shaderLocation: 2, offset: 24, format: 'float32x2'},
          {shaderLocation: 3, offset: 32, format: 'uint32'},
        ],
      },
    ],
  };
  const hdr: GPUTextureFormat = 'rgba16float';
  const opaque = await createRenderPipeline(device, {
    label: 'preview/opaque',
    layout: pl,
    vertex,
    fragment: {module, entryPoint: 'fs_opaque', targets: [{format: hdr}]},
    primitive: {topology: 'triangle-list', cullMode: 'none'},
    depthStencil: {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less',
    },
    multisample: {count: sampleCount},
  });
  const blend: GPUBlendState = {
    color: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha'},
    alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha'},
  };
  const glassFor = (cullMode: GPUCullMode) =>
    createRenderPipeline(device, {
      label: `preview/glass-${cullMode}`,
      layout: pl,
      vertex,
      fragment: {
        module,
        entryPoint: 'fs_glass',
        targets: [{format: hdr, blend}],
      },
      primitive: {topology: 'triangle-list', cullMode},
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: false,
        depthCompare: 'less',
      },
      multisample: {count: sampleCount},
    });
  const glassBack = await glassFor('front');
  const glassFront = await glassFor('back');
  const bgPipe = await createRenderPipeline(device, {
    label: 'preview/background',
    layout: pl,
    vertex: {module, entryPoint: 'vs_bg'},
    fragment: {module, entryPoint: 'fs_bg', targets: [{format: hdr}]},
    primitive: {topology: 'triangle-list'},
    depthStencil: {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'always',
    },
    multisample: {count: sampleCount},
  });
  const tmLayout = bgl(device, 'preview/tonemap/layout', [['f', 'tex-float']]);
  const tmModule = createShaderModule(device, {
    label: 'preview/tonemap',
    code: `${commonWgsl}\n${agxWgsl}
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> FsOut { return fullscreen_vertex(vi); }
@fragment fn fs(i: FsOut) -> @location(0) vec4f {
  return vec4f(tonemap_agx(textureLoad(src, vec2i(i.pos.xy), 0).rgb), 1.0);
}`,
  });
  const tonemap = await createRenderPipeline(device, {
    label: 'preview/tonemap',
    layout: pipelineLayout(device, 'preview/tonemap/pipelineLayout', [
      tmLayout,
    ]),
    vertex: {module: tmModule, entryPoint: 'vs'},
    fragment: {
      module: tmModule,
      entryPoint: 'fs',
      targets: [{format: gpu.presentationFormat}],
    },
  });

  let msaa: GPUTexture | null = null;
  let depth: GPUTexture | null = null;
  let resolved: GPUTexture | null = null;
  let tmBg: GPUBindGroup | null = null;

  const bmin = mesh.boundsMin;
  const bmax = mesh.boundsMax;
  const center: Vec3 = [
    (bmin[0] + bmax[0]) / 2,
    (bmin[1] + bmax[1]) / 2,
    (bmin[2] + bmax[2]) / 2,
  ];
  const extent = Math.max(
    bmax[0] - bmin[0],
    bmax[1] - bmin[1],
    bmax[2] - bmin[2],
  );
  const view = params.get('view') ?? 'three-quarter';
  const envName = params.get('env') ?? 'studio';
  const spin = params.get('spin') === '1';
  const d = extent * 1.15;
  const eye = entry.driverEye;
  const cams: Record<string, [Vec3, Vec3, number]> = {
    'three-quarter': [
      [center[0] - d * 0.75, center[1] + d * 0.3, center[2] - d * 0.85],
      center,
      40,
    ],
    'rear-three-quarter': [
      [center[0] + d * 0.8, center[1] + d * 0.35, center[2] + d * 0.8],
      center,
      40,
    ],
    front: [[center[0], center[1] + d * 0.1, center[2] - d * 1.4], center, 35],
    rear: [[center[0], center[1] + d * 0.15, center[2] + d * 1.4], center, 35],
    side: [[center[0] - d * 1.5, center[1], center[2]], center, 35],
    top: [[center[0], center[1] + d * 1.6, center[2] + 0.001], center, 35],
    low: [
      [center[0] - d * 0.6, bmin[1] + 0.3, center[2] - d * 0.9],
      [center[0], center[1] + 0.2, center[2]],
      45,
    ],
    interior: [
      [eye[0] + 0.9, eye[1] + 1.1, eye[2] + 1.2],
      [eye[0] - 0.2, eye[1] - 0.4, eye[2] - 0.6],
      55,
    ],
    pov: [eye, [eye[0], eye[1] - 0.15, eye[2] - 3], 75],
  };
  const [camEye, camTarget, fovDeg] = cams[view] ?? cams['three-quarter'];
  const time0 = performance.now();
  info.textContent =
    `${model.name}: ${mesh.triangleCount} tris, ${model.parts.length} parts, build ${buildMs.toFixed(0)} ms\n` +
    `bounds ${bmin.map(v => v.toFixed(2))} .. ${bmax.map(v => v.toFixed(2))}`;
  (window as unknown as {__stats: unknown}).__stats = {
    triangles: mesh.triangleCount,
    parts: mesh.partStats,
    boundsMin: bmin,
    boundsMax: bmax,
  };

  function frame() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h || !msaa) {
      canvas.width = w;
      canvas.height = h;
      msaa?.destroy();
      depth?.destroy();
      resolved?.destroy();
      msaa = device.createTexture({
        label: 'preview/msaa',
        size: [w, h],
        format: hdr,
        sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      depth = device.createTexture({
        label: 'preview/depth',
        size: [w, h],
        format: 'depth24plus',
        sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      resolved = device.createTexture({
        label: 'preview/resolved',
        size: [w, h],
        format: hdr,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      tmBg = device.createBindGroup({
        label: 'preview/tonemap',
        layout: tmLayout,
        entries: [
          {
            binding: 0,
            resource: resolved.createView({label: 'preview/resolved/view'}),
          },
        ],
      });
    }
    const t = (performance.now() - time0) / 1000;
    const camToWorld = lookAtCamera(camEye, camTarget);
    const proj = perspective((fovDeg * Math.PI) / 180, w / h, 0.02, 200);
    const vp = multiply(proj, invert(camToWorld));
    const modelM = spin ? rotationY(t * 0.4) : rotationY(0);
    const u = new Float32Array(40);
    u.set(vp, 0);
    u.set(modelM, 16);
    u.set(camEye, 32);
    u[35] = t;
    new Uint32Array(u.buffer)[36] = envName === 'city' ? 1 : 0;
    device.queue.writeBuffer(ub, 0, u);
    device.queue.writeBuffer(ivb, 0, invert(vp));
    const enc = device.createCommandEncoder({label: 'preview/frame'});
    const pass = enc.beginRenderPass({
      label: 'preview/main',
      colorAttachments: [
        {
          view: msaa.createView({label: 'preview/msaa/view'}),
          resolveTarget: resolved!.createView({label: 'preview/resolved/rt'}),
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: [0, 0, 0, 1],
        },
      ],
      depthStencilAttachment: {
        view: depth!.createView({label: 'preview/depth/view'}),
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
        depthClearValue: 1,
      },
    });
    pass.setBindGroup(0, bg);
    pass.setPipeline(bgPipe);
    pass.draw(3);
    pass.setVertexBuffer(0, vb);
    pass.setPipeline(opaque);
    pass.setIndexBuffer(ib, 'uint32');
    pass.drawIndexed(mesh.opaqueIndices.length);
    if (mesh.glassIndices.length && !noCanopy) {
      pass.setIndexBuffer(gb, 'uint32');
      pass.setPipeline(glassBack);
      pass.drawIndexed(mesh.glassIndices.length);
      pass.setPipeline(glassFront);
      pass.drawIndexed(mesh.glassIndices.length);
    }
    pass.end();
    const tm = enc.beginRenderPass({
      label: 'preview/tonemap',
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView({label: 'swapchain'}),
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    tm.setPipeline(tonemap);
    tm.setBindGroup(0, tmBg!);
    tm.draw(3);
    tm.end();
    device.queue.submit([enc.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  loadmsg.textContent = 'Ready';
  loadmsg.classList.add('done');
  (window as unknown as {__ready: boolean}).__ready = true;
}

main().catch(e => {
  console.error(e);
  loadmsg.textContent = `Failed: ${e.message ?? e}`;
  showError(String(e.stack ?? e));
});
