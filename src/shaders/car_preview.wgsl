// Standalone preview renderer for NURBS models (car design tool).
#include "common.wgsl"

struct Uniforms {
  viewProj: mat4x4f,
  model: mat4x4f,
  camPos: vec3f, time: f32,
  env: u32, _p0: u32, _p1: u32, _p2: u32,
};

struct Material {
  color: vec3f, kind: f32,
  emissive: vec3f, roughness: f32,
  metallic: f32, param: f32, _p0: f32, _p1: f32,
};

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var<storage, read> materials: array<Material>;

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
};

@vertex
fn vs(v: VIn) -> VOut {
  var o: VOut;
  let w = U.model * vec4f(v.pos, 1.0);
  o.pos = U.viewProj * w;
  o.world = w.xyz;
  o.normal = (U.model * vec4f(v.normal, 0.0)).xyz;
  o.uv = v.uv;
  o.mat = v.mat;
  return o;
}

// Environment: studio softboxes or a neon city at night.
fn env(dir: vec3f) -> vec3f {
  let d = normalize(dir);
  if (U.env == 0u) {
    var c = mix(vec3f(0.18), vec3f(0.55, 0.57, 0.6), smoothstep(-0.2, 0.6, d.y));
    // Softboxes.
    c += vec3f(6.0) * smoothstep(0.9, 0.95, dot(d, normalize(vec3f(0.3, 1.0, 0.2))));
    c += vec3f(3.0) * smoothstep(0.85, 0.92, dot(d, normalize(vec3f(-1.0, 0.4, -0.3))));
    c += vec3f(2.0) * smoothstep(0.75, 0.9, dot(d, normalize(vec3f(1.0, 0.2, -1.0))));
    return c;
  }
  // City: dark violet sky, neon bands at the horizon, warm street glow below.
  var c = mix(vec3f(0.08, 0.03, 0.05), vec3f(0.01, 0.01, 0.025), smoothstep(-0.1, 0.5, d.y));
  let a = atan2(d.z, d.x);
  // Distant towers with neon signs and lit windows.
  let col = floor(a * 40.0);
  let towerH = 0.05 + 0.25 * hash11(u32(col + 500.0));
  let inTower = step(d.y, towerH) * step(-0.02, d.y);
  let win = step(0.8, hash21(u32(floor(a * 300.0) + 500.0), u32(floor(d.y * 400.0))));
  c = mix(c, vec3f(0.02, 0.015, 0.03), inTower);
  c += inTower * win * vec3f(1.0, 0.75, 0.5) * 0.25;
  let sign = step(0.85, hash11(u32(col + 900.0))) * smoothstep(0.02, 0.0, abs(d.y - towerH * 0.6)) ;
  c += sign * mix(vec3f(6.0, 0.4, 3.0), vec3f(0.3, 3.0, 6.0), step(0.5, hash11(u32(col + 77.0))));
  c += vec3f(1.5, 0.6, 0.2) * smoothstep(0.0, -0.3, d.y);
  return c;
}

fn lights(n: vec3f, v: vec3f, albedo: vec3f, rough: f32, metal: f32, world: vec3f) -> vec3f {
  var dirs: array<vec3f, 3>;
  var cols: array<vec3f, 3>;
  if (U.env == 0u) {
    dirs = array<vec3f, 3>(normalize(vec3f(0.3, 1.0, 0.2)), normalize(vec3f(-1.0, 0.4, -0.3)), normalize(vec3f(1.0, 0.2, -1.0)));
    cols = array<vec3f, 3>(vec3f(2.5), vec3f(1.2), vec3f(0.8));
  } else {
    dirs = array<vec3f, 3>(normalize(vec3f(-1.0, 0.3, 0.2)), normalize(vec3f(1.0, 0.2, -0.4)), normalize(vec3f(0.0, -1.0, 0.0)));
    cols = array<vec3f, 3>(vec3f(2.0, 0.2, 1.2), vec3f(0.2, 1.4, 2.2), vec3f(0.6, 0.3, 0.1));
  }
  var c = vec3f(0.0);
  let a = max(rough * rough, 0.002);
  let f0 = mix(vec3f(0.04), albedo, metal);
  for (var i = 0; i < 3; i++) {
    let l = dirs[i];
    let h = normalize(l + v);
    let nl = saturate(dot(n, l));
    let nh = saturate(dot(n, h));
    let d = a * a / (PI * pow(nh * nh * (a * a - 1.0) + 1.0, 2.0));
    let f = f0 + (1.0 - f0) * pow(1.0 - saturate(dot(h, v)), 5.0);
    c += cols[i] * nl * (albedo * (1.0 - metal) / PI + f * d * 0.25);
  }
  return c;
}

