// Night sky over a megacity: a low polluted cloud deck lit from below by the
// city's sodium and neon glow, brighter toward the horizon.

fn sky_color(dir: vec3f, time: f32) -> vec3f {
  let d = normalize(dir);
  let up = d.y;
  // Base gradient (ART_BIBLE.md 15.5): smog amber at the horizon, through
  // umber, to a soot zenith.
  let horizon = vec3f(0.10, 0.06, 0.035);
  let mid = vec3f(0.024, 0.027, 0.032); // steel by ~30 degrees up
  let zenith = vec3f(0.004, 0.005, 0.007);
  var c = mix(horizon, mid, smoothstep(0.0, 0.18, up));
  c = mix(c, zenith, smoothstep(0.15, 0.7, up));
  // Cloud deck at ~1800 m, lit from below.
  if (up > 0.0) {
    let t = 1800.0 / max(up, 0.02);
    let p = d.xz * t * 0.00035 + vec2f(time * 0.004, time * 0.0015);
    let n = fbm2(p, 6);
    let n2 = fbm2(p * 3.1 + vec2f(5.2, 1.3), 4);
    let cloud = smoothstep(0.35, 0.85, n * 0.75 + n2 * 0.35);
    // Cloud underside: sodium-lit amber low, rain steel overhead.
    let glow = mix(vec3f(0.20, 0.11, 0.05), vec3f(0.045, 0.048, 0.055), smoothstep(0.0, 0.5, up));
    let fade = smoothstep(0.0, 0.08, up) * exp(-t * 0.00006);
    c = mix(c, glow * (0.35 + 0.65 * n2), cloud * fade * 0.7);
  } else {
    // Below the horizon (rarely seen): dark haze lit from the streets.
    c = mix(horizon, vec3f(0.14, 0.06, 0.04), saturate(-up * 4.0));
  }
  return c * frame.cityGlow;
}

// Exponential height fog, integrated analytically along the view ray.
fn fog_amount(camPos: vec3f, worldPos: vec3f) -> f32 {
  let v = worldPos - camPos;
  let dist = length(v);
  let dirY = v.y / max(dist, 1e-4);
  let f = frame.fogHeightFalloff;
  let base = frame.fogDensity * exp(-f * camPos.y);
  var integral: f32;
  let k = f * dirY * dist;
  if (abs(k) > 1e-4) {
    integral = base * dist * (1.0 - exp(-k)) / k;
  } else {
    integral = base * dist;
  }
  // Plus a distance floor so the far edge of the world always fades out.
  return max(1.0 - exp(-integral), 1.0 - exp(-dist / 6500.0));
}

fn fog_color(dir: vec3f, worldY: f32, dist: f32) -> vec3f {
  // Match the sky at the horizon so distant geometry dissolves seamlessly;
  // darker looking down into the canyons.
  let d = normalize(dir);
  let horizonSky = sky_color(vec3f(d.x, max(d.y, 0.0) + 0.012, d.z), frame.time);
  let low = mix(horizonSky, frame.fogColor * 0.6 * frame.cityGlow, saturate(-d.y * 1.5));
  // Warm (sodium-lit) low, cooler rain steel high up.
  let steel = vec3f(0.061, 0.080, 0.102) * 0.9 * frame.cityGlow;
  // Rain steel high up and far away (ART_BIBLE.md 15.5).
  let k = max(smoothstep(80.0, 400.0, worldY), smoothstep(600.0, 1800.0, dist));
  return mix(low, steel, 0.8 * k);
}
