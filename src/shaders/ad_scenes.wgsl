// Animated advertisement scenes, raymarched into tiles of the ad atlas.
// Every brand is invented; text comes from the neon glyph atlas.
#include "common.wgsl"
#include "sdf.wgsl"

struct Tile {
  scene: u32, seed: u32, glyphsLo: u32, glyphsHi: u32,
  colA: vec3f, time: f32,
  colB: vec3f, nGlyphs: f32,
};

@group(0) @binding(0) var<uniform> T: Tile;
@group(0) @binding(1) var glyphTex: texture_2d<f32>;
@group(0) @binding(2) var glyphSampler: sampler;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let f = fullscreen_vertex(vi);
  var o: VOut;
  o.pos = f.pos;
  o.uv = f.uv;
  return o;
}

// Scene SDF; material id via m.
fn scene_sdf(p: vec3f, m: ptr<function, u32>) -> f32 {
  let t = T.time;
  *m = 0u;
  switch T.scene {
    case 0u: {
      // Product bottle spinning with a cap.
      let q = rot_y(p - vec3f(0.0, -0.1, 0.0), t * 0.8);
      var d = sd_cyl(q, 0.55, 0.28) - 0.05;
      d = smin(d, sd_cyl(q - vec3f(0.0, 0.75, 0.0), 0.2, 0.1), 0.15);
      let cap = sd_cyl(q - vec3f(0.0, 0.98, 0.0), 0.08, 0.12);
      if (cap < d) { *m = 1u; return cap; }
      return d;
    }
    case 1u: {
      return sd_dancer((p - vec3f(0.0, -1.0, 0.0)) * 1.0, t);
    }
    case 2u: {
      // Two koi circling.
      var d = 1e9;
      for (var k = 0; k < 2; k++) {
        let a = t * 0.6 + f32(k) * PI;
        let c = vec3f(cos(a) * 0.55, sin(t + f32(k)) * 0.1, sin(a) * 0.35);
        let q = rot_y(p - c, -a - PI * 0.5);
        let dk = sd_koi(q * 1.3, t + f32(k)) / 1.3;
        if (dk < d) { d = dk; *m = u32(k) + 2u; }
      }
      return d;
    }
    case 3u: {
      var id = 0u;
      let d = sd_face(p * 0.9 + vec3f(0.0, 0.1, 0.0), t, &id) / 0.9;
      *m = 4u + id;
      return d;
    }
    case 4u: {
      // Noodle bowl with chopsticks.
      let q = rot_y(p, sin(t * 0.4) * 0.4) - vec3f(0.0, -0.3, 0.0);
      let bowl = max(sd_sphere(q, 0.7), q.y - 0.15);
      let hollow = sd_sphere(q, 0.62);
      var d = max(bowl, -hollow);
      let noodles = sd_cyl(q - vec3f(0.0, 0.05, 0.0), 0.04, 0.6) + 0.02 * sin(q.x * 40.0) * sin(q.z * 40.0);
      if (noodles < d) { d = noodles; *m = 9u; }
      let cs = min(sd_capsule(q, vec3f(-0.2, 0.1, 0.0), vec3f(0.5, 0.9, -0.2), 0.025),
                   sd_capsule(q, vec3f(-0.1, 0.12, 0.1), vec3f(0.6, 0.85, 0.0), 0.025));
      if (cs < d) { d = cs; *m = 1u; }
      return d;
    }
    case 5u: {
      // Pharma capsules tumbling.
      var d = 1e9;
      for (var k = 0; k < 3; k++) {
        let fk = f32(k);
        let c = vec3f((fk - 1.0) * 0.6, sin(t + fk * 2.0) * 0.2, 0.0);
        let q = rot_z(rot_x(p - c, t * (0.7 + fk * 0.2)), t * 0.5 + fk);
        let dk = sd_capsule(q, vec3f(0.0, -0.22, 0.0), vec3f(0.0, 0.22, 0.0), 0.14);
        if (dk < d) { d = dk; *m = select(10u, 11u, q.y > 0.0); }
      }
      return d;
    }
    case 6u: {
      return sd_jelly(p * 1.0 + vec3f(0.0, 0.2, 0.0), t);
    }
    default: {
      *m = 1u;
      return sd_logo(p, t);
    }
  }
}

