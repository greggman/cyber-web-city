// Depth-aware 5x5 blur of the half-resolution AO: removes the per-pixel
// sampling noise (TAA's colour clipping would otherwise keep it) without
// bleeding occlusion across depth edges.
#include "frame.wgsl"
#include "common.wgsl"

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var aoTex: texture_2d<f32>;
@group(1) @binding(1) var depthTex: texture_depth_2d;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> FsOut { return fullscreen_vertex(vi); }

fn lin_at(px: vec2i) -> f32 {
  // Full-res depth at the centre of the half-res texel.
  let dims = vec2i(textureDimensions(depthTex));
  let d = textureLoad(depthTex, clamp(px * 2, vec2i(0), dims - 1), 0);
  return select(1e6, linear_depth(d, frame.near), d > 0.0);
}

@fragment
fn fs(i: FsOut) -> @location(0) vec4f {
  let p = vec2i(i.pos.xy);
  let dims = vec2i(textureDimensions(aoTex));
  let z0 = lin_at(p);
  var sum = 0.0;
  var wsum = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let q = clamp(p + vec2i(x, y), vec2i(0), dims - 1);
      let z = lin_at(q);
      let w = exp(-abs(z - z0) / (0.03 * z0 + 0.05)) * (1.0 - 0.12 * f32(abs(x) + abs(y)));
      sum += textureLoad(aoTex, q, 0).r * w;
      wsum += w;
    }
  }
  return vec4f(sum / max(wsum, 1e-4), 0.0, 0.0, 1.0);
}
