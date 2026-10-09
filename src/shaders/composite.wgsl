// Composite: sky where nothing was drawn, plus height fog over geometry.
#include "frame.wgsl"
#include "common.wgsl"
#include "sky.wgsl"

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var colorTex: texture_2d<f32>;
@group(1) @binding(1) var depthTex: texture_depth_2d;
@group(1) @binding(2) var volumeTex: texture_3d<f32>;
@group(1) @binding(3) var volSampler: sampler;

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
  return acc * fade * (bg * 0.25 + frame.fogColor * 1.5) * frame.rain;
}

@fragment
fn fs(i: FsOut) -> @location(0) vec4f {
  let p = vec2i(i.pos.xy);
  let depth = textureLoad(depthTex, p, 0);
  let world = world_from_depth(i.uv, max(depth, 1e-7), frame.invViewProj);
  let dir = normalize(world - frame.camPos);
  if (depth <= 0.0) {
    let sky = sky_color(dir, frame.time);
    return vec4f(sky + rain_sheets(i.uv, 1e5, sky) + volume_light(i.uv, 1e5), 1.0);
  }
  let c = textureLoad(colorTex, p, 0).rgb;
  var fog = fog_amount(frame.camPos, world);
  if (frame.debugView != 0u) { fog = 0.0; }
  let fogged = mix(c, fog_color(dir, world.y), fog);
  let lin = linear_depth(depth, frame.near);
  return vec4f(fogged + rain_sheets(i.uv, lin, fogged) + volume_light(i.uv, lin), 1.0);
}
