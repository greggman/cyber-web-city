// Rain: GPU particles in a box that wraps around the camera. A compute pass
// moves them and lights each drop from its cluster's lights (so headlights
// and neon light the rain); the render pass draws motion-stretched streaks.
#include "scene.wgsl"

struct Drop { pos: vec3f, seed: f32, color: vec3f, _p: f32 };
struct RainParams {
  camVel: vec3f, count: u32,
  boxCenter: vec3f, intensity: f32,
  boxSize: vec3f, streak: f32,
  wind: vec3f, fallSpeed: f32,
};

@group(1) @binding(0) var<storage, read_write> drops: array<Drop>;
@group(1) @binding(1) var<uniform> R: RainParams;
// Read-only view of the drops for the render pipeline.
@group(1) @binding(2) var<storage, read> dropsRO: array<Drop>;

// Weather other than rain (frame.weather: 1 snow, 2 ash, 3 dust) falls
// slowly and drifts, drawn as soft round flakes instead of streaks.
fn flakes() -> bool { return frame.weather >= 1u && frame.weather <= 3u; }

fn particle_vel(d: Drop) -> vec3f {
  if (!flakes()) {
    return vec3f(R.wind.x, -R.fallSpeed * (0.85 + 0.3 * d.seed), R.wind.z);
  }
  let t = frame.time;
  let ph = d.seed * 40.0;
  // Dust blows sideways; snow and ash flutter down.
  let fall = select(select(1.1, 0.7, frame.weather == 2u), 0.25, frame.weather == 3u);
  let side = select(0.7, 5.0, frame.weather == 3u);
  return vec3f(
    side * (0.6 + sin(t * 0.7 + ph)) + R.wind.x * 0.3,
    -fall * (0.7 + 0.6 * d.seed) + 0.3 * sin(t * 1.3 + ph * 1.7),
    0.6 * cos(t * 0.9 + ph * 1.3) + R.wind.z * 0.3,
  );
}

@compute @workgroup_size(64)
fn cs_update(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= R.count) { return; }
  var d = drops[i];
  var p = d.pos + particle_vel(d) * frame.dt;
  // Wrap into the box around the camera.
  let lo = R.boxCenter - R.boxSize * 0.5;
  p = lo + ((p - lo) % R.boxSize + R.boxSize) % R.boxSize;
  d.pos = p;
  // Light the drop: clustered lights + a little ambient city glow.
  let clip = frame.viewProj * vec4f(p, 1.0);
  var c = frame.fogColor * 0.05 * frame.cityGlow;
  if (clip.w > 0.1) {
    let ndc = clip.xy / clip.w;
    if (all(abs(ndc) < vec2f(1.0))) {
      let frag = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * frame.resolution;
      let ci = cluster_index(frag, clip.w, frame.invResolution);
      let n = clusterCounts[ci];
      for (var k = 0u; k < n; k++) {
        let L = lights[clusterLights[ci * MAX_PER_CLUSTER + k]];
        let toL = L.pos - p;
        let dist = length(toL);
        if (dist >= L.radius) { continue; }
        var att = light_falloff(dist, L.radius);
        if (L.kind == LIGHT_SPOT) {
          att *= smoothstep(L.cosCone, mix(L.cosCone, 1.0, 0.3), dot(-toL / max(dist, 1e-3), L.dir));
        }
        c += L.color * att;
      }
    }
  }
  d.color = c;
  drops[i] = d;
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
  @location(1) side: f32,
  @location(2) along: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let d = dropsRO[ii];
  if (flakes()) { return flake_vertex(vi, d); }
  let vel = vec3f(R.wind.x, -R.fallSpeed * (0.85 + 0.3 * d.seed), R.wind.z) - R.camVel;
  let a = d.pos;
  let b = d.pos - vel * R.streak;
  let ca = frame.viewProj * vec4f(a, 1.0);
  let cb = frame.viewProj * vec4f(b, 1.0);
  var o: VOut;
  if (ca.w < 0.2 || cb.w < 0.2) {
    o.pos = vec4f(0.0, 0.0, -1.0, 1.0);
    return o;
  }
  let sa = ca.xy / ca.w;
  let sb = cb.xy / cb.w;
  var dir = (sb - sa) * frame.resolution;
  let len = length(dir);
  dir = select(vec2f(0.0, 1.0), dir / len, len > 1e-4);
  let perp = vec2f(-dir.y, dir.x);
  // Real width ~3 mm, but never thinner than ~1 px (fade alpha instead).
  let worldW = 0.002 * frame.resolution.y / (2.0 * frame.tanHalfFov.y * ca.w);
  let wpx = max(worldW, 1.0);
  let corner = array<vec2f, 6>(vec2f(0, -1), vec2f(1, -1), vec2f(1, 1), vec2f(0, -1), vec2f(1, 1), vec2f(0, 1))[vi];
  let s = mix(sa, sb, corner.x);
  let w = mix(ca.w, cb.w, corner.x);
  let z = mix(ca.z / ca.w, cb.z / cb.w, corner.x);
  let off = perp * corner.y * wpx * frame.invResolution;
  o.pos = vec4f((s + off) * w, z * w, w);
  // Thin, distant, and long streaks spread the same energy over more pixels.
  let energy = (worldW / wpx) * clamp(8.0 / max(len, 1.0), 0.15, 1.0);
  let distFade = smoothstep(1.5, 5.0, ca.w) * (1.0 - smoothstep(25.0, 40.0, ca.w));
  o.color = d.color * energy * distFade * R.intensity;
  o.side = corner.y;
  o.along = corner.x;
  return o;
}

// A camera-facing round flake (snow 5 mm, ash 8 mm, dust 2 mm), at least
// 1.5 px wide (energy spread instead), lit like the rain plus the haze.
fn flake_vertex(vi: u32, d: Drop) -> VOut {
  var o: VOut;
  let c = frame.viewProj * vec4f(d.pos, 1.0);
  if (c.w < 0.3) {
    o.pos = vec4f(0.0, 0.0, -1.0, 1.0);
    return o;
  }
  let size = select(select(0.018, 0.01, frame.weather == 2u), 0.003, frame.weather == 3u);
  let px = size * frame.resolution.y / (2.0 * frame.tanHalfFov.y * c.w);
  let rpx = max(px, 1.5);
  let corner = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1))[vi];
  o.pos = vec4f(c.xy + corner * rpx * 2.0 * frame.invResolution * c.w, c.z, c.w);
  // Snow is white, ash grey, dust ochre: the haze-lit base plus lights.
  let tint = select(select(vec3f(1.0), vec3f(0.55), frame.weather == 2u), vec3f(1.0, 0.7, 0.4), frame.weather == 3u);
  let lit = d.color + frame.fogHigh * 1.5 + frame.skyHorizon * 0.8;
  let distFade = smoothstep(0.5, 2.0, c.w) * (1.0 - smoothstep(30.0, 55.0, c.w));
  let bright = select(select(5.0, 3.0, frame.weather == 2u), 9.0, frame.weather == 3u);
  o.color = lit * tint * (px * px) / (rpx * rpx) * distFade * R.intensity * bright;
  o.side = corner.x;
  o.along = corner.y;
  return o;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  if (flakes()) {
    let r = length(vec2f(i.side, i.along));
    return vec4f(i.color * smoothstep(1.0, 0.3, r), 0.0);
  }
  let edge = 1.0 - abs(i.side);
  let taper = sin(i.along * PI);
  return vec4f(i.color * edge * taper, 0.0);
}
