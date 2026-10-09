// Flying traffic. Vehicles move analytically along straight lanes over the
// avenues: position = origin + dir * ((s0 + speed * t) mod length). A
// compute pass culls them into a light-sprite list and a near-mesh list
// (indirect draws) and writes headlights of the closest into the dynamic
// light slots. Sprites draw as motion-stretched head/tail lights.
#include "scene.wgsl"
#include "lighting.wgsl"

struct Vehicle { lane: u32, s0: f32, speed: f32, style: u32 };
struct Lane { origin: vec3f, length: f32, dir: vec3f, _p: f32 };
struct Params {
  count: u32, lightBase: u32, lightCap: u32, maxVisible: u32,
  camVel: vec3f, shutter: f32,
  planes: array<vec4f, 5>,
};
struct Counters {
  spriteVertexCount: u32, spriteInstances: atomic<u32>, spriteFirstVertex: u32, spriteFirstInstance: u32,
  meshIndexCount: u32, meshInstances: atomic<u32>, meshFirstIndex: u32, meshBaseVertex: i32,
  meshFirstInstance: u32, lightCount: atomic<u32>, _p0: u32, _p1: u32,
};
struct LightOut { pos: vec3f, radius: f32, color: vec3f, kind: u32, dir: vec3f, cosCone: f32 };

@group(1) @binding(0) var<storage, read> vehicles: array<Vehicle>;
@group(1) @binding(1) var<storage, read> lanes: array<Lane>;
@group(1) @binding(2) var<uniform> P: Params;
// lists[0..maxVisible) = sprites, lists[maxVisible..) = meshes.
@group(1) @binding(3) var<storage, read_write> lists: array<u32>;
@group(1) @binding(4) var<storage, read_write> counters: Counters;
@group(1) @binding(5) var<storage, read_write> lightsOut: array<LightOut>;
// Read-only view of the lists for the render pipelines.
@group(1) @binding(6) var<storage, read> listsRO: array<u32>;

struct VState { pos: vec3f, dir: vec3f };

fn vehicle_state(v: Vehicle, t: f32) -> VState {
  let L = lanes[v.lane];
  let s = (v.s0 + v.speed * t) % L.length;
  var o: VState;
  o.pos = L.origin + L.dir * s;
  // A gentle bob.
  o.pos.y += sin(t * 1.1 + v.s0) * 0.6;
  o.dir = L.dir;
  return o;
}

fn vehicle_color(style: u32) -> vec3f {
  let k = style & 7u;
  switch k {
    case 0u: { return vec3f(0.9, 0.7, 0.05); }   // taxi
    case 1u: { return vec3f(0.6, 0.6, 0.65); }
    case 2u: { return vec3f(0.05, 0.05, 0.06); }
    case 3u: { return vec3f(0.4, 0.05, 0.05); }
    case 4u: { return vec3f(0.1, 0.2, 0.35); }
    default: { return vec3f(0.2, 0.22, 0.25); }
  }
}

@compute @workgroup_size(64)
fn cs_cull(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let v = vehicles[i];
  let st = vehicle_state(v, frame.time);
  for (var p = 0; p < 5; p++) {
    if (dot(P.planes[p].xyz, st.pos) + P.planes[p].w < -6.0) { return; }
  }
  let d = distance(st.pos, frame.camPos);
  if (d > 4000.0) { return; }
  let si = atomicAdd(&counters.spriteInstances, 1u);
  if (si < P.maxVisible) { lists[si] = i; }
  if (d < 450.0) {
    let mi = atomicAdd(&counters.meshInstances, 1u);
    if (mi < P.maxVisible) { lists[P.maxVisible + mi] = i; }
  }
  if (d < 260.0) {
    let li = atomicAdd(&counters.lightCount, 1u);
    if (li < P.lightCap) {
      var L: LightOut;
      L.pos = st.pos + st.dir * 3.2 + vec3f(0.0, 0.3, 0.0);
      L.radius = 45.0;
      L.color = vec3f(9.0, 8.5, 7.5);
      L.kind = 1u;
      L.dir = normalize(st.dir + vec3f(0.0, -0.08, 0.0));
      L.cosCone = 0.88;
      lightsOut[P.lightBase + li] = L;
    }
  }
}

// --- Light sprites --------------------------------------------------------

struct SOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
  @location(1) local: vec2f,
};

