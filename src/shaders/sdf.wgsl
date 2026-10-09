// Signed distance functions and animated subjects shared by the ad scenes
// and the holograms. Requires common.wgsl.

fn sd_sphere(p: vec3f, r: f32) -> f32 { return length(p) - r; }
fn sd_ellipsoid(p: vec3f, r: vec3f) -> f32 {
  let k0 = length(p / r);
  let k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}
fn sd_capsule(p: vec3f, a: vec3f, b: vec3f, r: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = saturate(dot(pa, ba) / dot(ba, ba));
  return length(pa - ba * h) - r;
}
fn sd_round_cone(p: vec3f, a: vec3f, b: vec3f, ra: f32, rb: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = saturate(dot(pa, ba) / dot(ba, ba));
  return length(pa - ba * h) - mix(ra, rb, h);
}
fn sd_torus(p: vec3f, t: vec2f) -> f32 {
  let q = vec2f(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}
fn sd_box(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}
fn sd_cyl(p: vec3f, h: f32, r: f32) -> f32 {
  let d = abs(vec2f(length(p.xz), p.y)) - vec2f(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0)));
}
fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = saturate(0.5 + 0.5 * (b - a) / k);
  return mix(b, a, h) - k * h * (1.0 - h);
}
fn rot_y(p: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
fn rot_x(p: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}
fn rot_z(p: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}

// A dancing figure (unit height ~2, feet at y = 0).
fn sd_dancer(p: vec3f, t: f32) -> f32 {
  let sway = sin(t * 2.0) * 0.15;
  let bob = abs(sin(t * 4.0)) * 0.06;
  let hip = vec3f(sway, 1.0 + bob, 0.0);
  let chest = hip + vec3f(sin(t * 2.0 + 0.5) * 0.08, 0.5, 0.0);
  let head = chest + vec3f(0.0, 0.32, 0.0);
  var d = sd_round_cone(p, hip, chest, 0.16, 0.2);
  d = smin(d, sd_sphere(p - head, 0.15), 0.06);
  // Arms: raised and waving.
  let a1 = t * 2.0;
  for (var s = -1.0; s <= 1.0; s += 2.0) {
    let sh = chest + vec3f(0.22 * s, -0.02, 0.0);
    let el = sh + vec3f(0.25 * s, 0.15 + 0.2 * sin(a1 + s), 0.1 * cos(a1));
    let ha = el + vec3f(0.12 * s, 0.3 + 0.15 * sin(a1 * 1.5 + s), 0.0);
    d = smin(d, sd_capsule(p, sh, el, 0.055), 0.04);
    d = smin(d, sd_capsule(p, el, ha, 0.045), 0.03);
    // Legs.
    let hp = hip + vec3f(0.1 * s, -0.05, 0.0);
    let kn = hp + vec3f(0.08 * s + 0.1 * sin(t * 4.0 + s) * s, -0.48, 0.12 * max(0.0, sin(t * 4.0 + s * 1.5)));
    let ft = vec3f(kn.x + 0.04 * s, 0.05, kn.z - 0.05);
    d = smin(d, sd_capsule(p, hp, kn, 0.075), 0.04);
    d = smin(d, sd_capsule(p, kn, ft, 0.06), 0.03);
  }
  return d;
}

// A stylized face with elaborate hair (giant ad face; not a real person).
// Returns distance; id via out param: 0 skin, 1 hair, 2 eyes, 3 lips, 4 ornament.
fn sd_face(p_in: vec3f, t: f32, id: ptr<function, u32>) -> f32 {
  let p = rot_y(p_in, sin(t * 0.3) * 0.35);
  var d = sd_ellipsoid(p - vec3f(0.0, 0.0, 0.0), vec3f(0.42, 0.55, 0.45));
  *id = 0u;
  // Hair: big rounded bun shapes.
  let hair = min(min(
    sd_ellipsoid(p - vec3f(0.0, 0.35, -0.1), vec3f(0.55, 0.38, 0.5)),
    sd_sphere(p - vec3f(0.0, 0.75, -0.15), 0.3)),
    sd_ellipsoid(p - vec3f(0.0, 0.62, -0.05), vec3f(0.75, 0.12, 0.3)));
  if (hair < d) { d = hair; *id = 1u; }
  // Hair ornaments (sticks).
  let orn = min(sd_capsule(p, vec3f(-0.6, 0.9, -0.1), vec3f(0.5, 0.6, -0.1), 0.02),
                sd_capsule(p, vec3f(0.6, 0.95, -0.12), vec3f(-0.45, 0.62, -0.12), 0.02));
  if (orn < d) { d = orn; *id = 4u; }
  // Eyes (blinking) and lips.
  let blink = select(1.0, 0.1, fract(t * 0.25) > 0.96);
  for (var s = -1.0; s <= 1.0; s += 2.0) {
    let e = sd_ellipsoid(p - vec3f(0.15 * s, 0.08, 0.38), vec3f(0.08, 0.035 * blink, 0.05));
    if (e < d + 0.01) { d = min(d, e); *id = 2u; }
  }
  let lips = sd_ellipsoid(p - vec3f(0.0, -0.25, 0.4), vec3f(0.1, 0.035 + 0.01 * sin(t * 2.0), 0.05));
  if (lips < d + 0.01) { d = min(d, lips); *id = 3u; }
  return d;
}

// A koi fish swimming along +x (length ~1).
fn sd_koi(p_in: vec3f, t: f32) -> f32 {
  var p = p_in;
  let wave = sin(p.x * 5.0 - t * 6.0) * 0.06 * (0.5 + p.x + 0.5);
  p.z -= wave;
  var d = sd_ellipsoid(p, vec3f(0.5, 0.14, 0.11));
  // Tail fin.
  let tp = p - vec3f(-0.55, 0.0, 0.0);
  let fin = sd_ellipsoid(rot_z(tp, 0.0), vec3f(0.12, 0.16, 0.015));
  d = smin(d, fin, 0.05);
  // Side fins.
  d = smin(d, sd_ellipsoid(p - vec3f(0.15, -0.08, 0.12), vec3f(0.08, 0.02, 0.08)), 0.03);
  d = smin(d, sd_ellipsoid(p - vec3f(0.15, -0.08, -0.12), vec3f(0.08, 0.02, 0.08)), 0.03);
  return d;
}

// A jellyfish (bell at y ~ 0.6, tentacles below).
fn sd_jelly(p: vec3f, t: f32) -> f32 {
  let pulse = 1.0 + 0.12 * sin(t * 2.5);
  var q = p - vec3f(0.0, 0.6, 0.0);
  q = vec3f(q.x * pulse, q.y / pulse, q.z * pulse);
  var d = max(sd_ellipsoid(q, vec3f(0.5, 0.35, 0.5)), -q.y - 0.05);
  for (var k = 0; k < 6; k++) {
    let a = f32(k) * 1.047;
    let base = vec3f(cos(a) * 0.3, 0.55, sin(a) * 0.3);
    let tip = base + vec3f(sin(t + f32(k)) * 0.15, -1.1, cos(t * 0.7 + f32(k)) * 0.15);
    d = min(d, sd_capsule(p, base, tip, 0.02));
  }
  return d;
}

// Torus-knot-ish logo ring.
fn sd_logo(p: vec3f, t: f32) -> f32 {
  let q = rot_x(rot_y(p, t * 0.7), 1.0 + 0.3 * sin(t * 0.5));
  let r1 = sd_torus(q, vec2f(0.6, 0.06));
  let q2 = rot_z(q, 1.2);
  let r2 = sd_torus(q2.xzy, vec2f(0.45, 0.05));
  return min(r1, r2);
}
