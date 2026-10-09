// Models are lists of NURBS parts with materials. buildModelMesh() turns a
// model into GPU-ready vertex/index data plus a material table.
//
// Coordinate convention for vehicles: meters, +X right, +Y up, nose toward -Z.
// The ground is y = 0 when the vehicle hovers at rest.
import type {Vec3} from '../math/vec';
import type {NurbsSurface} from './nurbs';
import {tessellate, type TessOptions} from './tessellate';

export type MaterialName =
  | 'paint' // clearcoat car paint (uses color)
  | 'chrome'
  | 'metal' // brushed/dark metal
  | 'glass' // clear canopy glass (transparent, gets rain + condensation)
  | 'tinted-glass' // dark transparent glass
  | 'emissive' // lights; uses emissive (HDR color, may exceed 1)
  | 'rubber'
  | 'plastic'
  | 'leather' // interior upholstery
  | 'carbon'
  | 'screen'; // animated display; screenId picks the content

export const enum MaterialKind {
  Opaque = 0,
  Paint = 1,
  Glass = 2,
  Emissive = 3,
  Screen = 4,
}

export interface Material {
  kind: MaterialKind;
  color: Vec3;
  roughness: number;
  metallic: number;
  emissive: Vec3;
  /** For glass: opacity at normal incidence. For screens: screen id. */
  param: number;
}

export interface Part {
  name: string;
  surface: NurbsSurface;
  material: MaterialName;
  /** Base color (linear RGB 0..1). */
  color?: Vec3;
  /** Emission (linear HDR) for 'emissive' or tint for 'screen'. */
  emissive?: Vec3;
  roughness?: number;
  /** Also add a copy mirrored across x = 0. */
  mirror?: boolean;
  /** Render both sides (for thin shells such as fins and the canopy). */
  doubleSided?: boolean;
  /** Screen content id for 'screen' parts (0 = nav map, 1 = gauges, 2 = comms). */
  screenId?: number;
  tessellation?: TessOptions;
}

export interface Model {
  name: string;
  parts: Part[];
}

const PRESETS: Record<
  MaterialName,
  Omit<Material, 'emissive' | 'param'> & {param?: number}
> = {
  paint: {
    kind: MaterialKind.Paint,
    color: [0.25, 0.27, 0.3],
    roughness: 0.35,
    metallic: 0.6,
  },
  chrome: {
    kind: MaterialKind.Opaque,
    color: [0.95, 0.95, 0.97],
    roughness: 0.08,
    metallic: 1,
  },
  metal: {
    kind: MaterialKind.Opaque,
    color: [0.35, 0.36, 0.38],
    roughness: 0.45,
    metallic: 1,
  },
  glass: {
    kind: MaterialKind.Glass,
    color: [0.9, 0.95, 1.0],
    roughness: 0.02,
    metallic: 0,
    param: 0.06,
  },
  'tinted-glass': {
    kind: MaterialKind.Glass,
    color: [0.2, 0.25, 0.3],
    roughness: 0.05,
    metallic: 0,
    param: 0.6,
  },
  emissive: {
    kind: MaterialKind.Emissive,
    color: [0, 0, 0],
    roughness: 0.3,
    metallic: 0,
  },
  rubber: {
    kind: MaterialKind.Opaque,
    color: [0.03, 0.03, 0.03],
    roughness: 0.9,
    metallic: 0,
  },
  plastic: {
    kind: MaterialKind.Opaque,
    color: [0.06, 0.06, 0.07],
    roughness: 0.55,
    metallic: 0,
  },
  leather: {
    kind: MaterialKind.Opaque,
    color: [0.12, 0.06, 0.04],
    roughness: 0.6,
    metallic: 0,
  },
  carbon: {
    kind: MaterialKind.Opaque,
    color: [0.04, 0.04, 0.045],
    roughness: 0.3,
    metallic: 0.2,
  },
  screen: {
    kind: MaterialKind.Screen,
    color: [0, 0, 0],
    roughness: 0.1,
    metallic: 0,
  },
};