fn screen_content(id: u32, uv: vec2f, tint: vec3f) -> vec3f {
  let t = U.time;
  var c = vec3f(0.0);
  if (id == 0u) {
    // Nav map: grid + route.
    let g = abs(fract(uv * 12.0) - 0.5);
    c = vec3f(0.0, 0.4, 0.6) * (1.0 - smoothstep(0.0, 0.06, min(g.x, g.y)));
    let route = abs(uv.y - 0.5 - 0.2 * sin(uv.x * 6.0 + t * 0.5));
    c += vec3f(1.0, 0.3, 0.1) * (1.0 - smoothstep(0.0, 0.03, route));
  } else if (id == 1u) {
    // Gauges.
    let p = uv * 2.0 - 1.0;
    let r = length(p);
    let ang = atan2(p.y, p.x);
    c = vec3f(0.1, 1.0, 0.6) * step(abs(r - 0.7), 0.04) * step(ang, sin(t) * 1.5);
    c += vec3f(0.02, 0.1, 0.08);
  } else {
    // Comms: scrolling text bars.
    let row = floor(uv.y * 10.0 + t);
    let w = hash11(u32(row + 100.0));
    c = vec3f(1.0, 0.6, 0.1) * step(fract(uv.y * 10.0 + t), 0.6) * step(uv.x, w);
  }
  return c * tint * 2.0;
}

fn shade(i: VOut, front: bool) -> vec4f {
  let m = materials[i.mat];
  var n = normalize(i.normal);
  if (!front) { n = -n; }
  let v = normalize(U.camPos - i.world);
  let kind = u32(m.kind);
  if (kind == 3u) {
    return vec4f(m.emissive, 1.0);
  }
  if (kind == 4u) {
    return vec4f(screen_content(u32(m.param), i.uv, m.emissive), 1.0);
  }
  let r = reflect(-v, n);
  let fres = pow(1.0 - saturate(dot(n, v)), 5.0);
  var c = lights(n, v, m.color, m.roughness, m.metallic, i.world);
  let f0 = mix(vec3f(0.04), m.color, m.metallic);
  let spec = (f0 + (1.0 - f0) * fres) * env(r) * mix(1.0, 0.15, m.roughness);
  c += spec + m.color * (1.0 - m.metallic) * env(n) * 0.15;
  if (kind == 1u) {
    // Clear coat over the base.
    c += (0.04 + 0.96 * fres) * env(r) * 0.6;
  }
  if (kind == 2u) {
    let alpha = mix(m.param, 1.0, fres * 0.9);
    let gc = (0.04 + 0.96 * fres) * env(r) + m.color * m.param * 0.2;
    return vec4f(gc, alpha);
  }
  return vec4f(c, 1.0);
}

@fragment
fn fs_opaque(i: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  return shade(i, front);
}

@fragment
fn fs_glass(i: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let c = shade(i, front);
  return vec4f(c.rgb * c.a, c.a); // premultiplied
}

// Ground plane + background.
struct BgOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@group(0) @binding(2) var<uniform> invViewProj: mat4x4f;

@vertex
fn vs_bg(@builtin(vertex_index) vi: u32) -> BgOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  var o: BgOut;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}

struct BgFrag { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 };

@fragment
fn fs_bg(i: BgOut) -> BgFrag {
  let a = invViewProj * vec4f(i.ndc, 0.0, 1.0);
  let b = invViewProj * vec4f(i.ndc, 1.0, 1.0);
  let ro = a.xyz / a.w;
  let rd = normalize(b.xyz / b.w - ro);
  var o: BgFrag;
  o.color = vec4f(env(rd) * 0.5, 1.0);
  o.depth = 1.0;
  if (rd.y < 0.0) {
    let t = -ro.y / rd.y;
    let p = ro + rd * t;
    let g = abs(fract(p.xz) - 0.5);
    let line = 1.0 - smoothstep(0.0, 0.02, min(g.x, g.y));
    let r = length(p.xz);
    let shadow = mix(0.25, 1.0, smoothstep(1.2, 3.2, length(p.xz * vec2f(1.0, 0.55))));
    let refl = env(reflect(rd, vec3f(0.0, 1.0, 0.0))) * 0.15;
    var c = (vec3f(0.05) + line * 0.05 + refl) * shadow;
    c = mix(c, env(rd) * 0.5, smoothstep(10.0, 40.0, r));
    o.color = vec4f(c, 1.0);
    let clip = U.viewProj * vec4f(p, 1.0);
    o.depth = clip.z / clip.w;
  }
  return o;
}