@vertex
fn vs_sprite(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SOut {
  let v = vehicles[listsRO[ii]];
  let st = vehicle_state(v, frame.time);
  let light = vi / 6u; // 0,1 head; 2,3 tail
  let c = array<vec2f, 6>(vec2f(0, -1), vec2f(1, -1), vec2f(1, 1), vec2f(0, -1), vec2f(1, 1), vec2f(0, 1))[vi % 6u];
  let side = cross(st.dir, vec3f(0.0, 1.0, 0.0));
  let head = light < 2u;
  let sx = select(-0.7, 0.7, (light & 1u) == 1u);
  let base = st.pos + side * sx + st.dir * select(-2.6, 2.6, head) + vec3f(0.0, 0.5, 0.0);
  // Motion streak relative to the camera.
  let vel = st.dir * v.speed - P.camVel;
  let a = base;
  let b = base - vel * P.shutter;
  let ca = frame.viewProj * vec4f(a, 1.0);
  let cb = frame.viewProj * vec4f(b, 1.0);
  var o: SOut;
  if (ca.w < 0.5 || cb.w < 0.5) { o.pos = vec4f(0.0, 0.0, -1.0, 1.0); return o; }
  let sa = ca.xy / ca.w;
  let sb = cb.xy / cb.w;
  var dir = (sb - sa) * frame.resolution;
  let len = length(dir);
  dir = select(vec2f(1.0, 0.0), dir / len, len > 1e-3);
  let perp = vec2f(-dir.y, dir.x);
  let worldR = 0.35 * frame.resolution.y / (2.0 * frame.tanHalfFov.y * ca.w);
  let rpx = max(worldR, 1.2);
  let s = mix(sa, sb, c.x);
  let w = mix(ca.w, cb.w, c.x);
  let z = mix(ca.z / ca.w, cb.z / cb.w, c.x);
  let off = (perp * c.y * rpx + dir * (c.x * 2.0 - 1.0) * rpx) * frame.invResolution;
  o.pos = vec4f((s + off) * w, z * w, w);
  // Headlights face forward; tail lights face back.
  let toCam = normalize(frame.camPos - base);
  let facing = dot(toCam, st.dir) * select(-1.0, 1.0, head);
  let beam = 0.12 + 0.88 * pow(saturate(facing), 3.0);
  let col = select(vec3f(9.0, 0.35, 0.15), vec3f(10.0, 9.0, 7.5), head);
  let energy = (worldR * worldR) / (rpx * rpx) * clamp(6.0 / max(len, 1.0), 0.2, 1.0);
  o.color = col * beam * min(energy * 4.0, 1.0) * 1.5 * exp(-ca.w * 0.00035);
  o.local = vec2f(c.y, c.x * 2.0 - 1.0);
  return o;
}

@fragment
fn fs_sprite(i: SOut) -> @location(0) vec4f {
  let r = length(i.local * vec2f(1.0, 0.5));
  let a = smoothstep(1.0, 0.0, r);
  return vec4f(i.color * a * a, 0.0);
}

// --- Near meshes (instanced NURBS vehicle) --------------------------------

struct Material {
  color: vec3f, kind: f32,
  emissive: vec3f, roughness: f32,
  metallic: f32, param: f32, _p0: f32, _p1: f32,
};
@group(2) @binding(0) var<storage, read> materials: array<Material>;

struct MOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) @interpolate(flat) mat: u32,
  @location(3) @interpolate(flat) style: u32,
  @location(4) clipCur: vec4f,
  @location(5) clipPrev: vec4f,
};

@vertex
fn vs_mesh(
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) mat: u32,
  @builtin(instance_index) ii: u32,
) -> MOut {
  let v = vehicles[listsRO[P.maxVisible + ii]];
  let st = vehicle_state(v, frame.time);
  let prev = vehicle_state(v, frame.time - max(frame.dt, 1e-4));
  // Model space: nose toward -Z. Map -Z to the lane direction.
  let fwd = st.dir;
  let right = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, fwd);
  let local = right * pos.x + up * pos.y - fwd * pos.z;
  let w = st.pos + local;
  var o: MOut;
  o.pos = frame.viewProj * vec4f(w, 1.0);
  o.world = w;
  o.normal = right * normal.x + up * normal.y - fwd * normal.z;
  o.mat = mat;
  o.style = v.style;
  o.clipCur = frame.viewProjNoJitter * vec4f(w, 1.0);
  o.clipPrev = frame.prevViewProj * vec4f(prev.pos + local, 1.0);
  return o;
}

struct GOut {
  @location(0) color: vec4f,
  @location(1) normal: vec4f,
  @location(2) velocity: vec2f,
};

@fragment
fn fs_mesh(i: MOut, @builtin(front_facing) front: bool) -> GOut {
  g_fragCoord = i.pos;
  let m = materials[i.mat];
  var n = normalize(i.normal);
  if (!front) { n = -n; }
  let kind = u32(m.kind);
  var sf: Surface;
  sf.normal = n;
  sf.albedo = select(m.color, vehicle_color(i.style), kind == 1u);
  sf.roughness = m.roughness;
  sf.metallic = m.metallic;
  sf.reflectivity = 0.6;
  sf.emissive = select(vec3f(0.0), m.emissive, kind == 3u);
  if (kind == 2u) {
    // Glass on traffic: dark tinted, reflective.
    sf.albedo = vec3f(0.01);
    sf.roughness = 0.05;
    sf.reflectivity = 0.9;
  }
  if (kind == 4u) { sf.emissive = vec3f(0.2, 0.5, 0.8); }
  var o: GOut;
  o.color = vec4f(shade_surface(sf, i.world), 1.0);
  o.normal = vec4f(encode_normal(n), sf.roughness, sf.reflectivity);
  let a = i.clipCur.xy / i.clipCur.w;
  let b = i.clipPrev.xy / i.clipPrev.w;
  o.velocity = (b - a) * vec2f(0.5, -0.5);
  return o;
}
