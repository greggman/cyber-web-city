// Neon signs: instanced boxes with glyph-atlas text on their faces.
#include "scene.wgsl"
#include "lighting.wgsl"

struct Sign {
  pos: vec3f, kindBits: u32,
  right: vec3f, width: f32,
  normal: vec3f, height: f32,
  colorA: u32, colorB: u32, glyphsLo: u32, glyphsHi: u32,
};

@group(1) @binding(0) var<storage, read> signs: array<Sign>;
@group(1) @binding(1) var glyphTex: texture_2d<f32>;
@group(1) @binding(2) var glyphSampler: sampler;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) sign: u32,
  @location(4) @interpolate(flat) face: u32, // 0 = text face, 1 = edge
  @location(5) clipCur: vec4f,
  @location(6) clipPrev: vec4f,
};

// Unit cube: 6 faces x 4 verts, built procedurally from vertex_index.
fn cube_corner(face: u32, corner: u32) -> vec3f {
  let c = vec2f(f32(corner & 1u), f32((corner >> 1u) & 1u)) * 2.0 - 1.0;
  switch face {
    case 0u: { return vec3f(c.x, c.y, 1.0); }    // front (+normal)
    case 1u: { return vec3f(-c.x, c.y, -1.0); }  // back
    case 2u: { return vec3f(1.0, c.y, -c.x); }   // right
    case 3u: { return vec3f(-1.0, c.y, c.x); }   // left
    case 4u: { return vec3f(c.x, 1.0, -c.y); }   // top
    default: { return vec3f(c.x, -1.0, c.y); }   // bottom
  }
}
fn cube_normal(face: u32) -> vec3f {
  switch face {
    case 0u: { return vec3f(0.0, 0.0, 1.0); }
    case 1u: { return vec3f(0.0, 0.0, -1.0); }
    case 2u: { return vec3f(1.0, 0.0, 0.0); }
    case 3u: { return vec3f(-1.0, 0.0, 0.0); }
    case 4u: { return vec3f(0.0, 1.0, 0.0); }
    default: { return vec3f(0.0, -1.0, 0.0); }
  }
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let s = signs[ii];
  let face = vi / 6u;
  let tri = array<u32, 6>(0u, 1u, 3u, 0u, 3u, 2u);
  let corner = tri[vi % 6u];
  let kind = s.kindBits & 255u;
  let thick = select(0.5, 0.8, kind == 1u);
  let lc = cube_corner(face, corner);
  let up = vec3f(0.0, 1.0, 0.0);
  let world = s.pos + s.right * lc.x * s.width * 0.5 + up * lc.y * s.height * 0.5 + s.normal * lc.z * thick * 0.5;
  let ln = cube_normal(face);
  var o: VOut;
  o.normal = s.right * ln.x + up * ln.y + s.normal * ln.z;
  o.world = world;
  o.pos = frame.viewProj * vec4f(world, 1.0);
  // Distance culling: collapse far signs.
  let d = distance(s.pos, frame.camPos);
  if (d > 3500.0 || max(s.width, s.height) / d < 0.0015) {
    o.pos = vec4f(0.0, 0.0, -1.0, 1.0);
  }
  let uv = vec2f(f32(corner & 1u), f32((corner >> 1u) & 1u));
  o.uv = vec2f(uv.x, 1.0 - uv.y);
  o.sign = ii;
  o.face = select(1u, 0u, face <= 1u);
  o.clipCur = frame.viewProjNoJitter * vec4f(world, 1.0);
  o.clipPrev = frame.prevViewProj * vec4f(world, 1.0);
  return o;
}

fn glyph_at(s: Sign, i: u32) -> u32 {
  let w = select(s.glyphsHi, s.glyphsLo, i < 4u);
  return (w >> ((i & 3u) * 8u)) & 255u;
}

struct GOut {
  @location(0) color: vec4f,
  @location(1) normal: vec4f,
  @location(2) velocity: vec2f,
};

