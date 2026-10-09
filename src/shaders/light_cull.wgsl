// Light culling: (1) frustum/distance cull every light into a compact
// visible list, (2) per screen tile, test visible lights against the tile's
// side planes and append them to every depth slice their sphere overlaps.
#include "frame.wgsl"
#include "common.wgsl"
#include "clusters.wgsl"

struct CullInfo {
  lightCount: u32,
  maxVisible: u32,
  maxDistance: f32,
  _p: u32,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> info: CullInfo;
@group(0) @binding(2) var<storage, read> lights: array<Light>;
@group(0) @binding(3) var<storage, read_write> visible: array<u32>;
@group(0) @binding(4) var<storage, read_write> visibleCount: atomic<u32>;
@group(0) @binding(5) var<storage, read_write> clusterCounts: array<u32>;
@group(0) @binding(6) var<storage, read_write> clusterLights: array<u32>;

fn view_pos(p: vec3f) -> vec3f {
  return (frame.view * vec4f(p, 1.0)).xyz;
}

@compute @workgroup_size(64)
fn cs_visible(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= info.lightCount) { return; }
  let L = lights[i];
  if (L.radius <= 0.0) { return; }
  let vp = view_pos(L.pos);
  let z = -vp.z;
  if (z < -L.radius || z - L.radius > info.maxDistance) { return; }
  // Side planes of the view frustum in view space.
  let tx = frame.tanHalfFov.x;
  let ty = frame.tanHalfFov.y;
  let nx = normalize(vec2f(1.0, tx));
  let ny = normalize(vec2f(1.0, ty));
  if (nx.x * abs(vp.x) - nx.y * z > L.radius) { return; }
  if (ny.x * abs(vp.y) - ny.y * z > L.radius) { return; }
  // Skip lights too small to matter at this distance.
  if (L.radius / max(z, 1.0) < 0.004) { return; }
  let slot = atomicAdd(&visibleCount, 1u);
  if (slot < info.maxVisible) {
    visible[slot] = i;
  }
}

var<workgroup> sliceCount: array<atomic<u32>, SLICES>;
var<workgroup> tilePlanes: array<vec4f, 4>;

@compute @workgroup_size(64)
fn cs_cluster(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let tile = wg.x;
  let tx = tile % TILES_X;
  let ty = tile / TILES_X;
  if (li < SLICES) {
    atomicStore(&sliceCount[li], 0u);
  }
  if (li == 0u) {
    // Tile side planes through the eye (view space, -Z forward).
    let x0 = (f32(tx) / f32(TILES_X)) * 2.0 - 1.0;
    let x1 = (f32(tx + 1u) / f32(TILES_X)) * 2.0 - 1.0;
    let y0 = 1.0 - (f32(ty + 1u) / f32(TILES_Y)) * 2.0;
    let y1 = 1.0 - (f32(ty) / f32(TILES_Y)) * 2.0;
    let T = frame.tanHalfFov;
    // Points on the z = -1 plane.
    let l = vec3f(x0 * T.x, 0.0, -1.0);
    let r = vec3f(x1 * T.x, 0.0, -1.0);
    let b = vec3f(0.0, y0 * T.y, -1.0);
    let t = vec3f(0.0, y1 * T.y, -1.0);
    // Inward-facing normals.
    tilePlanes[0] = vec4f(normalize(cross(l, vec3f(0.0, 1.0, 0.0))) * -1.0, 0.0);
    tilePlanes[1] = vec4f(normalize(cross(r, vec3f(0.0, 1.0, 0.0))), 0.0);
    tilePlanes[2] = vec4f(normalize(cross(b, vec3f(1.0, 0.0, 0.0))), 0.0);
    tilePlanes[3] = vec4f(normalize(cross(t, vec3f(1.0, 0.0, 0.0))) * -1.0, 0.0);
  }
  workgroupBarrier();
  let n = min(atomicLoad(&visibleCount), info.maxVisible);
  for (var k = li; k < n; k += 64u) {
    let idx = visible[k];
    let L = lights[idx];
    let vp = view_pos(L.pos);
    var inside = true;
    for (var p = 0; p < 4; p++) {
      if (dot(tilePlanes[p].xyz, vp) < -L.radius) { inside = false; }
    }
    if (!inside) { continue; }
    let z = -vp.z;
    let s0 = cluster_slice(z - L.radius);
    let s1 = cluster_slice(z + L.radius);
    for (var s = s0; s <= s1; s++) {
      let c = atomicAdd(&sliceCount[s], 1u);
      if (c < MAX_PER_CLUSTER) {
        clusterLights[((tile * SLICES) + s) * MAX_PER_CLUSTER + c] = idx;
      }
    }
  }
  workgroupBarrier();
  if (li < SLICES) {
    clusterCounts[tile * SLICES + li] = min(atomicLoad(&sliceCount[li]), MAX_PER_CLUSTER);
  }
}

@compute @workgroup_size(1)
fn cs_reset() {
  atomicStore(&visibleCount, 0u);
}
