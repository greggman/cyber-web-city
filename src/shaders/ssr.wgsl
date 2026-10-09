// Screen-space reflections (half resolution): march the reflected ray in
// world space, project each step, compare against the depth buffer, refine
// with a binary search, and fetch the lit color at the hit.
#include "frame.wgsl"
#include "common.wgsl"
#include "sky.wgsl"

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var depthTex: texture_depth_2d;
@group(1) @binding(1) var normalTex: texture_2d<f32>;
@group(1) @binding(2) var litTex: texture_2d<f32>;
@group(1) @binding(3) var linearSampler: sampler;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> FsOut { return fullscreen_vertex(vi); }

fn project(p: vec3f) -> vec3f {
  let c = frame.viewProj * vec4f(p, 1.0);
  let n = c.xyz / c.w;
  return vec3f(n.x * 0.5 + 0.5, 0.5 - n.y * 0.5, c.w);
}

fn scene_depth_at(uv: vec2f) -> f32 {
  let dims = vec2f(textureDimensions(depthTex));
  let d = textureLoad(depthTex, vec2i(clamp(uv * dims, vec2f(0.0), dims - 1.0)), 0);
  return linear_depth(d, frame.near);
}

@fragment
fn fs(i: FsOut) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(depthTex));
  let uv = i.uv;
  let p = vec2i(uv * dims);
  let d = textureLoad(depthTex, p, 0);
  if (d <= 0.0) { return vec4f(0.0); }
  let nr = textureLoad(normalTex, p, 0);
  let rough = nr.z;
  let refl = nr.w;
  let strength = refl * (1.0 - rough);
  if (strength < 0.08) { return vec4f(0.0); }
  let n = decode_normal(nr.xy);
  let world = world_from_depth(uv, d, frame.invViewProj);
  let v = normalize(world - frame.camPos);
  // Roughness jitters the ray a little (filtered by TAA).
  let h = hash31(u32(i.pos.x), u32(i.pos.y), frame.frameIndex);
  let h2 = hash31(u32(i.pos.y), u32(i.pos.x), frame.frameIndex + 17u);
  var r = reflect(v, n);
  r = normalize(r + (vec3f(h, h2, fract(h + h2)) - 0.5) * rough * 0.35);
  let fres = 0.04 + 0.96 * pow(1.0 - saturate(dot(-v, n)), 5.0);
  let dist0 = length(world - frame.camPos);
  var t = 0.3 + dist0 * 0.004 * (0.5 + h);
  var prevT = 0.0;
  var hit = false;
  var hitUv = vec2f(0.0);
  for (var k = 0; k < 40; k++) {
    let q = world + r * t;
    let s = project(q);
    if (s.z <= 0.0 || any(s.xy < vec2f(0.0)) || any(s.xy > vec2f(1.0))) { break; }
    let sd = scene_depth_at(s.xy);
    let thick = 1.5 + s.z * 0.04;
    if (s.z > sd && s.z - sd < thick) {
      // Binary refine between prevT and t.
      var a = prevT;
      var b = t;
      for (var j = 0; j < 5; j++) {
        let m = (a + b) * 0.5;
        let sm = project(world + r * m);
        if (sm.z > scene_depth_at(sm.xy)) { b = m; } else { a = m; }
      }
      hitUv = project(world + r * b).xy;
      hit = true;
      break;
    }
    prevT = t;
    t *= 1.18;
  }
  var col = vec3f(0.0);
  var conf = 0.0;
  if (hit) {
    col = textureSampleLevel(litTex, linearSampler, hitUv, 0.0).rgb;
    let edge = smoothstep(0.0, 0.08, min(min(hitUv.x, 1.0 - hitUv.x), min(hitUv.y, 1.0 - hitUv.y)));
    conf = edge;
  }
  // Miss: fall back to the sky for upward rays.
  if (!hit && r.y > 0.0) {
    col = sky_color(r, frame.time) * 0.6;
    conf = smoothstep(0.0, 0.2, r.y) * 0.6;
  }
  col = min(col, vec3f(40.0));
  return vec4f(col * conf * fres * strength, conf);
}

// Apply: upsample and add onto the lit image.
@group(1) @binding(0) var ssrTex: texture_2d<f32>;
@group(1) @binding(1) var applySampler: sampler;

@fragment
fn fs_apply(i: FsOut) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(ssrTex, applySampler, i.uv, 0.0).rgb, 0.0);
}
