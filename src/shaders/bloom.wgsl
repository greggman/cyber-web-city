// Physically based bloom (dual-filter mip chain, Jimenez 2014) and an
// anamorphic horizontal streak for bright neon.
#include "common.wgsl"

struct BloomParams { texel: vec2f, karis: f32, streakStep: f32 };

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> P: BloomParams;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> FsOut { return fullscreen_vertex(vi); }

fn s(uv: vec2f) -> vec3f { return textureSampleLevel(srcTex, linearSampler, uv, 0.0).rgb; }
fn karis_w(c: vec3f) -> f32 { return 1.0 / (1.0 + luminance(c)); }

// 13-tap downsample. P.texel is the SOURCE texel size.
@fragment
fn fs_down(i: FsOut) -> @location(0) vec4f {
  let t = P.texel;
  let uv = i.uv;
  let a = s(uv + t * vec2f(-2.0, -2.0));
  let b = s(uv + t * vec2f(0.0, -2.0));
  let c = s(uv + t * vec2f(2.0, -2.0));
  let d = s(uv + t * vec2f(-2.0, 0.0));
  let e = s(uv);
  let f = s(uv + t * vec2f(2.0, 0.0));
  let g = s(uv + t * vec2f(-2.0, 2.0));
  let h = s(uv + t * vec2f(0.0, 2.0));
  let k = s(uv + t * vec2f(2.0, 2.0));
  let j = s(uv + t * vec2f(-1.0, -1.0));
  let l = s(uv + t * vec2f(1.0, -1.0));
  let m = s(uv + t * vec2f(-1.0, 1.0));
  let n = s(uv + t * vec2f(1.0, 1.0));
  if (P.karis > 0.5) {
    // Karis average on the first downsample to suppress fireflies.
    let g0 = (a + b + d + e) * 0.25;
    let g1 = (b + c + e + f) * 0.25;
    let g2 = (d + e + g + h) * 0.25;
    let g3 = (e + f + h + k) * 0.25;
    let g4 = (j + l + m + n) * 0.25;
    let w0 = karis_w(g0) * 0.125;
    let w1 = karis_w(g1) * 0.125;
    let w2 = karis_w(g2) * 0.125;
    let w3 = karis_w(g3) * 0.125;
    let w4 = karis_w(g4) * 0.5;
    let r = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    return vec4f(min(r, vec3f(500.0)), 1.0);
  }
  var r = e * 0.125;
  r += (a + c + g + k) * 0.03125;
  r += (b + d + f + h) * 0.0625;
  r += (j + l + m + n) * 0.125;
  return vec4f(r, 1.0);
}

// 3x3 tent upsample; blended additively onto the finer level.
@fragment
fn fs_up(i: FsOut) -> @location(0) vec4f {
  let t = P.texel;
  let uv = i.uv;
  var r = s(uv) * 4.0;
  r += (s(uv + vec2f(-t.x, 0.0)) + s(uv + vec2f(t.x, 0.0)) + s(uv + vec2f(0.0, -t.y)) + s(uv + vec2f(0.0, t.y))) * 2.0;
  r += s(uv + vec2f(-t.x, -t.y)) + s(uv + vec2f(t.x, -t.y)) + s(uv + vec2f(-t.x, t.y)) + s(uv + vec2f(t.x, t.y));
  return vec4f(r / 16.0, 1.0);
}

// Streak: bright-pass then repeated wide horizontal blurs.
@fragment
fn fs_streak_prefilter(i: FsOut) -> @location(0) vec4f {
  let c = s(i.uv);
  let l = luminance(c);
  let k = max(l - 2.0, 0.0) / max(l, 1e-4);
  return vec4f(c * k, 1.0);
}

@fragment
fn fs_streak(i: FsOut) -> @location(0) vec4f {
  var r = vec3f(0.0);
  var wsum = 0.0;
  for (var k = -6; k <= 6; k++) {
    let w = exp(-f32(k * k) / 18.0);
    r += s(i.uv + vec2f(f32(k) * P.streakStep * P.texel.x, 0.0)) * w;
    wsum += w;
  }
  return vec4f(r / wsum, 1.0);
}
