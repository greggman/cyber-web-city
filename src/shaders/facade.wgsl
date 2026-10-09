// Procedural facade materials. Detail comes from the shader, not geometry.
#include "lighting.wgsl"

struct Shaded { color: vec3f, normal: vec3f, roughness: f32, reflectivity: f32 };

fn shade_facade(s: Segment, world: vec3f, n: vec3f, facade: vec2f, local: vec3f, capUv: vec2f) -> Shaded {
  var sf: Surface;
  sf.normal = n;
  sf.roughness = 0.6;
  sf.metallic = 0.0;
  sf.reflectivity = 0.2;
  sf.albedo = vec3f(0.05, 0.05, 0.06);
  sf.emissive = vec3f(0.0);
  let tint = unpack_color(s.colorA);
  if (abs(n.y) < 0.7) {
    let cellW = s.floorH * 0.9;
    let cell = vec2f(facade.x / cellW, facade.y / s.floorH);
    let id = floor(cell);
    let f = fract(cell);
    let win = step(0.15, f.x) * step(f.x, 0.85) * step(0.2, f.y) * step(f.y, 0.8);
    let h = hash31(s.seed, bitcast<u32>(i32(id.x)), bitcast<u32>(i32(id.y)));
    let lit = step(h, 0.35);
    sf.emissive = win * lit * tint * (1.0 + 2.0 * fract(h * 13.7));
  }
  var o: Shaded;
  o.color = shade_surface(sf, world);
  o.normal = sf.normal;
  o.roughness = sf.roughness;
  o.reflectivity = sf.reflectivity;
  return o;
}
