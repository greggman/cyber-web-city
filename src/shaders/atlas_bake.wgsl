// Bakes the procedural material atlas (ART_BIBLE.md 12.1 D): tileable
// micro-surface for facades and kit meshes. One layer per material:
//   r = height (0..1), g/b = tangent-space normal xy * 0.5 + 0.5,
//   a = roughness offset (0.5 = none).
// Normals come from central differences of the height function at the
// layer's physical scale (meters per tile, depth in meters).

@group(0) @binding(0) var dst: texture_storage_2d_array<rgba8unorm, write>;

const SIZE = 256.0;

fn hash2i(p: vec2i, s: u32) -> f32 {
  var h = (u32(p.x) * 0x8da6b343u) ^ (u32(p.y) * 0xd8163841u) ^ (s * 0xcb1ab31fu);
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return f32(h >> 8u) / 16777216.0;
}

// Value noise that tiles with `period` cells across uv in [0, 1).
fn pnoise(uv: vec2f, period: i32, s: u32) -> f32 {
  let p = uv * f32(period);
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let w = vec2i(period);
  let a = hash2i((i + vec2i(0, 0)) % w, s);
  let b = hash2i((i + vec2i(1, 0)) % w, s);
  let c = hash2i((i + vec2i(0, 1)) % w, s);
  let d = hash2i((i + vec2i(1, 1)) % w, s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(uv: vec2f, period: i32, s: u32) -> f32 {
  var v = 0.0;
  var amp = 0.5;
  var per = period;
  for (var k = 0u; k < 4u; k++) {
    v += amp * pnoise(uv, per, s + k * 17u);
    per *= 2;
    amp *= 0.5;
  }
  return v / 0.9375;
}

// Height (0..1) and roughness offset per layer at uv (tile space).
fn material(layer: u32, uv_in: vec2f) -> vec2f {
  let uv = fract(uv_in);
  switch layer {
    case 0u: {
      // Concrete: low-frequency waviness, aggregate, scattered pits.
      var h = 0.55 + 0.25 * (fbm(uv, 6, 1u) - 0.5) + 0.2 * (fbm(uv, 48, 2u) - 0.5);
      let cell = vec2i(floor(uv * 64.0));
      if (hash2i(cell, 3u) < 0.08) {
        let c = (vec2f(cell) + 0.5 + (vec2f(hash2i(cell, 4u), hash2i(cell, 5u)) - 0.5) * 0.5) / 64.0;
        h -= 0.45 * smoothstep(0.006, 0.0, length(uv - c));
      }
      return vec2f(h, 0.5 + 0.25 * (fbm(uv, 4, 6u) - 0.5));
    }
    case 1u: {
      // Mosaic tile: 20 x 20 tiles with grout, random tilt and chips.
      let p = uv * 20.0;
      let id = vec2i(floor(p));
      let f = fract(p);
      let grout = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
      let tilt = (vec2f(hash2i(id, 7u), hash2i(id, 8u)) - 0.5) * 0.12;
      var h = 0.7 + dot(f - 0.5, tilt);
      if (hash2i(id, 9u) < 0.06 && f.x + f.y > 1.5) { h -= 0.25; }
      h = mix(0.15, h, smoothstep(0.03, 0.06, grout));
      return vec2f(h, select(0.35, 0.45, grout < 0.05));
    }
    case 2u: {
      // Metal panel: brushed streaks, soft dents, rust blooms (rougher).
      let streak = pnoise(vec2f(uv.x * 1.0, uv.y * 64.0), 32, 10u);
      let dents = fbm(uv, 3, 11u);
      let rust = smoothstep(0.62, 0.8, fbm(uv, 8, 12u));
      let h = 0.5 + 0.08 * (streak - 0.5) + 0.3 * (dents - 0.5) - 0.1 * rust;
      return vec2f(h, 0.5 + 0.35 * rust + 0.05 * (streak - 0.5));
    }
    case 3u: {
      // Rust and grime for kit pieces.
      let r = fbm(uv, 5, 13u);
      let flake = smoothstep(0.55, 0.75, fbm(uv, 24, 14u));
      return vec2f(0.5 + 0.2 * (r - 0.5) - 0.15 * flake, 0.5 + 0.4 * smoothstep(0.45, 0.75, r));
    }
    case 4u: {
      // Basalt: fine speckle, very subtle.
      let sp = pnoise(uv, 96, 15u);
      return vec2f(0.5 + 0.12 * (sp - 0.5) + 0.1 * (fbm(uv, 8, 16u) - 0.5), 0.5 + 0.1 * (sp - 0.5));
    }
    case 5u: {
      // Board-formed concrete: 12 boards per tile with wood grain.
      let b = uv.y * 12.0;
      let id = i32(floor(b));
      let fb = fract(b);
      let grain = pnoise(vec2f(uv.x * 0.5 + f32(id) * 0.37, fb * 0.05 + f32(id) * 0.1), 16, 17u);
      let edge = smoothstep(0.0, 0.06, fb) * smoothstep(1.0, 0.94, fb);
      let h = 0.55 + 0.15 * (grain - 0.5) + 0.1 * (hash2i(vec2i(id, 0), 18u) - 0.5) - 0.2 * (1.0 - edge);
      return vec2f(h, 0.5 + 0.15 * (grain - 0.5));
    }
    default: {
      return vec2f(0.5, 0.5);
    }
  }
}

// Depth in meters of the height range and meters per tile, per layer.
fn depth_of(layer: u32) -> f32 {
  switch layer {
    case 1u: { return 0.003; }
    case 2u: { return 0.006; }
    case 5u: { return 0.006; }
    default: { return 0.004; }
  }
}

fn tile_meters(layer: u32) -> f32 {
  switch layer {
    case 1u: { return 1.0; }
    case 2u: { return 3.0; }
    case 5u: { return 1.8; }
    default: { return 2.0; }
  }
}

@compute @workgroup_size(8, 8, 1)
fn cs_bake(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= 256u || gid.y >= 256u) { return; }
  let layer = gid.z;
  let uv = (vec2f(gid.xy) + 0.5) / SIZE;
  let e = 1.0 / SIZE;
  let m = material(layer, uv);
  let hx = material(layer, uv + vec2f(e, 0.0)).x - material(layer, uv - vec2f(e, 0.0)).x;
  let hy = material(layer, uv + vec2f(0.0, e)).x - material(layer, uv - vec2f(0.0, e)).x;
  // Slopes in meters per meter: height range * depth over the texel step.
  let step = 2.0 * e * tile_meters(layer);
  let slope = vec2f(hx, hy) * depth_of(layer) / step;
  // Stored as the tangent-space normal's xy (tilt), clamped to +-1.
  let n = normalize(vec3f(-slope, 1.0));
  textureStore(dst, gid.xy, layer, vec4f(clamp(m.x, 0.0, 1.0), n.xy * 0.5 + 0.5, clamp(m.y, 0.0, 1.0)));
}
