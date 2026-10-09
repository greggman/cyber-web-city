// Final output: exposure, filmic tonemap (AgX-style), grade, sRGB encode.
#include "frame.wgsl"
#include "common.wgsl"

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var hdrTex: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> FsOut { return fullscreen_vertex(vi); }

#include "agx.wgsl"

@fragment
fn fs(i: FsOut) -> @location(0) vec4f {
  let p = vec2i(i.pos.xy);
  var c = textureLoad(hdrTex, p, 0).rgb * frame.exposure;
  return vec4f(tonemap_agx(c), 1.0);
}
