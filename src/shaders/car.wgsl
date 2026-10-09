// The player's NURBS car in the scene: clustered lighting, clear-coat paint,
// emissive lights, animated screens, and refractive glass (transparent pass).
#include "scene.wgsl"
#include "lighting.wgsl"

struct Material {
  color: vec3f, kind: f32,
  emissive: vec3f, roughness: f32,
  metallic: f32, param: f32, _p0: f32, _p1: f32,
};

@group(1) @binding(0) var<storage, read> materials: array<Material>;
@group(1) @binding(1) var sceneColor: texture_2d<f32>;   // lit copy (for refraction)
@group(1) @binding(2) var linearSampler: sampler;
@group(1) @binding(3) var canopyFx: texture_2d<f32>;     // droplets/condensation (M6)

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) mat: u32,
};
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) mat: u32,
  @location(4) clipCur: vec4f,
  @location(5) clipPrev: vec4f,
  @location(6) local: vec3f,
};

@vertex
fn vs(v: VIn) -> VOut {
  var o: VOut;
  let w = frame.carToWorld * vec4f(v.pos, 1.0);
  o.pos = frame.viewProj * w;
  o.world = w.xyz;
  o.normal = (frame.carToWorld * vec4f(v.normal, 0.0)).xyz;
  o.uv = v.uv;
  o.mat = v.mat;
  o.clipCur = frame.viewProjNoJitter * w;
  o.clipPrev = frame.prevViewProj * (frame.prevCarToWorld * vec4f(v.pos, 1.0));
  o.local = v.pos;
  return o;
}

fn screen_content(id: u32, uv: vec2f, tint: vec3f) -> vec3f {
  let t = frame.time;
  var c = vec3f(0.0);
  if (id == 0u) {
    // Nav map: scrolling street grid with a route and our position.
    let p = uv * 8.0 + vec2f(0.0, t * 0.6);
    let g = abs(fract(p) - 0.5);
    c = vec3f(0.0, 0.35, 0.55) * (1.0 - smoothstep(0.0, 0.05, min(g.x, g.y)));
    let blocks = step(0.5, hashf2(floor(p))) * 0.15;
    c += vec3f(0.05, 0.12, 0.2) * blocks;
    let route = abs(uv.x - 0.5 - 0.15 * sin(uv.y * 5.0 + t * 0.3));
    c += vec3f(1.0, 0.35, 0.05) * (1.0 - smoothstep(0.0, 0.02, route));
    c += vec3f(1.0) * smoothstep(0.04, 0.0, length(uv - vec2f(0.5, 0.25)));
  } else if (id == 1u) {
    // Gauges: altitude ring and speed bars.
    let p = uv * 2.0 - 1.0;
    let r = length(p);
    let ang = atan2(p.y, p.x);
    let fill = step(ang, -PI + (sin(t * 0.3) * 0.5 + 0.5) * TAU);
    c = vec3f(0.1, 1.0, 0.65) * step(abs(r - 0.7), 0.05) * fill;
    c += vec3f(0.02, 0.15, 0.1) * step(abs(r - 0.7), 0.08);
    let bars = step(fract(uv.x * 10.0), 0.6) * step(uv.y, 0.25 + 0.2 * hash11(u32(uv.x * 10.0) + u32(t * 4.0)));
    c += vec3f(1.0, 0.6, 0.1) * bars * step(r, 0.5);
  } else {
    // Comms: scrolling text lines.
    let row = floor(uv.y * 12.0 + t * 1.5);
    let w = 0.3 + 0.6 * hash11(u32(row + 100.0));
    let ch = step(0.35, fract(uv.x * 30.0)) * step(0.3, hash21(u32(uv.x * 30.0), u32(row)));
    c = vec3f(1.0, 0.55, 0.1) * step(fract(uv.y * 12.0 + t * 1.5), 0.6) * step(uv.x, w) * ch;
  }
  // Scanlines.
  c *= 0.8 + 0.2 * step(0.5, fract(uv.y * 120.0));
  return c * tint * 2.5;
}

struct GOut {
  @location(0) color: vec4f,
  @location(1) normal: vec4f,
  @location(2) velocity: vec2f,
};

fn velocity_of(i: VOut) -> vec2f {
  let a = i.clipCur.xy / i.clipCur.w;
  let b = i.clipPrev.xy / i.clipPrev.w;
  return (b - a) * vec2f(0.5, -0.5);
}