export function materialFor(p: Part): Material {
  const pre = PRESETS[p.material];
  return {
    kind: pre.kind,
    color: p.color ?? pre.color,
    roughness: p.roughness ?? pre.roughness,
    metallic: pre.metallic,
    emissive: p.emissive ?? (p.material === 'screen' ? [1, 1, 1] : [0, 0, 0]),
    param: p.material === 'screen' ? (p.screenId ?? 0) : (pre.param ?? 0),
  };
}

/** Vertex: position(3) normal(3) uv(2) material index(1, as u32 bits). */
export const MODEL_VERTEX_FLOATS = 9;
export const MODEL_VERTEX_STRIDE = MODEL_VERTEX_FLOATS * 4;
/** Material table entry: 3 x vec4 = 48 bytes. */
export const MATERIAL_FLOATS = 12;

export interface ModelMesh {
  vertices: Float32Array;
  /** Opaque and emissive triangles. */
  opaqueIndices: Uint32Array;
  /** Glass triangles (drawn in the transparent pass). */
  glassIndices: Uint32Array;
  materials: Float32Array;
  boundsMin: Vec3;
  boundsMax: Vec3;
  triangleCount: number;
  partStats: {name: string; triangles: number}[];
}

export function buildModelMesh(model: Model, lodScale = 1): ModelMesh {
  const verts: number[] = [];
  const opaque: number[] = [];
  const glass: number[] = [];
  const mats: number[] = [];
  const u32 = new Uint32Array(1);
  const f32 = new Float32Array(u32.buffer);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const partStats: {name: string; triangles: number}[] = [];
  model.parts.forEach((part, mi) => {
    const m = materialFor(part);
    mats.push(
      ...m.color,
      m.kind,
      ...m.emissive,
      m.roughness,
      m.metallic,
      m.param,
      0,
      0,
    );
    u32[0] = mi;
    const matBits = f32[0];
    const t = part.tessellation ?? {};
    const opts: TessOptions = {
      ...t,
      maxEdge: (t.maxEdge ?? 0.25) * lodScale,
      maxAngle: (t.maxAngle ?? (7 * Math.PI) / 180) * lodScale,
    };
    const surfaces = [part.surface];
    if (part.mirror) surfaces.push(part.surface.mirrorX());
    let tris = 0;
    for (const s of surfaces) {
      const mesh = tessellate(s, opts);
      const sides = part.doubleSided ? [1, -1] : [1];
      for (const side of sides) {
        const base = verts.length / MODEL_VERTEX_FLOATS;
        for (let i = 0; i < mesh.positions.length / 3; i++) {
          const p = [
            mesh.positions[i * 3],
            mesh.positions[i * 3 + 1],
            mesh.positions[i * 3 + 2],
          ];
          for (let c = 0; c < 3; c++) {
            min[c] = Math.min(min[c], p[c]);
            max[c] = Math.max(max[c], p[c]);
          }
          verts.push(
            ...p,
            mesh.normals[i * 3] * side,
            mesh.normals[i * 3 + 1] * side,
            mesh.normals[i * 3 + 2] * side,
            mesh.uvs[i * 2],
            mesh.uvs[i * 2 + 1],
            matBits,
          );
        }
        const target = m.kind === MaterialKind.Glass ? glass : opaque;
        for (let i = 0; i < mesh.indices.length; i += 3) {
          const a = base + mesh.indices[i];
          const b = base + mesh.indices[i + 1];
          const c = base + mesh.indices[i + 2];
          if (side > 0) target.push(a, b, c);
          else target.push(a, c, b);
        }
        tris += mesh.indices.length / 3;
      }
    }
    partStats.push({name: part.name, triangles: tris});
  });
  return {
    vertices: new Float32Array(verts),
    opaqueIndices: new Uint32Array(opaque),
    glassIndices: new Uint32Array(glass),
    materials: new Float32Array(mats),
    boundsMin: min,
    boundsMax: max,
    triangleCount: (opaque.length + glass.length) / 3,
    partStats,
  };
}
