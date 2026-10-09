// Cable bundles (catenary tubes built in the vertex shader) and hanging
// paper lanterns.
#include "scene.wgsl"
#include "lighting.wgsl"

struct Cable { a: vec3f, radius: f32, b: vec3f, sag: f32 };
struct Lantern { pos: vec3f, size: f32, color: vec3f, _p: f32 };

@group(1) @binding(0) var<storage, read> cables: array<Cable>;
@group(1) @binding(1) var<storage, read> lanterns: array<Lantern>;

const SEGS = 12u;
const SIDES = 4u;
const MAX_DIST = 700.0;

fn cable_point(c: Cable, t: f32) -> vec3f {
  return mix(c.a, c.b, t) - vec3f(0.0, c.sag * 4.0 * t * (1.0 - t), 0.0);
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) @interpolate(flat) kind: u32,
  @location(3) color: vec3f,
  @location(4) local: vec3f,
};

@vertex
fn vs_cable(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let c = cables[ii];
  // 6 vertices per quad, SIDES quads per segment.
  let q = vi / 6u;
  let corner = array<vec2u, 6>(vec2u(0, 0), vec2u(1, 0), vec2u(1, 1), vec2u(0, 0), vec2u(1, 1), vec2u(0, 1))[vi % 6u];
  let seg = q / SIDES;
  let side = (q % SIDES) + corner.x;
  let t = (f32(seg) + f32(corner.y)) / f32(SEGS);
  let p = cable_point(c, t);
  let tan = normalize(cable_point(c, min(t + 0.01, 1.0)) - cable_point(c, max(t - 0.01, 0.0)));
  let u = normalize(cross(tan, vec3f(0.0, 1.0, 0.0)));
  let v = cross(u, tan);
  let a = f32(side) / f32(SIDES) * TAU;
  let n = u * cos(a) + v * sin(a);
  let dist = distance(p, frame.camPos);
  // Keep at least ~0.8 px wide so distant cables don't break up.
  let pxSize = 2.0 * frame.tanHalfFov.y * dist / frame.resolution.y;
  let r = max(c.radius, pxSize * 0.4);
  var o: VOut;
  let w = p + n * r;
  o.pos = frame.viewProj * vec4f(w, 1.0);
  if (distance((c.a + c.b) * 0.5, frame.camPos) > MAX_DIST) { o.pos = vec4f(0.0, 0.0, -1.0, 1.0); }
  o.world = w;
  o.normal = n;
  o.kind = 0u;
  o.color = vec3f(0.0);
  o.local = vec3f(0.0);
  return o;
}

@vertex
fn vs_lantern(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let L = lanterns[ii];
  // An 8-sided drum: 8 side quads + 2 caps (as 8 triangles each) = 8*6 + 2*8*3 = 96 verts.
  var lp = vec3f(0.0);
  var n = vec3f(0.0);
  if (vi < 48u) {
    let q = vi / 6u;
    let corner = array<vec2u, 6>(vec2u(0, 0), vec2u(1, 0), vec2u(1, 1), vec2u(0, 0), vec2u(1, 1), vec2u(0, 1))[vi % 6u];
    let a = f32(q + corner.x) / 8.0 * TAU;
    // Bulging drum.
    let y = f32(corner.y) - 0.5;
    let rr = 0.5 * (1.0 - 0.25 * y * y * 4.0 + 0.15);
    lp = vec3f(cos(a) * rr, y, sin(a) * rr);
    n = vec3f(cos(a), 0.0, sin(a));
  } else {
    let k = vi - 48u;
    let cap = k / 24u;
    let tri = (k % 24u) / 3u;
    let j = k % 3u;
    let y = select(-0.5, 0.5, cap == 1u);
    var a = f32(tri + select(1u, 0u, (j == 1u) != (cap == 1u))) / 8.0 * TAU;
    lp = select(vec3f(cos(a) * 0.4, y, sin(a) * 0.4), vec3f(0.0, y, 0.0), j == 0u);
    n = vec3f(0.0, sign(y), 0.0);
  }
  let w = L.pos + lp * L.size * vec3f(1.0, 1.4, 1.0);
  var o: VOut;
  o.pos = frame.viewProj * vec4f(w, 1.0);
  if (distance(L.pos, frame.camPos) > MAX_DIST) { o.pos = vec4f(0.0, 0.0, -1.0, 1.0); }
  o.world = w;
  o.normal = n;
  o.kind = 1u;
  o.color = L.color;
  o.local = lp;
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
  var sf: Surface;
  sf.normal = normalize(i.normal);
  sf.albedo = vec3f(0.02);
  sf.roughness = 0.35;
  sf.metallic = 0.0;
  sf.reflectivity = 0.4;
  sf.emissive = vec3f(0.0);
  if (i.kind == 1u) {
    // Paper lantern: glowing body, dark ribs and caps.
    let rib = step(0.42, abs(fract(i.local.y * 4.0 + 0.5) - 0.5));
    let cap = step(0.45, abs(i.local.y));
    sf.emissive = i.color * 3.5 * (1.0 - 0.7 * rib) * (1.0 - cap);
    sf.albedo = vec3f(0.05);
  }
  var o: GOut;
  o.color = vec4f(shade_surface(sf, i.world), 1.0);
  o.normal = vec4f(encode_normal(sf.normal), sf.roughness, sf.reflectivity);
  // Static geometry: motion comes from the camera.
  let cc = frame.viewProjNoJitter * vec4f(i.world, 1.0);
  let pc = frame.prevViewProj * vec4f(i.world, 1.0);
  o.velocity = (pc.xy / pc.w - cc.xy / cc.w) * vec2f(0.5, -0.5);
  return o;
}
