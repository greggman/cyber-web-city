// Night sky over a megacity: a low polluted cloud deck lit from below by the
// city's sodium and neon glow, brighter toward the horizon.

fn sky_color(dir: vec3f, time: f32) -> vec3f {
  let d = normalize(dir);
  let up = d.y;
  // Base gradient: hazy orange/magenta near the horizon to near-black zenith.
  let horizon = vec3f(0.55, 0.22, 0.30);
  let mid = vec3f(0.10, 0.05, 0.12);
  let zenith = vec3f(0.012, 0.010, 0.025);
  var c = mix(horizon, mid, smoothstep(0.0, 0.18, up));
  c = mix(c, zenith, smoothstep(0.15, 0.7, up));
  // Cloud deck at ~1800 m, lit from below.
  if (up > 0.0) {
    let t = 1800.0 / max(up, 0.02);
    let p = d.xz * t * 0.00035 + vec2f(time * 0.004, time * 0.0015);
    let n = fbm2(p, 6);
    let n2 = fbm2(p * 3.1 + vec2f(5.2, 1.3), 4);
    let cloud = smoothstep(0.35, 0.85, n * 0.75 + n2 * 0.35);
    let glow = mix(vec3f(0.65, 0.28, 0.32), vec3f(0.25, 0.12, 0.35), smoothstep(0.0, 0.5, up));
    let fade = smoothstep(0.0, 0.08, up) * exp(-t * 0.00006);
    c = mix(c, glow * (0.35 + 0.65 * n2), cloud * fade * 0.85);
  } else {
    // Below the horizon (rarely seen): dark haze lit from the streets.
    c = mix(horizon, vec3f(0.35, 0.16, 0.10), saturate(-up * 4.0));
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
  return 1.0 - exp(-integral);
}

fn fog_color(dir: vec3f, worldY: f32) -> vec3f {
  let low = frame.fogColor * 1.6;
  let high = frame.fogColor * 0.6;
  let c = mix(low, high, smoothstep(-0.3, 0.5, normalize(dir).y));
  return c * frame.cityGlow;
}
