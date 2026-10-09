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


// ---------------------------------------------------------------- bay grid
// One structural grid shared by the facade shader and the detail emitter
// (ART_BIBLE.md section 3): a face of base width W holds n whole bays of
// width `bay`, centred, with solid corner piers taking the remainder.
// The bay width lives in colorA's alpha byte (decimetres; 0/255 = the
// style's default), the typology id in colorB's alpha byte.

const PIER_MIN = 0.6;
const ROUND_FACE = 1000000;

fn default_bay(style: u32) -> f32 {
  switch style {
    case 0u: { return 1.5; }  // glass: curtain-wall module
    case 1u: { return 3.6; }  // residential
    case 2u: { return 1.5; }  // metal panel
    case 4u: { return 3.0; }  // slum
    case 5u: { return 6.0; }  // monolith
    case 7u: { return 8.0; }  // structure
    default: { return 2.0; }
  }
}

fn seg_bay(s: Segment) -> f32 {
  let a = s.colorA >> 24u;
  if (a == 0u || a == 255u) { return default_bay(s.style); }
  return f32(a) * 0.1;
}

fn seg_typology(s: Segment) -> u32 { return s.colorB >> 24u; }

// Whole bays on a face of base width W (W <= 0: round shapes, unbounded).
fn face_bays(W: f32, bay: f32) -> i32 {
  if (W <= 0.0) { return ROUND_FACE; }
  return max(i32(floor((W - 2.0 * PIER_MIN) / bay)), 0);
}

// (bay index or -1 in a corner pier, fraction across the bay) for u meters
// from the face centre at base scale.
fn bay_at(u: f32, n: i32, bay: f32) -> vec2f {
  if (n >= ROUND_FACE) { return vec2f(floor(u / bay), fract(u / bay)); }
  let x = u / bay + f32(n) * 0.5;
  if (x < 0.0 || x >= f32(n)) { return vec2f(-1.0, fract(x)); }
  return vec2f(floor(x), fract(x));
}

// Bay centre, meters from the face centre at base scale.
fn bay_center(i: i32, n: i32, bay: f32) -> f32 {
  return (f32(i) + 0.5 - f32(n) * 0.5) * bay;
}

// Bay classes: rhythm strings mirrored from the face edges, so both ends of
// a face (and both renderers) agree whatever the face orientation.
const BAY_W = 0u; // window bay
const BAY_N = 1u; // narrow window (kitchen / bath)
const BAY_S = 2u; // service bay: blank wall, risers
const BAY_C = 3u; // core: stair/lift slot

fn bay_class(s: Segment, idx: i32, n: i32) -> u32 {
  if (n >= ROUND_FACE || idx < 0 || s.shape > 1u) { return BAY_W; }
  let m = u32(min(idx, n - 1 - idx));
  // Centre core on long residential faces.
  let centre = (n % 2 == 1 && idx == n / 2) || (n % 2 == 0 && (idx == n / 2 || idx == n / 2 - 1));
  switch s.style {
    case 1u: {
      // Slab block: W N W N W N S, repeating from each end.
      if (n >= 9 && centre) { return BAY_C; }
      let k = m % 7u;
      if (k == 6u) { return BAY_S; }
      return select(BAY_W, BAY_N, (k & 1u) == 1u);
    }
    case 4u: {
      // Tenement: a service bay every sixth.
      if (m % 6u == 5u) { return BAY_S; }
      return BAY_W;
    }
    default: { return BAY_W; }
  }
}

// Window opening within a bay cell (x0, x1, y0, y1 as fractions of the bay
// and floor) for a style and bay class. y is per floor except monoliths
// (their strip windows span a three-floor band).
fn win_rect(s: Segment, cls: u32) -> vec4f {
  if (cls == BAY_N) { return vec4f(0.3, 0.7, 0.45, 0.8); }
  switch s.style {
    case 0u: { return vec4f(0.06, 0.94, 0.14, 0.98); }
    case 1u: { return vec4f(0.18, 0.82, 0.25, 0.85); }
    case 2u: { return vec4f(0.07, 0.93, 0.3, 0.72); }
    case 4u: { return vec4f(0.15 + 0.12 * f32(hash_u(s.seed + 1u) >> 8u) / 16777216.0, 0.8, 0.25, 0.8); }
    case 5u: { return vec4f(0.12, 1.0, 0.0, 0.18); }
    default: { return vec4f(0.08, 0.92, 0.15, 0.95); }
  }
}
