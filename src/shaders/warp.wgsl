// City warp (see src/city/warp.ts; constants must match).
fn warp_ax(v: f32) -> f32 {
  return 150.0 * sin(v * 6.283185307 / 4300.0 + 1.3) + 55.0 * sin(v * 6.283185307 / 1900.0 + 0.4) + 18.0 * sin(v * 6.283185307 / 700.0 + 2.2);
}
fn warp_az(u: f32) -> f32 {
  return 140.0 * sin(u * 6.283185307 / 4700.0 + 2.1) + 60.0 * sin(u * 6.283185307 / 2100.0 + 5.0) + 16.0 * sin(u * 6.283185307 / 650.0 + 0.9);
}
fn warp_dax(v: f32) -> f32 {
  let k = 6.283185307;
  return 150.0 * k / 4300.0 * cos(v * k / 4300.0 + 1.3) + 55.0 * k / 1900.0 * cos(v * k / 1900.0 + 0.4) + 18.0 * k / 700.0 * cos(v * k / 700.0 + 2.2);
}
fn warp_daz(u: f32) -> f32 {
  let k = 6.283185307;
  return 140.0 * k / 4700.0 * cos(u * k / 4700.0 + 2.1) + 60.0 * k / 2100.0 * cos(u * k / 2100.0 + 5.0) + 16.0 * k / 650.0 * cos(u * k / 650.0 + 0.9);
}
fn warp_pos(p: vec3f) -> vec3f {
  return vec3f(p.x + warp_ax(p.z), p.y, p.z + warp_az(p.x));
}
fn warp_dir(p: vec3f, d: vec3f) -> vec3f {
  return normalize(vec3f(d.x + warp_dax(p.z) * d.z, d.y, d.z + warp_daz(p.x) * d.x));
}
fn unwarp2(xz: vec2f) -> vec2f {
  var u = xz.x;
  var v = xz.y;
  for (var k = 0; k < 6; k++) {
    u = xz.x - warp_ax(v);
    v = xz.y - warp_az(u);
  }
  return vec2f(u, v);
}
