// Froxel volumetrics: in-scattered light from the clustered lights (neon
// halos, headlight beams through the rain haze). Extinction is left to the
// analytic height fog; this adds the light.
#include "scene.wgsl"

const VX = 160u;
const VY = 90u;
const VZ = 64u;
const V_NEAR = 0.5;
const V_FAR = 1500.0;

@group(1) @binding(0) var injectOut: texture_storage_3d<rgba16float, write>;
@group(1) @binding(1) var injectIn: texture_3d<f32>;
@group(1) @binding(2) var integrateOut: texture_storage_3d<rgba16float, write>;
@group(1) @binding(3) var<uniform> strength: vec4f;

fn slice_dist(z: f32) -> f32 {
  return V_NEAR * pow(V_FAR / V_NEAR, z / f32(VZ));
}

fn ray_dir(uv: vec2f) -> vec3f {
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 1e-3, 1.0);
  let w = frame.invViewProj * ndc;
  return normalize(w.xyz / w.w - frame.camPos);
}

fn phase_hg(cosT: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosT, 1.5));
}

@compute @workgroup_size(8, 8, 1)
fn cs_inject(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= VX || gid.y >= VY || gid.z >= VZ) { return; }
  let j = hash31(gid.x, gid.y, gid.z + frame.frameIndex * 131u);
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(f32(VX), f32(VY));
  let dir = ray_dir(uv);
  let fwd = -vec3f(frame.view[0][2], frame.view[1][2], frame.view[2][2]);
  let viewZ = slice_dist(f32(gid.z) + j);
  let dist = viewZ / max(dot(dir, fwd), 0.1);
  let p = frame.camPos + dir * dist;
  // Density: height fog with drifting noise (rain mist).
  let wind = vec3f(frame.time * 3.0, -frame.time * 6.0, frame.time * 1.5);
  let n = vnoise3(p * 0.025 + wind * 0.02) * 0.7 + vnoise3(p * 0.09 + wind * 0.05) * 0.3;
  let density = frame.fogDensity * exp(-frame.fogHeightFalloff * max(p.y, 0.0) * 0.6) * (0.4 + 1.2 * n) * (1.0 + frame.rain);
  var light = vec3f(0.0);
  let ci = cluster_index(uv * frame.resolution, viewZ, frame.invResolution);
  let count = clusterCounts[ci];
  for (var k = 0u; k < count; k++) {
    let L = lights[clusterLights[ci * MAX_PER_CLUSTER + k]];
    let toL = L.pos - p;
    let d = length(toL);
    if (d >= L.radius) { continue; }
    let l = toL / max(d, 1e-3);
    var att = light_falloff(d, L.radius);
    if (L.kind == LIGHT_SPOT) {
      att *= smoothstep(L.cosCone, mix(L.cosCone, 1.0, 0.3), dot(-l, L.dir));
    }
    // Cap each light so beams aimed at the camera don't white out.
    light += min(L.color * att * phase_hg(dot(-dir, l), 0.35) * 4.0 * PI, vec3f(6.0));
  }
  textureStore(injectOut, gid, vec4f(light * density, density));
}

@compute @workgroup_size(8, 8, 1)
fn cs_integrate(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= VX || gid.y >= VY) { return; }
  var acc = vec3f(0.0);
  var trans = 1.0;
  var prevD = 0.0;
  for (var z = 0u; z < VZ; z++) {
    let s = textureLoad(injectIn, vec3u(gid.xy, z), 0);
    let d = slice_dist(f32(z) + 1.0);
    let dz = d - prevD;
    prevD = d;
    // Energy-conserving step (Hillaire 2015).
    let ext = max(s.a, 1e-7);
    let t = exp(-ext * dz);
    acc += trans * (s.rgb - s.rgb * t) / ext;
    trans *= t;
    textureStore(integrateOut, vec3u(gid.xy, z), vec4f(acc * strength.x, trans));
  }
}