@fragment
fn fs_opaque(i: VOut, @builtin(front_facing) front: bool) -> GOut {
  g_fragCoord = i.pos;
  let m = materials[i.mat];
  var n = normalize(i.normal);
  if (!front) { n = -n; }
  let kind = u32(m.kind);
  var sf: Surface;
  sf.normal = n;
  sf.albedo = m.color;
  sf.roughness = m.roughness;
  sf.metallic = m.metallic;
  sf.reflectivity = select(0.3, 0.9, kind == 1u || m.metallic > 0.5);
  sf.emissive = vec3f(0.0);
  if (kind == 3u) {
    sf.emissive = m.emissive;
    sf.albedo = vec3f(0.0);
  } else if (kind == 4u) {
    sf.emissive = screen_content(u32(m.param), i.uv, m.emissive);
    sf.albedo = vec3f(0.01);
    sf.roughness = 0.1;
  }
  var c = shade_surface(sf, i.world);
  if (kind == 1u) {
    // Clear coat: a second, sharp specular lobe over the paint.
    let v = normalize(frame.camPos - i.world);
    let fres = 0.04 + 0.96 * pow(1.0 - saturate(dot(n, v)), 5.0);
    c += fres * reflection_env(reflect(-v, n)) * 1.5;
    c += light_clustered(i.world, n, v, vec3f(0.0), 0.06, 0.0) * 0.5;
  }
  var o: GOut;
  o.color = vec4f(c, 1.0);
  o.normal = vec4f(encode_normal(n), sf.roughness, sf.reflectivity);
  o.velocity = velocity_of(i);
  return o;
}

@fragment
fn fs_glass(i: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  g_fragCoord = i.pos;
  let m = materials[i.mat];
  var n = normalize(i.normal);
  if (!front) { n = -n; }
  let v = normalize(frame.camPos - i.world);
  let nv = saturate(dot(n, v));
  let fres = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  // Droplets and condensation (filled in by the weather system).
  let fx = textureSampleLevel(canopyFx, linearSampler, i.uv, 0.0);
  let dropN = fx.xy * 2.0 - 1.0;
  let fog = fx.z;
  let screenUv = i.pos.xy * frame.invResolution;
  let refractOff = dropN * 0.012 + n.xy * 0.002;
  var behind = textureSampleLevel(sceneColor, linearSampler, screenUv + refractOff, 0.0).rgb;
  // Condensation scatters light: blur by sampling around.
  if (fog > 0.01) {
    // Jittered disk blur (rotated per pixel and frame; TAA resolves the noise).
    let rot = hash31(u32(i.pos.x), u32(i.pos.y), frame.frameIndex) * TAU;
    var acc = vec3f(0.0);
    for (var k = 0; k < 8; k++) {
      let a = rot + f32(k) * 2.39996;
      let r = sqrt((f32(k) + 0.5) / 8.0) * 0.022 * fog;
      acc += textureSampleLevel(sceneColor, linearSampler, screenUv + vec2f(cos(a), sin(a)) * r, 0.0).rgb;
    }
    behind = mix(behind, acc / 8.0, saturate(fog * 1.5));
  }
  var sf: Surface;
  sf.normal = n;
  sf.albedo = vec3f(0.0);
  sf.roughness = 0.03;
  sf.metallic = 0.0;
  sf.reflectivity = 1.0;
  sf.emissive = vec3f(0.0);
  let refl = reflection_env(reflect(-v, n)) + light_clustered(i.world, n, v, vec3f(0.0), 0.05, 0.0);
  let tint = mix(vec3f(1.0), saturate3(m.color), saturate(m.param * 4.0));
  let transmit = (1.0 - fres) * (1.0 - m.param);
  let condensation = vec3f(0.05, 0.055, 0.065) * fog + behind * fog * 0.35;
  // A little extra sheen at grazing angles so the canopy reads as glass.
  let rim = smoothstep(0.55, 0.0, nv) * vec3f(0.05, 0.06, 0.08);
  // Drops: darker refracting rim and a small specular glint.
  let cov = fx.w;
  if (cov > 0.05) {
    // A drop is a tiny lens: it shows a magnified, inverted view from
    // slightly beyond its own footprint, a bit brighter (it gathers light).
    let lensUv = screenUv - dropN * 0.035;
    let lens = textureSampleLevel(sceneColor, linearSampler, lensUv, 0.0).rgb;
    // Bright refracted rim around each bead.
    let ring = smoothstep(0.45, 0.9, length(dropN)) * cov;
    behind = mix(behind, lens * 1.3, cov) + ring * (vec3f(0.06, 0.06, 0.08) + lens * 0.6);
  }
  let glint = pow(saturate(1.0 - length(dropN - vec2f(-0.35, 0.35)) * 1.6), 6.0) * cov;
  let c = refl * (fres * 2.0 + 0.03) + condensation + rim + glint * vec3f(0.75, 0.8, 0.9);
  // The glass samples what is behind it itself (refraction), so it simply
  // replaces the pixel.
  return vec4f(c + behind * tint * transmit + behind * fres * 0.0, 1.0);
}

// Additive glow volumes (lift/thruster cones). Brightest where seen
// face-on, fading toward the tip (v = 1) and flickering slightly.
@fragment
fn fs_glow(i: VOut) -> @location(0) vec4f {
  let m = materials[i.mat];
  let n = normalize(i.normal);
  let v = normalize(frame.camPos - i.world);
  let facing = pow(abs(dot(n, v)), 1.5);
  let fade = pow(1.0 - saturate(i.uv.y), 1.6);
  let flick = 0.9 + 0.1 * sin(frame.time * 23.0 + i.uv.x * 12.0);
  return vec4f(m.emissive * facing * fade * flick * 0.35, 0.0);
}
