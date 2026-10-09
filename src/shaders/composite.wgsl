// Composite: sky where nothing was drawn, plus height fog over geometry.
#include "frame.wgsl"
#include "common.wgsl"
#include "sky.wgsl"

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var colorTex: texture_2d<f32>;
@group(1) @binding(1) var depthTex: texture_depth_2d;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> FsOut { return fullscreen_vertex(vi); }

@fragment
fn fs(i: FsOut) -> @location(0) vec4f {
  let p = vec2i(i.pos.xy);
  let depth = textureLoad(depthTex, p, 0);
  let world = world_from_depth(i.uv, max(depth, 1e-7), frame.invViewProj);
  let dir = normalize(world - frame.camPos);
  if (depth <= 0.0) {
    return vec4f(sky_color(dir, frame.time), 1.0);
  }
  let c = textureLoad(colorTex, p, 0).rgb;
  let fog = fog_amount(frame.camPos, world);
  return vec4f(mix(c, fog_color(dir, world.y), fog), 1.0);
}
