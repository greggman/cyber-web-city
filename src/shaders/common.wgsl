const PI = 3.14159265359;
const TAU = 6.28318530718;

fn saturate(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
fn saturate3(x: vec3f) -> vec3f { return clamp(x, vec3f(0.0), vec3f(1.0)); }

// Integer hash (lowbias32).
fn hash_u(x_in: u32) -> u32 {
  var x = x_in;
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
fn hash2_u(a: u32, b: u32) -> u32 { return hash_u(a ^ hash_u(b + 0x9e3779b9u)); }
fn hash3_u(a: u32, b: u32, c: u32) -> u32 { return hash_u(a ^ hash2_u(b, c)); }
fn u2f(x: u32) -> f32 { return f32(x >> 8u) * (1.0 / 16777216.0); }
// A [0,1) value from other bits of a hash: rotates them to the top
// (u2f(x >> n) would only reach [0, 2^-n)).
fn u2f_rot(x: u32, n: u32) -> f32 { return u2f((x >> n) | (x << (32u - n))); }
fn hash11(a: u32) -> f32 { return u2f(hash_u(a)); }
fn hash21(a: u32, b: u32) -> f32 { return u2f(hash2_u(a, b)); }
fn hash31(a: u32, b: u32, c: u32) -> f32 { return u2f(hash3_u(a, b, c)); }
fn hashf2(p: vec2f) -> f32 { return hash21(bitcast<u32>(i32(floor(p.x))), bitcast<u32>(i32(floor(p.y)))); }

fn unpack_color(c: u32) -> vec3f { return unpack4x8unorm(c).rgb; }

// Value noise.
fn vnoise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hashf2(i);
  let b = hashf2(i + vec2f(1.0, 0.0));
  let c = hashf2(i + vec2f(0.0, 1.0));
  let d = hashf2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn fbm2(p_in: vec2f, octaves: i32) -> f32 {
  var p = p_in;
  var a = 0.5;
  var s = 0.0;
  for (var i = 0; i < octaves; i++) {
    s += a * vnoise2(p);
    p = p * 2.03 + vec2f(17.1, 3.7);
    a *= 0.5;
  }
  return s;
}
fn hash3f(p: vec3f) -> f32 {
  return hash31(bitcast<u32>(i32(floor(p.x))), bitcast<u32>(i32(floor(p.y))), bitcast<u32>(i32(floor(p.z))));
}
fn vnoise3(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3f(i), hash3f(i + vec3f(1, 0, 0)), u.x),
        mix(hash3f(i + vec3f(0, 1, 0)), hash3f(i + vec3f(1, 1, 0)), u.x), u.y),
    mix(mix(hash3f(i + vec3f(0, 0, 1)), hash3f(i + vec3f(1, 0, 1)), u.x),
        mix(hash3f(i + vec3f(0, 1, 1)), hash3f(i + vec3f(1, 1, 1)), u.x), u.y),
    u.z);
}

fn luminance(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// Octahedral normal encoding.
fn oct_wrap(v: vec2f) -> vec2f {
  return (1.0 - abs(v.yx)) * select(vec2f(-1.0), vec2f(1.0), v.xy >= vec2f(0.0));
}
fn encode_normal(n_in: vec3f) -> vec2f {
  var n = n_in / (abs(n_in.x) + abs(n_in.y) + abs(n_in.z));
  let xy = select(oct_wrap(n.xy), n.xy, n.z >= 0.0);
  return xy;
}
fn decode_normal(f: vec2f) -> vec3f {
  var n = vec3f(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  let t = saturate(-n.z);
  n = vec3f(n.x + select(t, -t, n.x >= 0.0), n.y + select(t, -t, n.y >= 0.0), n.z);
  return normalize(n);
}

// Reconstruct world position from reversed-Z depth and uv (0..1, y down).
fn world_from_depth(uv: vec2f, depth: f32, invViewProj: mat4x4f) -> vec3f {
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let w = invViewProj * ndc;
  return w.xyz / w.w;
}

// Linear view distance from reversed-Z infinite depth.
fn linear_depth(depth: f32, near: f32) -> f32 {
  return near / max(depth, 1e-7);
}

// Fullscreen triangle.
struct FsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
fn fullscreen_vertex(vi: u32) -> FsOut {
  var o: FsOut;
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
