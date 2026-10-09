// City building segments: GPU-driven instanced draw.
#include "frame.wgsl"
#include "common.wgsl"

struct Segment {
  pos: vec3f, rotY: f32,
  size: vec3f, taper: f32,
  twist: f32, shape: u32, style: u32, seed: u32,
  colorA: u32, colorB: u32, flags: u32, floorH: f32,
};

struct Bucket { base: u32, lod: u32, _p0: u32, _p1: u32 };

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> segments: array<Segment>;
@group(1) @binding(1) var<storage, read> visible: array<u32>;
@group(1) @binding(2) var<uniform> bucket: Bucket;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) facade: vec2f,
  @builtin(instance_index) ii: u32,
};

struct Xf { world: vec3f, normal: vec3f, local: vec3f };

fn rot2(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
}

fn seg_transform(s: Segment, p: vec3f, n: vec3f) -> Xf {
  let h = p.y;
  let tp = mix(1.0, s.taper, h);
  var lp = vec3f(p.x * s.size.x * tp, p.y * s.size.y, p.z * s.size.z * tp);
  var ln = vec3f(n.x / s.size.x, n.y / s.size.y, n.z / s.size.z);
  if (abs(n.y) < 0.5) {
    let d0 = 0.5 * length(vec2f(n.x * s.size.x, n.z * s.size.z));
    ln = normalize(vec3f(normalize(ln.xz), 0.0).xzy);
    ln.y = d0 * (1.0 - s.taper) / s.size.y;
  }
  ln = normalize(ln);
  let tw = s.twist * h;
  lp = vec3f(rot2(lp.xz, tw), lp.y).xzy;
  ln = vec3f(rot2(ln.xz, tw), ln.y).xzy;
  let wp = vec3f(rot2(lp.xz, s.rotY), lp.y).xzy;
  let wn = vec3f(rot2(ln.xz, s.rotY), ln.y).xzy;
  var x: Xf;
  x.world = wp + s.pos;
  x.normal = wn;
  x.local = lp;
  return x;
}

fn segment_for(ii: u32) -> u32 {
  return visible[bucket.base + ii];
}

@vertex
fn vs_depth(v: VIn) -> @invariant @builtin(position) vec4f {
  let s = segments[segment_for(v.ii)];
  let x = seg_transform(s, v.pos, v.normal);
  return frame.viewProj * vec4f(x.world, 1.0);
}

struct VOut {
  @invariant @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) facade: vec2f,       // meters along wall, world height
  @location(3) @interpolate(flat) seg: u32,
  @location(4) clipCur: vec4f,
  @location(5) clipPrev: vec4f,
  @location(6) local: vec3f,
  @location(7) capUv: vec2f,
};

@vertex
fn vs_main(v: VIn) -> VOut {
  let si = segment_for(v.ii);
  let s = segments[si];
  let x = seg_transform(s, v.pos, v.normal);
  var o: VOut;
  o.pos = frame.viewProj * vec4f(x.world, 1.0);
  o.world = x.world;
  o.normal = x.normal;
  let tp = mix(1.0, s.taper, v.pos.y);
  o.facade = vec2f((v.facade.x * s.size.x + v.facade.y * s.size.z) * tp, x.world.y);
  o.capUv = v.facade * s.size.xz;
  o.seg = si;
  o.clipCur = frame.viewProjNoJitter * vec4f(x.world, 1.0);
  o.clipPrev = frame.prevViewProj * vec4f(x.world, 1.0);
  o.local = x.local;
  return o;
}

#include "facade.wgsl"

struct GOut {
  @location(0) color: vec4f,
  @location(1) normal: vec4f,   // oct normal xy, roughness, reflectivity
  @location(2) velocity: vec2f, // uv delta to previous frame
};

fn velocity_from(clipCur: vec4f, clipPrev: vec4f) -> vec2f {
  let a = clipCur.xy / clipCur.w;
  let b = clipPrev.xy / clipPrev.w;
  return (b - a) * vec2f(0.5, -0.5);
}

@fragment
fn fs_main(i: VOut, @builtin(front_facing) front: bool) -> GOut {
  // Derivatives must be taken in uniform control flow, before any branching.
  let fw = fwidth(i.facade);
  let s = segments[i.seg];
  let n = normalize(i.normal);
  let sh = shade_facade(s, i.world, n, i.facade, fw, i.local, i.capUv);
  var o: GOut;
  o.color = vec4f(sh.color, 1.0);
  o.normal = vec4f(encode_normal(sh.normal), sh.roughness, sh.reflectivity);
  o.velocity = velocity_from(i.clipCur, i.clipPrev);
  return o;
}
