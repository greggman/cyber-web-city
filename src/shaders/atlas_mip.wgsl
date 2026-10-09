// Downsamples one mip level of the material atlas (2x2 box filter). The
// normal channels average too, which flattens distant relief the way the
// art bible asks (lost slope turns into roughness via the a channel).

@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn cs_mip(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let p = vec2i(gid.xy) * 2;
  let l = i32(gid.z);
  let a = textureLoad(src, p, l, 0);
  let b = textureLoad(src, p + vec2i(1, 0), l, 0);
  let c = textureLoad(src, p + vec2i(0, 1), l, 0);
  let d = textureLoad(src, p + vec2i(1, 1), l, 0);
  var avg = (a + b + c + d) * 0.25;
  // Slope variance lost by averaging goes into roughness.
  let nAvg = avg.yz * 2.0 - 1.0;
  let v = (dot(a.yz * 2.0 - 1.0 - nAvg, a.yz * 2.0 - 1.0 - nAvg) +
           dot(b.yz * 2.0 - 1.0 - nAvg, b.yz * 2.0 - 1.0 - nAvg) +
           dot(c.yz * 2.0 - 1.0 - nAvg, c.yz * 2.0 - 1.0 - nAvg) +
           dot(d.yz * 2.0 - 1.0 - nAvg, d.yz * 2.0 - 1.0 - nAvg)) * 0.25;
  avg.w = min(avg.w + v * 2.0, 1.0);
  textureStore(dst, gid.xy, gid.z, avg);
}
