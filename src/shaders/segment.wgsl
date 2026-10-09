// Building segment record and its unit-mesh -> world transform (taper,
// twist, rotation). Shared by the city and the facade-detail shaders.

struct Segment {
  pos: vec3f, rotY: f32,
  size: vec3f, taper: f32,
  twist: f32, shape: u32, style: u32, seed: u32,
  colorA: u32, colorB: u32, flags: u32, floorH: f32,
};

struct Xf { world: vec3f, normal: vec3f, local: vec3f };

fn rot2(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
}

fn seg_transform(s: Segment, p: vec3f, n: vec3f) -> Xf {
  let h = p.y;
  let tp = mix(1.0, s.taper, h);
  var lp = vec3f(p.x * s.size.x * tp, p.y * s.size.y, p.z * s.size.z * tp);
  var ln = vec3f(n.x / s.size.x, n.y / s.size.y, n.z / s.size.z);
  if (abs(n.y) < 0.5) {
    let d0 = 0.5 * length(vec2f(n.x * s.size.x, n.z * s.size.z));
    ln = normalize(vec3f(normalize(ln.xz), 0.0).xzy);
    ln.y = d0 * (1.0 - s.taper) / s.size.y;
  }
  ln = normalize(ln);
  let tw = s.twist * h;
  lp = vec3f(rot2(lp.xz, tw), lp.y).xzy;
  ln = vec3f(rot2(ln.xz, tw), ln.y).xzy;
  let wp = vec3f(rot2(lp.xz, s.rotY), lp.y).xzy;
  let wn = vec3f(rot2(ln.xz, s.rotY), ln.y).xzy;
  var x: Xf;
  x.world = wp + s.pos;
  x.normal = wn;
  x.local = lp;
  return x;
}

