// City building segments: GPU-driven instanced draw.
#include "scene.wgsl"

#include "segment.wgsl"

struct Bucket { base: u32, lod: u32, _p0: u32, _p1: u32 };

@group(1) @binding(0) var<storage, read> segments: array<Segment>;
@group(1) @binding(1) var<storage, read> visible: array<u32>;
@group(1) @binding(2) var<uniform> bucket: Bucket;

// SSAO (half resolution), sampled in screen space.
@group(2) @binding(0) var aoTex: texture_2d<f32>;
@group(2) @binding(1) var aoSampler: sampler;
// Material atlas (render/materialAtlas.ts).
@group(2) @binding(2) var atlasTex: texture_2d_array<f32>;
@group(2) @binding(3) var atlasSampler: sampler;


struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) facade: vec2f,
  @builtin(instance_index) ii: u32,
};

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
  // Base width of this face (0 on round shapes) and the taper scale here.
  @location(8) face: vec2f,
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
  var faceW = 0.0;
  if (s.shape <= 1u && abs(v.normal.y) < 0.5) {
    faceW = select(s.size.z, s.size.x, abs(v.normal.z) > 0.5);
  }
  o.face = vec2f(faceW, tp);
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
  g_fragCoord = i.pos;
  g_ao = textureSampleLevel(aoTex, aoSampler, i.pos.xy * frame.invResolution, 0.0).r;
  // Derivatives must be taken in uniform control flow, before any branching.
  let fw = fwidth(i.facade);
  let grads = vec4f(dpdx(i.facade), dpdy(i.facade));
  let capGrads = vec4f(dpdx(i.capUv), dpdy(i.capUv));
  let s = segments[i.seg];
  let n = normalize(i.normal);
  let sh = shade_facade(s, i.world, n, i.facade, fw, i.local, i.capUv, i.face, grads, capGrads);
  var o: GOut;
  o.color = vec4f(sh.color, 1.0);
  if (frame.debugView == 7u) {
    // Style ids as distinct colors (0 glass .. 10 ground), shape in alpha-ish brightness.
    let pal = array<vec3f, 11>(vec3f(0.2, 0.5, 1.0), vec3f(0.9, 0.6, 0.3), vec3f(0.5, 0.5, 0.5), vec3f(1.0, 0.0, 1.0),
      vec3f(0.6, 0.3, 0.1), vec3f(0.1, 0.1, 0.1), vec3f(0.0, 1.0, 0.0), vec3f(1.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0),
      vec3f(0.0, 1.0, 1.0), vec3f(0.3, 0.3, 0.3));
    o.color = vec4f(pal[min(s.style, 10u)] * (0.4 + 0.15 * f32(s.shape)) * (0.5 + 0.5 * max(n.y, 0.0) + 0.3 * f32((s.flags & 1u) != 0u)), 1.0);
  }
  o.normal = vec4f(encode_normal(sh.normal), sh.roughness, sh.reflectivity);
  o.velocity = velocity_from(i.clipCur, i.clipPrev);
  return o;
}
