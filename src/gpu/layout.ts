// Compact bind group layout descriptions.
//
//   bgl(device, 'city/draw', [
//     ['v', 'uniform'],
//     ['vf', 'storage-ro'],
//     ['f', 'tex-float'],
//   ])
//
// Visibility is any combination of v (vertex), f (fragment), c (compute).

type Kind =
  | 'uniform'
  | 'uniform-dyn'
  | 'storage-ro'
  | 'storage-rw'
  | 'tex-float'
  | 'tex-float-3d'
  | 'tex-float-2d-array'
  | 'tex-float-cube'
  | 'tex-unfilterable'
  | 'tex-depth'
  | 'tex-uint'
  | 'sampler'
  | 'sampler-nonfilter'
  | 'sampler-cmp'
  | `storage-tex:${GPUTextureFormat}`
  | `storage-tex-3d:${GPUTextureFormat}`
  | `storage-tex-rw:${GPUTextureFormat}`;

export type LayoutEntry = [visibility: string, kind: Kind, binding?: number];

function vis(s: string): GPUShaderStageFlags {
  let v = 0;
  if (s.includes('v')) v |= GPUShaderStage.VERTEX;
  if (s.includes('f')) v |= GPUShaderStage.FRAGMENT;
  if (s.includes('c')) v |= GPUShaderStage.COMPUTE;
  return v;
}

export function bgl(
  device: GPUDevice,
  label: string,
  entries: LayoutEntry[],
): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label,
    entries: entries.map(
      ([v, kind, explicit], index): GPUBindGroupLayoutEntry => {
        const e: GPUBindGroupLayoutEntry = {
          binding: explicit ?? index,
          visibility: vis(v),
        };
        if (kind === 'uniform') e.buffer = {type: 'uniform'};
        else if (kind === 'uniform-dyn')
          e.buffer = {type: 'uniform', hasDynamicOffset: true};
        else if (kind === 'storage-ro') e.buffer = {type: 'read-only-storage'};
        else if (kind === 'storage-rw') e.buffer = {type: 'storage'};
        else if (kind === 'tex-float') e.texture = {sampleType: 'float'};
        else if (kind === 'tex-float-3d')
          e.texture = {sampleType: 'float', viewDimension: '3d'};
        else if (kind === 'tex-float-2d-array')
          e.texture = {sampleType: 'float', viewDimension: '2d-array'};
        else if (kind === 'tex-float-cube')
          e.texture = {sampleType: 'float', viewDimension: 'cube'};
        else if (kind === 'tex-unfilterable')
          e.texture = {sampleType: 'unfilterable-float'};
        else if (kind === 'tex-depth') e.texture = {sampleType: 'depth'};
        else if (kind === 'tex-uint') e.texture = {sampleType: 'uint'};
        else if (kind === 'sampler') e.sampler = {type: 'filtering'};
        else if (kind === 'sampler-nonfilter')
          e.sampler = {type: 'non-filtering'};
        else if (kind === 'sampler-cmp') e.sampler = {type: 'comparison'};
        else if (kind.startsWith('storage-tex-3d:'))
          e.storageTexture = {
            access: 'write-only',
            format: kind.slice(15) as GPUTextureFormat,
            viewDimension: '3d',
          };
        else if (kind.startsWith('storage-tex-rw:'))
          e.storageTexture = {
            access: 'read-write',
            format: kind.slice(15) as GPUTextureFormat,
          };
        else if (kind.startsWith('storage-tex:'))
          e.storageTexture = {
            access: 'write-only',
            format: kind.slice(12) as GPUTextureFormat,
          };
        else throw new Error(`unknown layout kind ${kind}`);
        return e;
      },
    ),
  });
}

export function pipelineLayout(
  device: GPUDevice,
  label: string,
  layouts: GPUBindGroupLayout[],
): GPUPipelineLayout {
  return device.createPipelineLayout({label, bindGroupLayouts: layouts});
}
