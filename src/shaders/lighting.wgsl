// Surface lighting. Ambient "city glow" from the polluted sky above and the
// lit streets below; clustered lights are added in light_clustered().

struct Surface {
  albedo: vec3f,
  normal: vec3f,
  roughness: f32,
  metallic: f32,
  emissive: vec3f,
  reflectivity: f32,
};

fn ambient_light(n: vec3f, worldY: f32) -> vec3f {
  let sky = vec3f(0.035, 0.022, 0.05) * frame.cityGlow;
  let ground = vec3f(0.09, 0.045, 0.03) * frame.cityGlow;
  // Lower in the canyons there is more bounced street light.
  let depthBoost = 1.0 + 2.0 * exp(-max(worldY, 0.0) / 120.0);
  return mix(ground * depthBoost, sky, n.y * 0.5 + 0.5);
}

fn shade_surface(sf: Surface, world: vec3f) -> vec3f {
  let V = normalize(frame.camPos - world);
  let diffuse = sf.albedo * (1.0 - sf.metallic);
  var c = diffuse * ambient_light(sf.normal, world.y);
  // Cheap ambient specular so glass and wet surfaces aren't flat.
  let fres = pow(1.0 - saturate(dot(sf.normal, V)), 5.0);
  c += (0.04 + 0.96 * fres) * ambient_light(reflect(-V, sf.normal), world.y) * (1.0 - sf.roughness) * 0.6 * sf.reflectivity;
  return c + sf.emissive;
}
