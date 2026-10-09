// Giant ad screens mounted on facades, showing tiles of the ad atlas.
#include "scene.wgsl"
#include "lighting.wgsl"

struct Screen {
  pos: vec3f, tile: u32,
  right: vec3f, width: f32,
  normal: vec3f, height: f32,
};

@group(1) @binding(0) var<storage, read> screens: array<Screen>;
@group(1) @binding(1) var atlas: texture_2d<f32>;
@group(1) @binding(2) var atlasSampler: sampler;

const ATLAS_COLS = 4.0;
const ATLAS_ROWS = 8.0;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
  @location(2) @interpolate(flat) idx: u32,
  @location(3) clipCur: vec4f,
  @location(4) clipPrev: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let s = screens[ii];
  let c = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(1, 1), vec2f(0, 0), vec2f(1, 1), vec2f(0, 1))[vi];
  let world = s.pos + s.right * (c.x - 0.5) * s.width + vec3f(0.0, 1.0, 0.0) * (c.y - 0.5) * s.height;
  var o: VOut;
  o.pos = frame.viewProj * vec4f(world, 1.0);
  if (distance(s.pos, frame.camPos) > 5000.0) { o.pos = vec4f(0.0, 0.0, -1.0, 1.0); }
  o.world = world;
  o.uv = vec2f(c.x, 1.0 - c.y);
  o.idx = ii;
  o.clipCur = frame.viewProjNoJitter * vec4f(world, 1.0);
  o.clipPrev = frame.prevViewProj * vec4f(world, 1.0);
  return o;
}

struct GOut {
  @location(0) color: vec4f,
  @location(1) normal: vec4f,
  @location(2) velocity: vec2f,
};

@fragment
fn fs(i: VOut) -> GOut {
  g_fragCoord = i.pos;
  let s = screens[i.idx];
  // Cover-fit the 2:1 tile onto the screen's aspect.
  let aspect = s.width / s.height;
  var uv = i.uv;
  if (aspect < 2.0) {
    uv.x = 0.5 + (uv.x - 0.5) * aspect / 2.0;
  } else {
    uv.y = 0.5 + (uv.y - 0.5) * 2.0 / aspect;
  }
  let tile = vec2f(f32(s.tile % 4u), f32(s.tile / 4u));
  let margin = 0.01;
  let tuv = (tile + mix(vec2f(margin), vec2f(1.0 - margin), uv)) / vec2f(ATLAS_COLS, ATLAS_ROWS);
  var c = textureSample(atlas, atlasSampler, tuv).rgb;
  // LED subpixels up close.
  let px = i.uv * vec2f(s.width, s.height) / 0.25;
  let fw = fwidth(px);
  let det = 1.0 - smoothstep(0.3, 0.8, max(fw.x, fw.y));
  let sub = fract(px.x) * 3.0;
  let mask = vec3f(step(sub, 1.0), step(1.0, sub) * step(sub, 2.0), step(2.0, sub)) * 2.2;
  let rowGap = smoothstep(0.0, 0.15, fract(px.y)) * smoothstep(1.0, 0.85, fract(px.y));
  c *= mix(vec3f(1.0), mask * rowGap, det * 0.85);
  // Frame border.
  let edge = min(min(i.uv.x, 1.0 - i.uv.x) * s.width, min(i.uv.y, 1.0 - i.uv.y) * s.height);
  var sf: Surface;
  sf.normal = s.normal;
  sf.albedo = vec3f(0.02);
  sf.roughness = 0.15;
  sf.metallic = 0.0;
  sf.reflectivity = 0.5;
  sf.emissive = c * 3.0 * step(0.6, edge);
  var o: GOut;
  o.color = vec4f(shade_surface(sf, i.world), 1.0);
  o.normal = vec4f(encode_normal(s.normal), sf.roughness, sf.reflectivity);
  let a = i.clipCur.xy / i.clipCur.w;
  let b = i.clipPrev.xy / i.clipPrev.w;
  o.velocity = (b - a) * vec2f(0.5, -0.5);
  return o;
}

// Writes each screen's area light (average tile color from a low mip) into
// the dynamic light slots so the ads light their surroundings and the rain.
struct LightOut { pos: vec3f, radius: f32, color: vec3f, kind: u32, dir: vec3f, cosCone: f32 };
@group(0) @binding(0) var<storage, read_write> lightsOut: array<LightOut>;
@group(0) @binding(1) var<storage, read> screensC: array<Screen>;
@group(0) @binding(2) var atlasC: texture_2d<f32>;
@group(0) @binding(3) var<uniform> lightInfo: vec4u; // x = first slot, y = count

@compute @workgroup_size(64)
fn cs_lights(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= lightInfo.y) { return; }
  let s = screensC[i];
  let mips = textureNumLevels(atlasC);
  let lvl = mips - 4u; // 16x16 texels: 4x2 per tile
  let dims = textureDimensions(atlasC, lvl);
  let tile = vec2u(s.tile % 4u, s.tile / 4u);
  let per = dims / vec2u(4u, 8u);
  var acc = vec3f(0.0);
  for (var y = 0u; y < max(per.y, 1u); y++) {
    for (var x = 0u; x < max(per.x, 1u); x++) {
      acc += textureLoad(atlasC, tile * per + vec2u(x, y), lvl).rgb;
    }
  }
  acc /= f32(max(per.x * per.y, 1u));
  let size = sqrt(s.width * s.height);
  var L: LightOut;
  L.pos = s.pos + s.normal * size * 0.35;
  L.radius = size * 2.2;
  L.color = acc * 3.0 * min(size / 10.0, 6.0);
  L.kind = 0u;
  L.dir = vec3f(0.0, -1.0, 0.0);
  L.cosCone = -1.0;
  lightsOut[lightInfo.x + i] = L;
}
