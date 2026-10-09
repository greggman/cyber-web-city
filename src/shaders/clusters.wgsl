// Clustered lighting: shared definitions. Constants must match
// src/render/lightClusters.ts.
const TILES_X = 16u;
const TILES_Y = 9u;
const SLICES = 24u;
const MAX_PER_CLUSTER = 64u;
const CLUSTER_Z_NEAR = 2.0;
const CLUSTER_Z_FAR = 4000.0;
const LIGHT_POINT = 0u;
const LIGHT_SPOT = 1u;

struct Light {
  pos: vec3f, radius: f32,
  color: vec3f, kind: u32,
  dir: vec3f, cosCone: f32,
};

fn cluster_slice(viewZ: f32) -> u32 {
  let z = max(viewZ, CLUSTER_Z_NEAR);
  let s = log(z / CLUSTER_Z_NEAR) / log(CLUSTER_Z_FAR / CLUSTER_Z_NEAR) * f32(SLICES);
  return min(u32(max(s, 0.0)), SLICES - 1u);
}

fn slice_near(s: u32) -> f32 {
  return CLUSTER_Z_NEAR * pow(CLUSTER_Z_FAR / CLUSTER_Z_NEAR, f32(s) / f32(SLICES));
}

fn cluster_index(fragXY: vec2f, viewZ: f32, invRes: vec2f) -> u32 {
  let uv = fragXY * invRes;
  let tx = min(u32(uv.x * f32(TILES_X)), TILES_X - 1u);
  let ty = min(u32(uv.y * f32(TILES_Y)), TILES_Y - 1u);
  return (ty * TILES_X + tx) * SLICES + cluster_slice(viewZ);
}

// Smooth windowed inverse-square falloff.
fn light_falloff(d: f32, radius: f32) -> f32 {
  let x = d / radius;
  let w = saturate(1.0 - x * x * x * x);
  return w * w / (1.0 + d * d * 0.02);
}
