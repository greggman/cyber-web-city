// Screen-space ambient occlusion (SAO-style) at half resolution, from the
// depth prepass. Per-pixel rotated spiral taps; TAA accumulates the noise.
// Output: r = ambient visibility (1 = open, 0 = fully occluded).
#include "frame.wgsl"
#include "common.wgsl"

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var depthTex: texture_depth_2d;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> FsOut { return fullscreen_vertex(vi); }

const TAPS = 12;
const RADIUS = 1.2; // meters
const INTENSITY = 2.0;

fn view_pos(uv: vec2f, d: f32) -> vec3f {
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  let v = frame.invProj * ndc;
  return v.xyz / v.w;
}

fn depth_at(px: vec2i) -> f32 {
  let dims = vec2i(textureDimensions(depthTex));
  return textureLoad(depthTex, clamp(px, vec2i(0), dims - 1), 0);
}

@fragment
fn fs(i: FsOut) -> @location(0) vec4f {
  let full = vec2f(textureDimensions(depthTex));
  let px = vec2i(i.uv * full);
  let d = depth_at(px);
  if (d <= 0.0) { return vec4f(1.0); }
  let P = view_pos(i.uv, d);
  // Normal from neighboring depths (pick the smaller difference per axis).
  let inv = 1.0 / full;
  let pr = view_pos(i.uv + vec2f(inv.x, 0.0), depth_at(px + vec2i(1, 0)));
  let pl = view_pos(i.uv - vec2f(inv.x, 0.0), depth_at(px - vec2i(1, 0)));
  let pu = view_pos(i.uv + vec2f(0.0, inv.y), depth_at(px + vec2i(0, 1)));
  let pd = view_pos(i.uv - vec2f(0.0, inv.y), depth_at(px - vec2i(0, 1)));
  let dx = select(P - pl, pr - P, abs(pr.z - P.z) < abs(P.z - pl.z));
  let dy = select(P - pd, pu - P, abs(pu.z - P.z) < abs(P.z - pd.z));
  let N = normalize(cross(dy, dx));
  // Projected radius in pixels.
  let z = -P.z;
  let projScale = full.y / (2.0 * frame.tanHalfFov.y);
  // Capped footprint: up close a big kernel turns thin props into wide,
  // noisy halos on the wall behind them.
  let rPx = min(RADIUS * projScale / max(z, 0.1), 32.0);
  if (rPx < 1.0) { return vec4f(1.0); }
  let rot = hash31(u32(i.pos.x), u32(i.pos.y), frame.frameIndex % 8u) * TAU;
  var occ = 0.0;
  for (var k = 0; k < TAPS; k++) {
    let a = (f32(k) + 0.5) / f32(TAPS);
    let ang = a * 7.0 * TAU / 2.0 + rot;
    let r = a * rPx;
    let off = vec2f(cos(ang), sin(ang)) * r;
    let q = vec2i(vec2f(px) + off);
    let qd = depth_at(q);
    if (qd <= 0.0) { continue; }
    let Q = view_pos((vec2f(q) + 0.5) * inv, qd);
    let v = Q - P;
    let vv = dot(v, v);
    let vn = dot(v, N);
    // SAO falloff term.
    let f = max(RADIUS * RADIUS - vv, 0.0);
    occ += f * f * f * max((vn - 0.003 * z) / (vv + 0.01), 0.0);
  }
  let norm = 5.0 / (pow(RADIUS, 6.0) * f32(TAPS));
  let vis = max(0.0, 1.0 - occ * norm * INTENSITY);
  return vec4f(vis, 0.0, 0.0, 1.0);
}
