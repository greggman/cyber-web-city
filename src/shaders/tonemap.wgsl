// Final output: bloom + anamorphic streak composite, exposure, AgX tonemap,
// cinematic grade (teal shadows / warm highlights), chromatic aberration,
// vignette and film grain.
#include "frame.wgsl"
#include "common.wgsl"

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var hdrTex: texture_2d<f32>;
@group(1) @binding(1) var bloomTex: texture_2d<f32>;
@group(1) @binding(2) var streakTex: texture_2d<f32>;
@group(1) @binding(3) var linearSampler: sampler;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> FsOut { return fullscreen_vertex(vi); }

#include "agx.wgsl"

fn grade(c_in: vec3f, uv: vec2f) -> vec3f {
  var c = c_in;
  let l = luminance(c);
  // Split toning (ART_BIBLE.md 15.8): near-neutral steel shadows, warm
  // highlights.
  let shadows = vec3f(0.97, 1.0, 1.03);
  let highs = vec3f(1.04, 1.0, 0.92);
  c *= mix(shadows, highs, smoothstep(0.05, 0.6, l));
  // Saturation: a little overall, and bright cores roll off toward white
  // the way film does.
  let sat = 0.88 * mix(1.0, 0.45, smoothstep(0.75, 1.0, l));
  c = mix(vec3f(luminance(c)), c, sat);
  // Gentle S-curve on luminance.
  let l2 = luminance(c);
  let s = smoothstep(0.0, 1.0, l2);
  c *= mix(1.0, s / max(l2, 1e-4), 0.25);
  // Vignette.
  let d = uv - 0.5;
  c *= 1.0 - dot(d, d) * 0.9;
  return c;
}

@fragment
fn fs(i: FsOut) -> @location(0) vec4f {
  let uv = i.uv;
  // Chromatic aberration: radial offset for R and B.
  let dir = (uv - 0.5);
  let ca = dir * 0.0012 * smoothstep(0.25, 0.7, length(dir));
  let r = textureSampleLevel(hdrTex, linearSampler, uv + ca, 0.0).r;
  let g = textureSampleLevel(hdrTex, linearSampler, uv, 0.0).g;
  let b = textureSampleLevel(hdrTex, linearSampler, uv - ca, 0.0).b;
  var c = vec3f(r, g, b);
  let bloom = textureSampleLevel(bloomTex, linearSampler, uv, 0.0).rgb;
  let streak = textureSampleLevel(streakTex, linearSampler, uv, 0.0).rgb;
  // Streaks take their source's colour (no fixed cyan tint).
  c = mix(c, bloom, 0.12) + streak * vec3f(1.0, 0.95, 0.9) * 0.25;
  c *= frame.exposure;
  var o = tonemap_agx(c);
  // Grade in display space.
  o = grade(o, uv);
  // Film grain.
  let n = hash31(u32(i.pos.x), u32(i.pos.y), frame.frameIndex) - 0.5;
  o += n * 0.025;
  return vec4f(saturate3(o), 1.0);
}
