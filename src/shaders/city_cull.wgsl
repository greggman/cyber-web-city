// GPU-driven culling for building segments: frustum + Hi-Z occlusion +
// small-object culling, LOD selection, and compaction into per-mesh buckets
// whose instance counts feed drawIndexedIndirect.

struct Segment {
  pos: vec3f, rotY: f32,
  size: vec3f, taper: f32,
  twist: f32, shape: u32, style: u32, seed: u32,
  colorA: u32, colorB: u32, flags: u32, floorH: f32,
};

struct CullParams {
  planes: array<vec4f, 5>,
  camPos: vec3f, count: u32,
  pixelScale: f32,      // screen height / (2 * tan(fov/2))
  minPixels: f32,       // cull objects smaller than this on screen
  useHiz: u32,
  hizMips: u32,
  prevViewProj: mat4x4f,
  hizSize: vec2f, _p0: vec2f,
};

struct ShapeInfo {
  firstBucket: u32, numLods: u32, _p0: u32, _p1: u32,
  ratios: vec4f,
};

struct DrawArgs {
  indexCount: u32,
  instanceCount: atomic<u32>,
  firstIndex: u32,
  baseVertex: i32,
  firstInstance: u32,
};

@group(0) @binding(0) var<uniform> params: CullParams;
@group(0) @binding(1) var<storage, read> segments: array<Segment>;
@group(0) @binding(2) var<storage, read> shapes: array<ShapeInfo>;
@group(0) @binding(3) var<storage, read_write> args: array<DrawArgs>;
@group(0) @binding(4) var<storage, read_write> visible: array<u32>;
@group(0) @binding(5) var<storage, read> bucketBase: array<u32>;
@group(0) @binding(6) var hiz: texture_2d<f32>;

// Returns true if the box (center c, half extents e) is fully hidden behind
// the previous frame's Hi-Z (reversed-Z: larger depth = closer).
fn occluded(c: vec3f, e: vec3f) -> bool {
  var mn = vec2f(1e9);
  var mx = vec2f(-1e9);
  var maxDepth = 0.0;
  for (var i = 0u; i < 8u; i++) {
    let corner = c + e * vec3f(
      select(-1.0, 1.0, (i & 1u) != 0u),
      select(-1.0, 1.0, (i & 2u) != 0u),
      select(-1.0, 1.0, (i & 4u) != 0u));
    let clip = params.prevViewProj * vec4f(corner, 1.0);
    if (clip.w <= 0.1) {
      return false; // crosses the camera plane
    }
    let ndc = clip.xyz / clip.w;
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    mn = min(mn, uv);
    mx = max(mx, uv);
    maxDepth = max(maxDepth, ndc.z);
  }
  mn = clamp(mn, vec2f(0.0), vec2f(1.0));
  mx = clamp(mx, vec2f(0.0), vec2f(1.0));
  if (any(mx <= mn)) {
    return false;
  }
  let sizePx = (mx - mn) * params.hizSize;
  let mip = clamp(u32(ceil(log2(max(max(sizePx.x, sizePx.y), 1.0)))), 0u, params.hizMips - 1u);
  let dims = vec2f(textureDimensions(hiz, mip));
  let p0 = vec2i(mn * dims);
  let p1 = min(vec2i(mx * dims), vec2i(dims) - 1);
  // Hi-Z stores the minimum (farthest) depth. Sample up to a 3x3 footprint.
  var farthest = 1.0;
  for (var y = p0.y; y <= min(p1.y, p0.y + 2); y++) {
    for (var x = p0.x; x <= min(p1.x, p0.x + 2); x++) {
      farthest = min(farthest, textureLoad(hiz, vec2i(x, y), mip).r);
    }
  }
  if (p1.x - p0.x > 2 || p1.y - p0.y > 2) {
    return false;
  }
  return maxDepth < farthest;
}

@compute @workgroup_size(64)
fn cs_cull(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) {
    return;
  }
  let s = segments[i];
  let grow = max(1.0, s.taper);
  let hx = 0.5 * length(s.size.xz) * grow;
  let center = s.pos + vec3f(0.0, s.size.y * 0.5, 0.0);
  let radius = length(vec2f(hx, s.size.y * 0.5));
  for (var p = 0; p < 5; p++) {
    let pl = params.planes[p];
    if (dot(pl.xyz, center) + pl.w < -radius) {
      return;
    }
  }
  let dist = max(distance(center, params.camPos) - radius, 1.0);
  // Projected size of the smaller horizontal dimension (thin spires still count).
  let ratio = radius / dist;
  let minDim = max(min(s.size.x, s.size.z), 4.0);
  if (minDim / dist * params.pixelScale < params.minPixels) {
    return;
  }
  if (params.useHiz != 0u && occluded(center, vec3f(hx, s.size.y * 0.5, hx))) {
    return;
  }
  let info = shapes[s.shape];
  var lod = info.numLods - 1u;
  for (var l = 0u; l < info.numLods; l++) {
    if (ratio >= info.ratios[l]) {
      lod = l;
      break;
    }
  }
  let b = info.firstBucket + lod;
  let slot = atomicAdd(&args[b].instanceCount, 1u);
  visible[bucketBase[b] + slot] = i;
}
