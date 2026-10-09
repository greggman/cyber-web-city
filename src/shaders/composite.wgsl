// Composite: sky where nothing was drawn, plus height fog over geometry.
#include "frame.wgsl"
#include "common.wgsl"
#include "sky.wgsl"
#include "warp.wgsl"

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var colorTex: texture_2d<f32>;
@group(1) @binding(1) var depthTex: texture_depth_2d;
@group(1) @binding(2) var volumeTex: texture_3d<f32>;
@group(1) @binding(3) var volSampler: sampler;
@group(1) @binding(4) var districtTex: texture_2d<u32>;

// Xenon searchlights (ART_BIBLE.md 15.5), uploaded by volumetrics.ts.
struct Beam { origin: vec3f, len: f32, dir: vec3f, intensity: f32 };
@group(1) @binding(5) var<uniform> beams: array<Beam, 16>;
const XENON = vec3f(0.716, 0.807, 1.0);

// Light scattered toward the camera by each beam, integrated analytically
// across its gaussian profile at the closest approach of the view ray,
// limited by the scene depth along the ray.
fn beam_light(ro: vec3f, rd: vec3f, maxT: f32) -> vec3f {
  var c = vec3f(0.0);
  for (var i = 0u; i < 16u; i++) {
    let b = beams[i];
    if (b.intensity <= 0.0) { continue; }
    let w0 = ro - b.origin;
    let bb = dot(rd, b.dir);
    let dd = dot(rd, w0);
    let ee = dot(b.dir, w0);
    let den = max(1.0 - bb * bb, 1e-4);
    let t = (bb * ee - dd) / den;
    var s = (ee - bb * dd) / den;
    if (t < 0.0 || t > maxT) { continue; }
    s = clamp(s, 0.0, b.len);
    let q = ro + rd * t;
    let dist = length(q - (b.origin + b.dir * s));
    let w = 1.6 + s * 0.022;
    let prof = exp(-(dist * dist) / (w * w));
    if (prof < 1e-3) { continue; }
    let along = exp(-s / 900.0) * smoothstep(0.0, 8.0, s);
    // Path length through the beam grows as the view grazes along it.
    let path = w * 1.77 / max(sqrt(den), 0.15);
    let y = max(q.y, 0.0);
    let dens = frame.fogDensity * exp(-frame.fogHeightFalloff * y * 0.6) * (1.0 + frame.rain);
    let ph = 0.5 + 2.5 * pow(max(dot(-rd, b.dir), 0.0), 8.0);
    c += XENON * b.intensity * prof * along * path * dens * ph;
  }
  return c;
}

// Haze tint per district (ART_BIBLE.md 10): Core cool blue-grey, Megablock
// warm brown, Slum green, Market magenta, Corporate clean amber.
fn district_tint(d: u32) -> vec3f {
  switch d {
    case 0u: { return vec3f(0.94, 0.98, 1.06); }
    case 1u: { return vec3f(1.08, 1.0, 0.9); }
    case 2u: { return vec3f(1.04, 1.0, 0.9); }
    case 3u: { return vec3f(1.12, 0.97, 0.9); }
    case 4u: { return vec3f(1.06, 1.0, 0.94); }
    default: { return vec3f(1.0); }
  }
}

fn tint_at(i: vec2i, n: i32) -> vec3f {
  let p = clamp(i, vec2i(0), vec2i(n - 1));
  return district_tint(textureLoad(districtTex, p, 0).r);
}

// Bilinear blend of the four nearest superblocks' tints at a world xz
// (unwarped to the grid; SUPER = 300 and AVENUE_W = 64 as in layout.ts).
fn haze_tint(xz: vec2f) -> vec3f {
  let g = unwarp2(xz);
  let n = i32(textureDimensions(districtTex).x);
  let q = (g - 32.0) / 300.0 - 0.5 + f32(n / 2);
  let i = vec2i(floor(q));
  let f = fract(q);
  let a = mix(tint_at(i, n), tint_at(i + vec2i(1, 0), n), f.x);
  let b = mix(tint_at(i + vec2i(0, 1), n), tint_at(i + vec2i(1, 1), n), f.x);
  return mix(a, b, f.y);
}

// Must match volumetric.wgsl.
fn volume_light(uv: vec2f, viewZ: f32) -> vec3f {
  let z = log(max(viewZ, 0.5) / 0.5) / log(1500.0 / 0.5);
  return textureSampleLevel(volumeTex, volSampler, vec3f(uv, saturate(z)), 0.0).rgb;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> FsOut { return fullscreen_vertex(vi); }

// Distant rain sheets: screen-space streak layers that brighten against lit
// backgrounds, faded in with depth (near rain is real particles).
fn rain_sheets(uv: vec2f, linDepth: f32, bg: vec3f) -> vec3f {
  if (frame.rain <= 0.0) { return vec3f(0.0); }
  var acc = 0.0;
  for (var l = 0; l < 3; l++) {
    let fl = f32(l);
    let scale = vec2f(220.0 + fl * 140.0, 3.0 + fl * 1.5);
    let p = vec2f(uv.x + uv.y * 0.08, uv.y) * scale + vec2f(fl * 17.0, -frame.time * (6.0 + fl * 2.5));
    let col = floor(p.x);
    let h = hash21(u32(col + 4096.0), u32(l));
    let y = fract(p.y + h * 13.0);
    let streak = smoothstep(0.0, 0.05, y) * smoothstep(0.3, 0.05, y) * step(0.82, h);
    acc += streak * (0.6 - fl * 0.15);
  }
  let fade = smoothstep(30.0, 120.0, linDepth);
  return acc * fade * (bg * 0.25 + frame.fogColor * 0.08) * frame.rain;
}

@fragment
fn fs(i: FsOut) -> @location(0) vec4f {
  let p = vec2i(i.pos.xy);
  let depth = textureLoad(depthTex, p, 0);
  let world = world_from_depth(i.uv, max(depth, 1e-7), frame.invViewProj);
  let dir = normalize(world - frame.camPos);
  if (depth <= 0.0) {
    let sky = sky_color(dir, frame.time);
    return vec4f(sky + rain_sheets(i.uv, 1e5, sky) + volume_light(i.uv, 1e5) + beam_light(frame.camPos, dir, 1e5), 1.0);
  }
  let c = textureLoad(colorTex, p, 0).rgb;
  var fog = fog_amount(frame.camPos, world);
  if (frame.debugView != 0u) { fog = 0.0; }
  // The haze picks up the district's light (fades out over open sky).
  // Local haze only: far away the patches of superblocks would read as
  // blocks, so the tint fades out with distance.
  let tintK = mix(0.75, 0.6, smoothstep(500.0, 2200.0, distance(world, frame.camPos)));
  let fogged = mix(c, fog_color(dir, world.y, distance(world, frame.camPos)) * mix(vec3f(1.0), haze_tint(world.xz), tintK), fog);
  let lin = linear_depth(depth, frame.near);
  let rayLen = distance(world, frame.camPos);
  return vec4f(fogged + rain_sheets(i.uv, lin, fogged) + volume_light(i.uv, lin) + beam_light(frame.camPos, dir, rayLen), 1.0);
}
