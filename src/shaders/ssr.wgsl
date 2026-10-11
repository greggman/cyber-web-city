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
  // Rough surfaces have blurry, low-detail reflections: trace
  // only one pixel per 2x2 block there (fs_apply fills in the others).
  // Smooth surfaces (water, glass, wet streets) trace every pixel.
  // (Distance doesn't qualify: far mirror-smooth water showed blocks.)
  let coarse = rough > 0.15;
  if (coarse && ((u32(i.pos.x) | u32(i.pos.y)) & 1u) != 0u) {
    return vec4f(0.0, 0.0, 0.0, -1.0);
  }
  let v = normalize(world - frame.camPos);
  // No per-frame jitter: random rays meant for TAA to average sparkled
  // badly in motion (each hit/miss flip is a bright speck, a 4x4 blotch on
  // coarse texels, too big for TAA's clamp to remove). Roughness blurs via
  // the coarse trace and upsample instead. The start offset only dithers
  // the march spatially (fixed per pixel), hiding step banding.
  let h = hash31(u32(i.pos.x), u32(i.pos.y), 0u);
  let r = reflect(v, n);
  let fres = 0.04 + 0.96 * pow(1.0 - saturate(dot(-v, n)), 5.0);
  let dist0 = length(world - frame.camPos);
  var t = 0.3 + dist0 * 0.004 * (0.5 + h);
  var prevT = 0.0;
  var hit = false;
  var hitUv = vec2f(0.0);
  for (var k = 0; k < 44; k++) {
    let q = world + r * t;
    let s = project(q);
    if (s.z <= 0.0 || any(s.xy < vec2f(0.0)) || any(s.xy > vec2f(1.0))) { break; }
    let sd = scene_depth_at(s.xy);
    let thick = 1.5 + s.z * 0.04;
    if (s.z > sd) {
      // Behind the depth buffer: refine between prevT and t (long steps at
      // range can jump well past a facade), then accept the crossing if
      // it's close to the surface (not passing behind a foreground object).
      var a = prevT;
      var b = t;
      for (var j = 0; j < 6; j++) {
        let m = (a + b) * 0.5;
        let sm = project(world + r * m);
        if (sm.z > scene_depth_at(sm.xy)) { b = m; } else { a = m; }
      }
      let sb = project(world + r * b);
      if (sb.z - scene_depth_at(sb.xy) < thick) {
        hitUv = sb.xy;
        hit = true;
        break;
      }
    }
    prevT = t;
    t *= 1.16;
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
    // Where the ray escapes into open sky on screen, reflect the actual
    // image there: the sky plus anything additive drawn over it (holograms,
    // searchlight beams, flares), which have no depth to hit.
    let far = project(world + r * 20000.0);
    if (far.z > 0.0 && all(far.xy > vec2f(0.0)) && all(far.xy < vec2f(1.0))) {
      let fd = textureLoad(depthTex, vec2i(far.xy * dims), 0);
      if (fd <= 0.0) {
        let edge = smoothstep(0.0, 0.08, min(min(far.x, 1.0 - far.x), min(far.y, 1.0 - far.y)));
        col = mix(col, textureSampleLevel(litTex, linearSampler, far.xy, 0.0).rgb, edge);
        conf = max(conf, edge * 0.9);
      }
    }
  }
  // Tame very bright sources (holograms, lamps) so one ray landing on one
  // can't make a firefly.
  col = col * (6.0 / max(6.0, max(col.r, max(col.g, col.b))));
  return vec4f(col * conf * fres * strength, conf);
}

// Apply: upsample and add onto the lit image.
@group(1) @binding(0) var ssrTex: texture_2d<f32>;
@group(1) @binding(1) var applySampler: sampler;

// A half-res texel; a skipped one (alpha < 0) takes its 2x2 block's leader.
fn ssr_texel(q: vec2i) -> vec3f {
  let dims = vec2i(textureDimensions(ssrTex));
  let c = clamp(q, vec2i(0), dims - 1);
  let t = textureLoad(ssrTex, c, 0);
  if (t.a >= 0.0) { return t.rgb; }
  return textureLoad(ssrTex, c & vec2i(-2), 0).rgb;
}

@fragment
fn fs_apply(i: FsOut) -> @location(0) vec4f {
  // Manual bilinear upsample (so skipped texels can be substituted).
  let dims = vec2f(textureDimensions(ssrTex));
  let x = i.uv * dims - 0.5;
  let b = vec2i(floor(x));
  let f = fract(x);
  let a0 = mix(ssr_texel(b), ssr_texel(b + vec2i(1, 0)), f.x);
  let a1 = mix(ssr_texel(b + vec2i(0, 1)), ssr_texel(b + vec2i(1, 1)), f.x);
  return vec4f(mix(a0, a1, f.y), 0.0);
}
