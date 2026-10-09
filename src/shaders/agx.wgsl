// AgX approximation (Benjamin Wrensch's polynomial fit).
fn agx_contrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
fn agx(c: vec3f) -> vec3f {
  let m = mat3x3f(
    vec3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051),
    vec3f(0.0784335999999992, 0.878468636469772, 0.0784336),
    vec3f(0.0792237451477643, 0.0791661274605434, 0.879142973793104));
  let minEv = -12.47393;
  let maxEv = 4.026069;
  var v = m * c;
  v = clamp(log2(max(v, vec3f(1e-10))), vec3f(minEv), vec3f(maxEv));
  v = (v - minEv) / (maxEv - minEv);
  return agx_contrast(v);
}
fn agx_eotf(c: vec3f) -> vec3f {
  let m = mat3x3f(
    vec3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438),
    vec3f(-0.0980208811401368, 1.15190312990417, -0.0980434501171241),
    vec3f(-0.0990297440797205, -0.0989611768448433, 1.15107367264116));
  return pow(max(m * c, vec3f(0.0)), vec3f(2.2));
}
fn agx_punchy(c: vec3f) -> vec3f {
  let lw = vec3f(0.2126, 0.7152, 0.0722);
  let luma = dot(c, lw);
  let slope = vec3f(1.05);
  let power = vec3f(1.15);
  let sat = 1.25;
  let v = pow(max(c * slope, vec3f(0.0)), power);
  return luma + sat * (v - luma);
}

fn linear_to_srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

// Hue-preserving variant: tone-map the max channel with the AgX curve and
// scale the color by it, so saturated neon stays saturated; very bright
// values roll off toward white smoothly.
fn tonemap_hue(c: vec3f) -> vec3f {
  let m = max(max(c.r, c.g), max(c.b, 1e-6));
  let curve = agx_eotf(agx_punchy(agx(vec3f(m)))).r;
  var o = c * (curve / m);
  let over = saturate((m - 4.0) / 40.0);
  o = mix(o, vec3f(max(max(o.r, o.g), o.b)), over * 0.6);
  return o;
}

fn tonemap_agx(c: vec3f) -> vec3f {
  let a = agx_eotf(agx_punchy(agx(c)));
  let h = tonemap_hue(c);
  // Blend: AgX for natural skin/mid tones, hue-preserving for saturated
  // emissive highlights.
  let sat = (max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b)) / max(max(max(c.r, c.g), c.b), 1e-4);
  return linear_to_srgb(saturate3(mix(a, h, 0.35 + 0.45 * sat)));
}
