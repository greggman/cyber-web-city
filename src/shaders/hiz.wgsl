// Hi-Z pyramid: each texel stores the FARTHEST depth (minimum, reversed-Z)
// of the 2x2 texels below it, so occlusion tests are conservative.
@group(0) @binding(0) var srcDepth: texture_depth_2d;
@group(0) @binding(1) var dst0: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn cs_first(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(dst0);
  if (any(gid.xy >= dims)) { return; }
  let sdims = vec2i(textureDimensions(srcDepth)) - 1;
  let p = vec2i(gid.xy) * 2;
  let a = textureLoad(srcDepth, min(p, sdims), 0);
  let b = textureLoad(srcDepth, min(p + vec2i(1, 0), sdims), 0);
  let c = textureLoad(srcDepth, min(p + vec2i(0, 1), sdims), 0);
  let d = textureLoad(srcDepth, min(p + vec2i(1, 1), sdims), 0);
  textureStore(dst0, gid.xy, vec4f(min(min(a, b), min(c, d))));
}

@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var dst: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn cs_down(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(dst);
  if (any(gid.xy >= dims)) { return; }
  let sdims = vec2i(textureDimensions(src)) - 1;
  let p = vec2i(gid.xy) * 2;
  let a = textureLoad(src, min(p, sdims), 0).r;
  let b = textureLoad(src, min(p + vec2i(1, 0), sdims), 0).r;
  let c = textureLoad(src, min(p + vec2i(0, 1), sdims), 0).r;
  let d = textureLoad(src, min(p + vec2i(1, 1), sdims), 0).r;
  // Odd source sizes: include the extra row/column.
  var m = min(min(a, b), min(c, d));
  if ((textureDimensions(src).x & 1u) == 1u && gid.x == dims.x - 1u) {
    m = min(m, min(textureLoad(src, min(p + vec2i(2, 0), sdims), 0).r, textureLoad(src, min(p + vec2i(2, 1), sdims), 0).r));
  }
  if ((textureDimensions(src).y & 1u) == 1u && gid.y == dims.y - 1u) {
    m = min(m, min(textureLoad(src, min(p + vec2i(0, 2), sdims), 0).r, textureLoad(src, min(p + vec2i(1, 2), sdims), 0).r));
  }
  textureStore(dst, gid.xy, vec4f(m));
}