@fragment
fn fs(i: VOut) -> GOut {
  g_fragCoord = i.pos;
  let s = signs[i.sign];
  let kind = s.kindBits & 255u;
  let lightbox = (s.kindBits & 0x100u) != 0u;
  let n = (s.kindBits >> 16u) & 15u;
  let colA = unpack_color(s.colorA);
  let colB = unpack_color(s.colorB);
  let size = vec2f(s.width, s.height);
  let p = i.uv * size; // meters on the face
  var sf: Surface;
  sf.normal = normalize(i.normal);
  sf.albedo = vec3f(0.03);
  sf.roughness = 0.4;
  sf.metallic = 0.6;
  sf.reflectivity = 0.4;
  sf.emissive = vec3f(0.0);
  // Per-sign flicker (a few signs have failing tubes).
  let hs = hash_u(i.sign * 7919u + 13u);
  var flick = 1.0;
  if ((hs & 15u) == 0u) {
    let t = frame.time * (3.0 + f32(hs >> 28u));
    flick = select(1.0, 0.15, fract(sin(floor(t) * 12.9898) * 43758.5453) < 0.35);
  }
  if (i.face == 0u) {
    let vertical = kind == 1u || kind == 2u;
    let border = 0.35;
    let inner = p - vec2f(border);
    let isz = size - vec2f(border * 2.0);
    var text = 0.0;
    var glow = 0.0;
    if (kind == 3u) {
      // Abstract neon shapes: concentric rounded frames and an arrow.
      let q = (i.uv - 0.5) * size;
      let r = max(abs(q.x) - size.x * 0.5 + 1.0, abs(q.y) - size.y * 0.5 + 1.0);
      let ring = abs(fract(r / 1.6) - 0.5);
      text = smoothstep(0.12, 0.05, ring) * step(r, 0.0);
      glow = smoothstep(0.5, 0.0, ring) * step(r, 0.5);
    } else if (n > 0u) {
      // Lay out n glyphs along the sign, keeping cells square.
      let along = select(isz.x, isz.y, vertical);
      let across = select(isz.y, isz.x, vertical);
      let pitch = min(along / f32(n), across);
      let start = (along - pitch * f32(n)) * 0.5;
      let a = select(inner.x, inner.y, vertical) - start;
      let b = select(inner.y, inner.x, vertical) - (across - pitch) * 0.5;
      let gi = floor(a / pitch);
      if (gi >= 0.0 && gi < f32(n) && b >= 0.0 && b <= pitch) {
        let g = glyph_at(s, u32(gi));
        var guv = vec2f(fract(a / pitch), b / pitch);
        if (!vertical) { guv = vec2f(fract(a / pitch), b / pitch); }
        else { guv = vec2f(b / pitch, fract(a / pitch)); }
        let cell = vec2f(f32(g % 16u), f32(g / 16u));
        let t = textureSampleLevel(glyphTex, glyphSampler, (cell + guv) / 16.0, 0.0);
        text = t.r;
        glow = t.g;
      }
    }
    let frame_ = 1.0 - smoothstep(0.0, 0.25, min(min(p.x, size.x - p.x), min(p.y, size.y - p.y)));
    if (lightbox) {
      // Bright backlit panel with dark lettering.
      sf.emissive = colB * 2.2 * (1.0 - text * 0.9) * flick + colA * frame_ * 3.0;
    } else {
      sf.emissive = (colA * text * 10.0 + colA * glow * 2.0) * flick + colB * frame_ * 2.5;
      sf.albedo = vec3f(0.02);
    }
  } else {
    sf.albedo = vec3f(0.08);
  }
  var o: GOut;
  o.color = vec4f(shade_surface(sf, i.world), 1.0);
  o.normal = vec4f(encode_normal(sf.normal), sf.roughness, sf.reflectivity);
  let a = i.clipCur.xy / i.clipCur.w;
  let b = i.clipPrev.xy / i.clipPrev.w;
  o.velocity = (b - a) * vec2f(0.5, -0.5);
  return o;
}
