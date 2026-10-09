// Surface lighting: ambient "city glow" (polluted sky above, lit streets
// below) plus clustered point/spot lights. Requires scene.wgsl.

struct Surface {
  albedo: vec3f,
  normal: vec3f,
  roughness: f32,
  metallic: f32,
  emissive: vec3f,
  reflectivity: f32,
};

fn ambient_light(n: vec3f, worldY: f32) -> vec3f {
  let sky = vec3f(0.02, 0.022, 0.045) * frame.cityGlow;
  let ground = vec3f(0.11, 0.05, 0.03) * frame.cityGlow;
  // Deeper in the canyons there is more bounced street light.
  let depthBoost = 1.0 + 3.0 * exp(-max(worldY, 0.0) / 90.0);
  return mix(ground * depthBoost, sky, n.y * 0.5 + 0.5);
}

// What glossy surfaces reflect before SSR: a dim city below and a faintly
// glowing smog layer at the horizon.
fn reflection_env(r: vec3f) -> vec3f {
  let horizon = exp(-abs(r.y) * 6.0);
  let below = vec3f(0.025, 0.014, 0.012) * (1.0 - smoothstep(-0.2, 0.0, r.y));
  let above = vec3f(0.012, 0.010, 0.022) * smoothstep(0.0, 0.3, r.y);
  return (below + above + vec3f(0.09, 0.04, 0.06) * horizon) * frame.cityGlow;
}

fn ggx_d(nh: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

fn smith_v(nv: f32, nl: f32, a: f32) -> f32 {
  let k = a * 0.5;
  return 0.25 / ((nv * (1.0 - k) + k) * (nl * (1.0 - k) + k));
}

fn light_clustered(world: vec3f, n: vec3f, v: vec3f, albedo: vec3f, rough: f32, metal: f32) -> vec3f {
  let viewZ = -(frame.view * vec4f(world, 1.0)).z;
  let ci = cluster_index(g_fragCoord.xy, viewZ, frame.invResolution);
  let count = clusterCounts[ci];
  let a = max(rough * rough, 0.02);
  let f0 = mix(vec3f(0.04), albedo, metal);
  let diffuse = albedo * (1.0 - metal) / PI;
  let nv = max(dot(n, v), 1e-3);
  var c = vec3f(0.0);
  for (var k = 0u; k < count; k++) {
    let L = lights[clusterLights[ci * MAX_PER_CLUSTER + k]];
    let toL = L.pos - world;
    let d = length(toL);
    if (d >= L.radius) { continue; }
    let l = toL / max(d, 1e-4);
    var att = light_falloff(d, L.radius);
    if (L.kind == LIGHT_SPOT) {
      att *= smoothstep(L.cosCone, mix(L.cosCone, 1.0, 0.3), dot(-l, L.dir));
    }
    let nl = dot(n, l);
    // Wrap lighting slightly so big neon panels light around corners.
    let nlw = saturate((nl + 0.15) / 1.15);
    if (nlw <= 0.0) { continue; }
    let h = normalize(l + v);
    let nh = saturate(dot(n, h));
    let F = f0 + (1.0 - f0) * pow(1.0 - saturate(dot(h, v)), 5.0);
    let spec = F * ggx_d(nh, a) * smith_v(nv, max(nl, 1e-3), a) * step(0.0, nl);
    c += L.color * att * (diffuse * nlw + spec * saturate(nl));
  }
  return c;
}

fn shade_surface(sf: Surface, world: vec3f) -> vec3f {
  let V = normalize(frame.camPos - world);
  let diffuse = sf.albedo * (1.0 - sf.metallic);
  var c = diffuse * ambient_light(sf.normal, world.y);
  // Cheap ambient specular so glass and wet surfaces aren't flat.
  let fres = pow(1.0 - saturate(dot(sf.normal, V)), 5.0);
  c += (0.04 + 0.96 * fres) * reflection_env(reflect(-V, sf.normal)) * (1.0 - sf.roughness * 0.7) * sf.reflectivity;
  let lit = light_clustered(world, sf.normal, V, sf.albedo, sf.roughness, sf.metallic);
  if (frame.debugView != 0u) {
    switch frame.debugView {
      case 1u: { return sf.albedo; }
      case 2u: { return sf.normal * 0.5 + 0.5; }
      case 3u: { return sf.emissive; }
      case 4u: { return lit; }
      case 5u: { return c; }
      case 6u: {
        let viewZ = -(frame.view * vec4f(world, 1.0)).z;
        let n = f32(clusterCounts[cluster_index(g_fragCoord.xy, viewZ, frame.invResolution)]);
        return mix(vec3f(0.0, 0.0, 0.3), vec3f(1.0, 0.2, 0.0), n / 32.0) * step(0.5, n) + vec3f(0.02);
      }
      default: {}
    }
  }
  return c + lit + sf.emissive;
}