fn calc_normal(p: vec3f) -> vec3f {
  var m = 0u;
  let e = vec2f(0.002, 0.0);
  return normalize(vec3f(
    scene_sdf(p + e.xyy, &m) - scene_sdf(p - e.xyy, &m),
    scene_sdf(p + e.yxy, &m) - scene_sdf(p - e.yxy, &m),
    scene_sdf(p + e.yyx, &m) - scene_sdf(p - e.yyx, &m)));
}

fn material(m: u32, p: vec3f, n: vec3f) -> vec3f {
  let a = T.colA;
  let b = T.colB;
  switch m {
    case 1u: { return vec3f(0.9, 0.85, 0.8); }          // metal/cap/chopsticks
    case 2u: { return mix(vec3f(1.0, 0.4, 0.05), vec3f(1.0), step(0.5, vnoise2(p.xz * 12.0))); }
    case 3u: { return mix(vec3f(0.9, 0.1, 0.05), vec3f(1.0), step(0.6, vnoise2(p.xz * 10.0 + 3.0))); }
    case 4u: { return vec3f(0.95, 0.85, 0.8); }          // skin (pale)
    case 5u: { return vec3f(0.03, 0.02, 0.03); }         // hair
    case 6u: { return vec3f(0.02); }                     // eyes
    case 7u: { return vec3f(0.9, 0.05, 0.1); }           // lips
    case 8u: { return b; }                               // ornaments
    case 9u: { return vec3f(1.0, 0.85, 0.5); }           // noodles
    case 10u: { return a; }
    case 11u: { return vec3f(0.95); }
    default: { return mix(a, b, 0.5 + 0.5 * n.y); }
  }
}

fn glyph_at(i: u32) -> u32 {
  let w = select(T.glyphsHi, T.glyphsLo, i < 4u);
  return (w >> ((i & 3u) * 8u)) & 255u;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  let uv = i.uv;
  let t = T.time;
  // Background: animated gradient with stripes.
  var c = mix(T.colA * 0.15, T.colB * 0.35, uv.y);
  c += T.colB * 0.25 * step(0.85, fract(uv.x * 6.0 + t * 0.3)) * (1.0 - uv.y);
  // Camera.
  let ro = vec3f(0.0, 0.0, 3.2);
  let rd = normalize(vec3f((uv.x - 0.5) * 2.0, (0.5 - uv.y) * 1.0 + 0.0, -1.6));
  var tt = 0.0;
  var hit = false;
  var m = 0u;
  for (var k = 0; k < 64; k++) {
    let d = scene_sdf(ro + rd * tt, &m);
    if (d < 0.002) { hit = true; break; }
    tt += d;
    if (tt > 8.0) { break; }
  }
  if (hit) {
    let p = ro + rd * tt;
    let n = calc_normal(p);
    let alb = material(m, p, n);
    let l1 = normalize(vec3f(0.6, 0.7, 0.5));
    let rim = pow(1.0 - saturate(dot(n, -rd)), 3.0);
    c = alb * (0.15 + 0.85 * saturate(dot(n, l1))) + T.colA * rim * 1.5 + T.colB * saturate(-n.x) * 0.4;
    let spec = pow(saturate(dot(reflect(rd, n), l1)), 40.0);
    c += vec3f(spec);
  }
  // Brand text banner across the bottom.
  let n = u32(T.nGlyphs);
  if (n > 0u && uv.y > 0.8) {
    let gy = (uv.y - 0.8) / 0.2;
    let pitch = min(0.9 / f32(n), 0.2 * 0.5);
    let start = 0.5 - pitch * f32(n) * 0.5;
    let gx = (uv.x - start) / pitch;
    if (gx >= 0.0 && gx < f32(n)) {
      let g = glyph_at(u32(gx));
      let cell = vec2f(f32(g % 16u), f32(g / 16u));
      let guv = vec2f(fract(gx), gy);
      let tx = textureSampleLevel(glyphTex, glyphSampler, (cell + guv) / 16.0, 0.0);
      c = mix(c, vec3f(1.0), tx.r) + T.colA * tx.g * 0.6;
    }
  }
  // Scanline shimmer.
  c *= 0.9 + 0.1 * sin(uv.y * 400.0 + t * 20.0);
  return vec4f(c, 1.0);
}
