// Temporal anti-aliasing: reproject history with motion vectors, clip it to
// the current frame's 3x3 neighborhood (YCoCg), and blend.
#include "frame.wgsl"
#include "common.wgsl"

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var currentTex: texture_2d<f32>;
@group(1) @binding(1) var historyTex: texture_2d<f32>;
@group(1) @binding(2) var velocityTex: texture_2d<f32>;
@group(1) @binding(3) var depthTex: texture_depth_2d;
@group(1) @binding(4) var linearSampler: sampler;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> FsOut { return fullscreen_vertex(vi); }

fn rgb_to_ycocg(c: vec3f) -> vec3f {
  return vec3f(
    0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
    0.5 * c.r - 0.5 * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
fn ycocg_to_rgb(c: vec3f) -> vec3f {
  return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}
// Compress HDR so bright neon doesn't dominate the blend (Karis).
fn tm(c: vec3f) -> vec3f { return c / (1.0 + luminance(c)); }
fn itm(c: vec3f) -> vec3f { return c / max(1.0 - luminance(c), 1e-4); }

// 5-tap Catmull-Rom history fetch (sharper than bilinear).
fn sample_catmull(uv: vec2f, res: vec2f) -> vec3f {
  let pos = uv * res;
  let c = floor(pos - 0.5) + 0.5;
  let f = pos - c;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let o12 = w2 / w12;
  let t0 = (c - 1.0) / res;
  let t3 = (c + 2.0) / res;
  let t12 = (c + o12) / res;
  var r = vec3f(0.0);
  r += textureSampleLevel(historyTex, linearSampler, vec2f(t12.x, t0.y), 0.0).rgb * w12.x * w0.y;
  r += textureSampleLevel(historyTex, linearSampler, vec2f(t0.x, t12.y), 0.0).rgb * w0.x * w12.y;
  r += textureSampleLevel(historyTex, linearSampler, vec2f(t12.x, t12.y), 0.0).rgb * w12.x * w12.y;
  r += textureSampleLevel(historyTex, linearSampler, vec2f(t3.x, t12.y), 0.0).rgb * w3.x * w12.y;
  r += textureSampleLevel(historyTex, linearSampler, vec2f(t12.x, t3.y), 0.0).rgb * w12.x * w3.y;
  let wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / wsum, vec3f(0.0));
}

@fragment
fn fs(i: FsOut) -> @location(0) vec4f {
  let p = vec2i(i.pos.xy);
  let res = frame.resolution;
  let dims = vec2i(res);
  // Neighborhood stats and closest depth (for velocity dilation).
  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  var closest = 0.0;
  var closestP = p;
  let cur = textureLoad(currentTex, p, 0).rgb;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = clamp(p + vec2i(x, y), vec2i(0), dims - 1);
      let c = rgb_to_ycocg(tm(textureLoad(currentTex, q, 0).rgb));
      m1 += c;
      m2 += c * c;
      let d = textureLoad(depthTex, q, 0);
      if (d > closest) { closest = d; closestP = q; }
    }
  }
  let mean = m1 / 9.0;
  let sd = sqrt(max(m2 / 9.0 - mean * mean, vec3f(0.0)));
  let boxMin = mean - sd * 1.25;
  let boxMax = mean + sd * 1.25;
  // Motion: geometry writes velocity; sky (depth 0) reprojects by direction.
  var vel = textureLoad(velocityTex, closestP, 0).xy;
  if (closest <= 0.0) {
    let uv = i.uv;
    let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 1e-7, 1.0);
    let w = frame.invViewProj * ndc;
    let dir = normalize(w.xyz / w.w - frame.camPos);
    let prev = frame.prevViewProj * vec4f(dir, 0.0);
    let pndc = prev.xy / prev.w;
    let cndc = (frame.viewProjNoJitter * vec4f(dir, 0.0));
    vel = (pndc - cndc.xy / cndc.w) * vec2f(0.5, -0.5);
  }
  let prevUv = i.uv + vel;
  var hist = sample_catmull(prevUv, res);
  let offscreen = any(prevUv < vec2f(0.0)) || any(prevUv > vec2f(1.0));
  let hy = rgb_to_ycocg(tm(hist));
  // Clip toward the box center (variance clipping).
  let center = (boxMin + boxMax) * 0.5;
  let ext = max((boxMax - boxMin) * 0.5, vec3f(1e-5));
  let off = hy - center;
  let unit = abs(off / ext);
  let mx = max(unit.x, max(unit.y, unit.z));
  var clipped = hy;
  if (mx > 1.0) { clipped = center + off / mx; }
  let speed = length(vel * res);
  var alpha = mix(0.08, 0.25, saturate(speed / 30.0));
  if (offscreen || frame.frameIndex == 0u) { alpha = 1.0; }
  let curY = rgb_to_ycocg(tm(cur));
  let outY = mix(clipped, curY, alpha);
  return vec4f(itm(ycocg_to_rgb(outY)), 1.0);
}
