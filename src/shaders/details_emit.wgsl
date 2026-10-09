// GPU kitbash: generates facade detail instances (ledges, fins, pipes, AC
// units, balconies, awnings, window cages, vents, shop canopies) for the
// building segments near the camera, following each style's window grid.
//
// cs_select: frustum/distance/Hi-Z test every segment -> near list and an
//            indirect dispatch count.
// cs_emit:   one workgroup per near segment walks its faces, floors and
//            window cells and appends instances to per-type buckets whose
//            instance counts feed drawIndexedIndirect.
#include "common.wgsl"
#include "segment.wgsl"

const T_LEDGE = 0u;
const T_FIN = 1u;
const T_PIPE = 2u;
const T_AC = 3u;
const T_BALCONY = 4u;
const T_AWNING = 5u;
const T_CAGE = 6u;
const T_VENT = 7u;
const T_CANOPY = 8u;
const T_MODULE = 9u;
const T_HVAC = 10u;
const T_TANK = 11u;
const T_DISH = 12u;
const T_VENTSTACK = 13u;
const NT = 14u;

// Styles (src/city/segments.ts).
const ST_GLASS = 0u;
const ST_RESIDENTIAL = 1u;
const ST_METAL = 2u;
const ST_SLUM = 4u;
const ST_MONOLITH = 5u;
const ST_PODIUM = 6u;
const F_NOWIN = 8u;
const F_ROOF = 32u;
const ST_LED = 3u;

// Instance flags.
const IF_LIT = 1u; // emissive parts on
const IF_GLASS = 2u; // glass parapet

struct Inst {
  pos: vec3f, sx: f32,
  ax: vec3f, sy: f32,
  az: vec3f, sz: f32,
  color: u32, accent: u32, flags: u32, _p: u32,
};

struct Params {
  planes: array<vec4f, 5>,
  camPos: vec3f, segCount: u32,
  prevViewProj: mat4x4f,
  hizSize: vec2f, hizMips: u32, useHiz: u32,
  distScale: f32, maxNear: u32, _p0: u32, _p1: u32,
};

struct TypeInfo { base: u32, cap: u32, _p0: u32, _p1: u32 };
struct DrawArgs {
  indexCount: u32, instanceCount: atomic<u32>, firstIndex: u32, baseVertex: i32, firstInstance: u32,
};
struct DispatchArgs { x: atomic<u32>, y: u32, z: u32 };

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> segments: array<Segment>;
@group(0) @binding(2) var<storage, read_write> near: array<u32>;
@group(0) @binding(3) var<storage, read_write> dispatch: DispatchArgs;
@group(0) @binding(4) var<storage, read_write> draws: array<DrawArgs, 14>;
@group(0) @binding(5) var<storage, read_write> instances: array<Inst>;
@group(0) @binding(6) var<storage, read> types: array<TypeInfo, 14>;
@group(0) @binding(7) var hiz: texture_2d<f32>;

// Max distance (m) at which each type is generated (scaled by quality).
fn type_range(t: u32) -> f32 {
  switch t {
    case T_MODULE: { return 800.0; }
    case T_HVAC, T_TANK: { return 700.0; }
    case T_DISH, T_VENTSTACK: { return 450.0; }
    case T_LEDGE, T_FIN, T_PIPE: { return 650.0; }
    case T_CANOPY, T_BALCONY, T_CAGE, T_AWNING: { return 360.0; }
    default: { return 240.0; }
  }
}

fn occluded(c: vec3f, e: vec3f) -> bool {
  var mn = vec2f(1e9);
  var mx = vec2f(-1e9);
  var maxDepth = 0.0;
  for (var i = 0u; i < 8u; i++) {
    let corner = c + e * vec3f(
      select(-1.0, 1.0, (i & 1u) != 0u),
      select(-1.0, 1.0, (i & 2u) != 0u),
      select(-1.0, 1.0, (i & 4u) != 0u));
    let clip = P.prevViewProj * vec4f(corner, 1.0);
    if (clip.w <= 0.1) { return false; }
    let ndc = clip.xyz / clip.w;
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    mn = min(mn, uv);
    mx = max(mx, uv);
    maxDepth = max(maxDepth, ndc.z);
  }
  mn = clamp(mn, vec2f(0.0), vec2f(1.0));
  mx = clamp(mx, vec2f(0.0), vec2f(1.0));
  if (any(mx <= mn)) { return false; }
  let sizePx = (mx - mn) * P.hizSize;
  let mip = clamp(u32(ceil(log2(max(max(sizePx.x, sizePx.y), 1.0)))), 0u, P.hizMips - 1u);
  let dims = vec2f(textureDimensions(hiz, mip));
  let p0 = vec2i(mn * dims);
  let p1 = min(vec2i(mx * dims), vec2i(dims) - 1);
  if (p1.x - p0.x > 2 || p1.y - p0.y > 2) { return false; }
  var farthest = 1.0;
  for (var y = p0.y; y <= p1.y; y++) {
    for (var x = p0.x; x <= p1.x; x++) {
      farthest = min(farthest, textureLoad(hiz, vec2i(x, y), mip).r);
    }
  }
  return maxDepth < farthest;
}

fn in_frustum(c: vec3f, r: f32) -> bool {
  for (var p = 0; p < 5; p++) {
    if (dot(P.planes[p].xyz, c) + P.planes[p].w < -r) { return false; }
  }
  return true;
}

// ---------------------------------------------------------------- select

fn has_details(s: Segment) -> bool {
  if ((s.flags & F_NOWIN) != 0u) { return false; }
  if (s.shape > 4u) { return false; }
  if (min(s.size.x, s.size.z) < 8.0 || s.size.y < 10.0) { return false; }
  return s.style == ST_GLASS || s.style == ST_RESIDENTIAL || s.style == ST_METAL ||
    s.style == ST_SLUM || s.style == ST_MONOLITH || s.style == ST_PODIUM;
}

// Exposed roofs of any building piece get rooftop kitbash.
fn has_roof(s: Segment) -> bool {
  return (s.flags & F_ROOF) != 0u && s.shape <= 4u && s.style != 8u && s.style != 10u &&
    s.size.x * s.size.z * s.taper * s.taper > 150.0;
}

@compute @workgroup_size(64)
fn cs_select(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.segCount) { return; }
  let s = segments[i];
  if (!has_details(s) && !has_roof(s)) { return; }
  let grow = max(1.0, s.taper);
  let ext = vec3f(0.5 * length(s.size.xz) * grow + 2.0, s.size.y * 0.5, 0.5 * length(s.size.xz) * grow + 2.0);
  let c = s.pos + vec3f(0.0, s.size.y * 0.5, 0.0);
  let r = length(ext);
  if (distance(c, P.camPos) - r > 800.0 * P.distScale) { return; }
  if (!in_frustum(c, r)) { return; }
  if (P.useHiz != 0u && occluded(c, ext)) { return; }
  let slot = atomicAdd(&dispatch.x, 1u);
  if (slot < P.maxNear) {
    near[slot] = i;
  } else {
    atomicSub(&dispatch.x, 1u);
  }
}

// ------------------------------------------------------------------ emit

// Face frame of a prism-shaped segment (local unit space).
struct Face { center: vec2f, n: vec2f, t: vec2f, unitW: f32 };

fn prism_n(s: Segment) -> u32 {
  switch s.shape {
    case 3u: { return 6u; }
    case 4u: { return 8u; }
    case 2u: {
      // Round towers: facets ~2 cells wide.
      let circ = PI * (s.size.x + s.size.z) * 0.5;
      return clamp(u32(circ / 7.0), 8u, 48u);
    }
    default: { return 4u; }
  }
}

fn face_of(s: Segment, f: u32, nf: u32) -> Face {
  var R = 0.5;
  var off = 0.0;
  if (s.shape <= 1u) { R = 0.70710678; off = PI * 0.25; }
  if (s.shape == 4u) { off = PI / 8.0; }
  let a = off + (f32(f) + 0.5) * TAU / f32(nf);
  var fc: Face;
  fc.n = vec2f(cos(a), sin(a));
  fc.center = fc.n * R * cos(PI / f32(nf));
  fc.t = vec2f(fc.n.y, -fc.n.x);
  fc.unitW = 2.0 * R * sin(PI / f32(nf));
  return fc;
}

// Meters per unit along the face tangent at the base.
fn face_scale(s: Segment, fc: Face) -> f32 {
  return abs(fc.t.x) * s.size.x + abs(fc.t.y) * s.size.z;
}

struct Spot { pos: vec3f, n: vec3f, t: vec3f };

// World position/normal/tangent of the point X meters along face fc (from
// its center) at world height y.
fn spot(s: Segment, fc: Face, X: f32, y: f32) -> Spot {
  let h = clamp((y - s.pos.y) / s.size.y, 0.0, 1.0);
  let tp = mix(1.0, s.taper, h);
  let u = X / max(face_scale(s, fc) * tp, 1e-3);
  let lp = fc.center + fc.t * u;
  let x0 = seg_transform(s, vec3f(lp.x, h, lp.y), vec3f(fc.n.x, 0.0, fc.n.y));
  let lp2 = lp + fc.t * 0.01;
  let x1 = seg_transform(s, vec3f(lp2.x, h, lp2.y), vec3f(fc.n.x, 0.0, fc.n.y));
  var o: Spot;
  o.pos = x0.world;
  o.n = x0.normal;
  o.t = normalize(x1.world - x0.world);
  return o;
}

fn face_width(s: Segment, fc: Face, y: f32) -> f32 {
  let h = clamp((y - s.pos.y) / s.size.y, 0.0, 1.0);
  return fc.unitW * face_scale(s, fc) * mix(1.0, s.taper, h);
}

// Appends one instance. `ycen` is where the mesh's y-center is (0.5 for
// meshes spanning y in [0,1], 0 for centered ones). `fixedSize` meshes
// shrink as a whole when fading in; others extrude out of the wall.
fn emit(t: u32, sp: Spot, scl_in: vec3f, ycen: f32, color: u32, accent: u32, flags: u32, rank: f32, fixedSize: bool) {
  let ay = normalize(cross(sp.n, sp.t));
  let center = sp.pos + ay * (ycen * scl_in.y) + sp.n * (0.5 * scl_in.z);
  let radius = 0.5 * length(scl_in) + 0.5;
  let lim = type_range(t) * P.distScale * (0.55 + 0.45 * rank);
  let d = distance(center, P.camPos) - radius;
  if (d > lim) { return; }
  if (!in_frustum(center, radius)) { return; }
  // Extrude out of the wall (or grow) as the camera approaches.
  let fade = smoothstep(lim, lim * 0.82, d);
  var scl = scl_in;
  if (fixedSize) { scl *= fade; } else { scl.z *= fade; }
  if (scl.z < 0.01) { return; }
  if (P.useHiz != 0u && occluded(center, vec3f(radius))) { return; }
  let slot = atomicAdd(&draws[t].instanceCount, 1u);
  if (slot >= types[t].cap) {
    atomicSub(&draws[t].instanceCount, 1u);
    return;
  }
  var o: Inst;
  o.pos = sp.pos;
  o.sx = scl.x;
  o.ax = sp.t;
  o.sy = scl.y;
  o.az = sp.n;
  o.sz = scl.z;
  o.color = color;
  o.accent = accent;
  o.flags = flags;
  instances[types[t].base + slot] = o;
}

fn rgba(c: vec3f) -> u32 { return pack4x8unorm(vec4f(c, 1.0)); }

fn neon_accent(h: u32) -> u32 {
  let k = h % 6u;
  var c = vec3f(1.0, 0.1, 0.5);
  if (k == 1u) { c = vec3f(0.1, 0.9, 1.0); }
  if (k == 2u) { c = vec3f(1.0, 0.55, 0.1); }
  if (k == 3u) { c = vec3f(0.2, 1.0, 0.4); }
  if (k == 4u) { c = vec3f(1.0, 0.15, 0.1); }
  if (k == 5u) { c = vec3f(0.6, 0.3, 1.0); }
  return rgba(c);
}

// Window grid per style (must match facade.wgsl).
struct Grid { cellW: f32, x0: f32, x1: f32, y0: f32, y1: f32 };

fn grid_for(s: Segment, row: i32) -> Grid {
  switch s.style {
    case ST_GLASS: { return Grid(1.6, 0.06, 0.94, 0.14, 0.98); }
    case ST_RESIDENTIAL: { return Grid(3.4, 0.18, 0.82, 0.25, 0.85); }
    case ST_METAL: { return Grid(3.0, 0.04, 0.96, 0.35, 0.7); }
    case ST_SLUM: {
      let fid = bitcast<u32>(row);
      let cw = 2.2 + 2.5 * hash21(s.seed, fid);
      return Grid(cw, 0.15 + 0.1 * hash21(s.seed + 1u, fid), 0.8, 0.25, 0.8);
    }
    default: { return Grid(2.0, 0.08, 0.92, 0.15, 0.95); }
  }
}

@compute @workgroup_size(64)
fn cs_emit(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let si = near[wg.x];
  let s = segments[si];
  let fh = s.floorH;
  let j0 = i32(ceil(s.pos.y / fh));
  let j1 = i32(floor((s.pos.y + s.size.y) / fh));
  let nRows = max(j1 - j0, 0);
  let nf = prism_n(s);
  let style = s.style;
  let bodyHash = hash_u(s.seed ^ 0x3c6ef372u);
  let concrete = mix(vec3f(0.2, 0.19, 0.18), vec3f(0.27, 0.24, 0.2), u2f(bodyHash));
  let darkMetal = vec3f(0.07, 0.075, 0.085);
  let cellRange = 360.0 * P.distScale;

  // ---- Rooftop kitbash on exposed roofs: HVAC units, water tanks, dishes,
  // vent stacks on a jittered grid.
  if (has_roof(s)) {
    let tp = s.taper;
    let nx = max(i32(s.size.x * tp / 8.0), 1);
    let nz = max(i32(s.size.z * tp / 8.0), 1);
    let up = vec3f(0.0, 1.0, 0.0);
    for (var k = i32(li); k < nx * nz; k += 64) {
      let ix = k % nx;
      let iz = k / nx;
      let h = hash3_u(s.seed ^ 0x6a09e667u, bitcast<u32>(ix), bitcast<u32>(iz));
      let pick = u2f(h);
      if (pick > 0.62) { continue; }
      let lu = ((f32(ix) + 0.5) / f32(nx) - 0.5) * 0.9 + (u2f(h >> 4u) - 0.5) * 0.4 / f32(nx);
      let lv = ((f32(iz) + 0.5) / f32(nz) - 0.5) * 0.9 + (u2f(h >> 8u) - 0.5) * 0.4 / f32(nz);
      // Center built on (penthouse/crown): only around the edge.
      if ((s.flags & 64u) != 0u && max(abs(lu), abs(lv)) < 0.3) { continue; }
      // Round roofs: keep inside the circle.
      if (s.shape >= 2u && length(vec2f(lu, lv)) > 0.42) { continue; }
      let x = seg_transform(s, vec3f(lu, 1.0, lv), up);
      let ang = s.rotY + s.twist + f32((h >> 12u) % 4u) * PI * 0.5;
      var sp: Spot;
      sp.pos = x.world;
      sp.n = up;
      sp.t = vec3f(cos(ang), 0.0, sin(ang));
      let rank = u2f(h >> 16u);
      if (pick < 0.3) {
        let sx = 3.0 + 3.5 * u2f(h >> 20u);
        emit(T_HVAC, sp, vec3f(sx, sx * (0.5 + 0.4 * u2f(h >> 24u)), 1.2 + 1.2 * u2f(h >> 26u)), 0.0,
             rgba(vec3f(0.36, 0.37, 0.38)), neon_accent(h >> 5u), IF_LIT, rank, false);
      } else if (pick < 0.42) {
        let sc = 2.4 + 2.2 * u2f(h >> 20u);
        emit(T_TANK, sp, vec3f(sc), 0.0, rgba(mix(vec3f(0.3, 0.22, 0.16), vec3f(0.32, 0.33, 0.34), u2f(h >> 24u))), 0u, 0u, rank, true);
      } else if (pick < 0.48) {
        let sc = 1.5 + 2.0 * u2f(h >> 20u);
        emit(T_DISH, sp, vec3f(sc), 0.0, rgba(vec3f(0.55, 0.55, 0.53)), 0u, 0u, rank, true);
      } else {
        let sc = 1.0 + 2.2 * u2f(h >> 20u);
        emit(T_VENTSTACK, sp, vec3f(sc), 0.0, rgba(vec3f(0.3, 0.3, 0.31)), 0u, 0u, rank, true);
      }
    }
  }
  if (!has_details(s)) { return; }

  for (var f = 0u; f < nf; f++) {
    let fc = face_of(s, f, nf);
    // Skip faces turned away from the camera.
    let midY = clamp(P.camPos.y, s.pos.y, s.pos.y + s.size.y);
    let fsp = spot(s, fc, 0.0, midY);
    let toCam = P.camPos - fsp.pos;
    if (dot(toCam, fsp.n) < -2.0) { continue; }
    let wBase = face_width(s, fc, s.pos.y);
    let horiz = max(length(toCam.xz) - wBase * 0.5, 0.0);

    // ---- Row items: slab ledges / bands.
    var every = 1;
    var ledgeH = 0.22;
    var ledgeD = 0.32;
    // Every `bandEvery` floors a deep band / maintenance catwalk.
    var bandEvery = 0;
    if (style == ST_GLASS) { ledgeH = 0.2; ledgeD = 0.25; bandEvery = 6; }
    if (style == ST_METAL) { every = 2; ledgeH = 0.3; ledgeD = 0.35; bandEvery = 8; }
    if (style == ST_MONOLITH) { every = 3; ledgeH = 0.5; ledgeD = 0.45; }
    if (style == ST_PODIUM) { every = 1; ledgeH = 0.25; ledgeD = 0.3; }
    if (every > 0) {
      for (var k = i32(li); k < nRows; k += 64) {
        let row = j0 + k;
        if (row % every != 0) { continue; }
        let y = f32(row) * fh;
        let w = face_width(s, fc, y);
        let rh = hash3_u(s.seed, f, bitcast<u32>(row));
        if (style == ST_PODIUM && y < 7.5) { continue; }
        var d = ledgeD;
        var th = ledgeH;
        var col = concrete * 1.15;
        if (style == ST_SLUM) { d = 0.15 + 0.35 * u2f(rh); }
        if (bandEvery > 0 && row % bandEvery == 0) {
          d = 0.9;
          th = 0.55;
          col = darkMetal * 1.6;
        } else if (style == ST_GLASS || style == ST_METAL || style == ST_PODIUM) {
          col = darkMetal * 1.3;
        }
        emit(T_LEDGE, spot(s, fc, 0.0, y), vec3f(w + 0.2, th, d), 0.0, rgba(col), 0u, 0u, u2f(rh >> 8u), false);
      }
    }

    // ---- Column items, emitted in chunks of a few floors so they follow
    // tapers and twists: fins, ribs, piers, drain pipes.
    var spacing = 0.0;
    var colType = T_FIN;
    var colScl = vec3f(0.22, 1.0, 0.5);
    var colColor = rgba(darkMetal);
    var colOffset = 0.0;
    var y0 = s.pos.y;
    if (style == ST_GLASS) { spacing = 3.2; }
    if (style == ST_METAL) { spacing = 3.0; colScl = vec3f(0.2, 1.0, 0.4); colColor = rgba(vec3f(0.12, 0.12, 0.13)); }
    if (style == ST_MONOLITH) { spacing = 6.0; colOffset = 0.36; colScl = vec3f(0.9, 1.0, 1.1); colColor = rgba(vec3f(0.05, 0.045, 0.04)); }
    if (style == ST_PODIUM) { spacing = 4.0; y0 = max(s.pos.y, 7.5); }
    if (style == ST_RESIDENTIAL || style == ST_SLUM) {
      spacing = select(3.4 * 4.0, 2.6 * 3.0, style == ST_SLUM);
      colType = T_PIPE;
      colScl = vec3f(0.24, 1.0, 0.24);
    }
    if (spacing > 0.0) {
      let chunk = fh * 6.0;
      let nChunks = i32(ceil((s.pos.y + s.size.y - y0) / chunk));
      let nCols = i32(floor(wBase / spacing));
      let total = nCols * nChunks;
      for (var k = i32(li); k < total; k += 64) {
        let col = k % nCols;
        let ch = k / nCols;
        let X = (f32(col) - f32(nCols - 1) * 0.5) * spacing + colOffset;
        let ch0 = y0 + f32(ch) * chunk;
        let ch1 = min(ch0 + chunk, s.pos.y + s.size.y);
        if (ch1 - ch0 < 0.5) { continue; }
        let ch_h = hash3_u(s.seed ^ 0x9e37u, f, bitcast<u32>(col));
        // Pipes only on a few columns.
        if (colType == T_PIPE && (ch_h & 3u) != 0u) { continue; }
        let wTop = face_width(s, fc, ch1);
        if (abs(X) > wTop * 0.5 - 0.3) { continue; }
        let a = spot(s, fc, X, ch0);
        let b = spot(s, fc, X, ch1);
        var sp = a;
        sp.t = a.t;
        var flags = 0u;
        if (style == ST_GLASS && (ch_h >> 8u) % 5u == 0u) { flags = IF_LIT; }
        var cs = colScl;
        // Every 4th mullion on curtain walls is a heavy structural pier.
        if ((style == ST_GLASS || style == ST_PODIUM) && col % 4 == 0) { cs = vec3f(0.8, 1.0, 1.0); }
        emit(colType, sp, vec3f(cs.x, distance(a.pos, b.pos), cs.z), 0.5, colColor, rgba(unpack_color(s.colorB)), flags, u2f(ch_h >> 12u), false);
      }
    }

    // ---- Bolted-on room modules (Kowloon / Chongqing extensions): the
    // mid-scale relief that still reads hundreds of meters away.
    {
      var pMod = 0.0;
      if (style == ST_SLUM) { pMod = 0.3; }
      if (style == ST_RESIDENTIAL) { pMod = 0.12; }
      if (style == ST_METAL) { pMod = 0.07; }
      if (style == ST_GLASS || style == ST_PODIUM) { pMod = 0.03; }
      if (pMod > 0.0) {
        let slotH = fh * 3.0;
        let ny = i32(floor(s.size.y / slotH));
        let nx = max(i32(floor(wBase / 11.0)), 1);
        for (var k = i32(li); k < nx * ny; k += 64) {
          let ix = k % nx;
          let iy = k / nx;
          let mh = hash3_u(s.seed ^ 0x2f6b1e9du, f * 131u + bitcast<u32>(ix), bitcast<u32>(iy));
          if (u2f(mh) > pMod) { continue; }
          let floors = 1.0 + f32((mh >> 8u) % 3u);
          let y = s.pos.y + f32(iy) * slotH;
          let hgt = floors * fh - 0.3;
          if (y + hgt > s.pos.y + s.size.y - 1.0 || y < 3.0) { continue; }
          let wTop = face_width(s, fc, y + hgt);
          let wm = 4.0 + 6.0 * u2f(mh >> 12u);
          let X = (f32(ix) - f32(nx - 1) * 0.5) * (wBase / f32(nx)) + (u2f(mh >> 16u) - 0.5) * 3.0;
          if (abs(X) + wm * 0.5 > wTop * 0.5 - 0.5) { continue; }
          let depth = 2.0 + 3.5 * u2f(mh >> 20u);
          let tone = u2f(mh >> 24u);
          let col = mix(concrete * mix(0.8, 1.3, tone), darkMetal * 2.2, step(0.65, tone));
          emit(T_MODULE, spot(s, fc, X, y), vec3f(wm, hgt, depth), 0.5, rgba(col), rgba(vec3f(1.0, 0.72, 0.45)), select(0u, IF_LIT, (mh & 3u) != 0u), u2f(mh >> 4u), false);
        }
      }
    }

    // ---- External service shafts / elevator cores: big boxes up the face.
    {
      let fhh = hash3_u(s.seed ^ 0x7f4a7c15u, f, 3u);
      let nShaft = i32(fhh % 3u);
      let chunk = fh * 6.0;
      let nChunks = i32(ceil(s.size.y / chunk));
      for (var k = i32(li); k < nShaft * nChunks; k += 64) {
        let si2 = k / nChunks;
        let ch = k % nChunks;
        let sh = hash3_u(fhh, bitcast<u32>(si2), 11u);
        let X = (u2f(sh) - 0.5) * (wBase - 6.0);
        let ch0 = s.pos.y + f32(ch) * chunk;
        let ch1 = min(ch0 + chunk, s.pos.y + s.size.y);
        if (abs(X) > face_width(s, fc, ch1) * 0.5 - 2.0) { continue; }
        let a = spot(s, fc, X, ch0);
        let b = spot(s, fc, X, ch1);
        let wsh = 1.6 + 1.6 * u2f(sh >> 8u);
        emit(T_FIN, a, vec3f(wsh, distance(a.pos, b.pos), 0.9 + 0.8 * u2f(sh >> 16u)), 0.5,
             rgba(mix(darkMetal * 1.5, concrete, u2f(sh >> 4u))), rgba(unpack_color(s.colorB)),
             select(0u, IF_LIT, (sh & 7u) < 3u), u2f(sh >> 20u), false);
      }
    }

    // ---- Shop canopies along the podium's ground floor.
    if (style == ST_PODIUM && s.pos.y < 1.0) {
      let nBays = i32(floor(wBase / 8.0));
      for (var k = i32(li); k < nBays; k += 64) {
        let X = (f32(k) - f32(nBays - 1) * 0.5) * 8.0;
        let hb = hash3_u(s.seed, f, bitcast<u32>(k) + 77u);
        if ((hb & 3u) == 0u) { continue; }
        emit(T_CANOPY, spot(s, fc, X, 4.9), vec3f(7.2, 1.0, 1.0), 0.0, rgba(darkMetal), rgba(vec3f(1.0, 0.85, 0.6)), IF_LIT, u2f(hb >> 4u), false);
      }
    }

    // ---- Cell items near the camera: balconies, AC units, cages, awnings, vents.
    if (style == ST_RESIDENTIAL || style == ST_SLUM || style == ST_METAL) {
      if (horiz > cellRange) { continue; }
      let band = sqrt(max(cellRange * cellRange - horiz * horiz, 0.0));
      let ya = max(s.pos.y, P.camPos.y - band);
      let yb = min(s.pos.y + s.size.y, P.camPos.y + band);
      let ra = max(i32(floor(ya / fh)), j0);
      let rb = min(i32(ceil(yb / fh)), j1);
      if (rb <= ra) { continue; }
      let nr = rb - ra;
      let maxCols = i32(wBase / 2.2) + 1;
      let total = nr * maxCols;
      for (var k = i32(li); k < total; k += 64) {
        let row = ra + k / maxCols;
        let ci = k % maxCols;
        let g = grid_for(s, row);
        let y = f32(row) * fh;
        let w = face_width(s, fc, y + fh * 0.5);
        let nCols = i32(floor(w / g.cellW));
        if (ci >= nCols) { continue; }
        let left = (f32(ci) - f32(nCols) * 0.5) * g.cellW;
        let cx = left + g.cellW * 0.5;
        let h = hash3_u(s.seed, f * 977u + bitcast<u32>(ci), bitcast<u32>(row));
        let r = u2f(h);
        let rank = u2f(h >> 7u);
        let winW = (g.x1 - g.x0) * g.cellW;
        let winH = (g.y1 - g.y0) * fh;
        let winCx = left + (g.x0 + g.x1) * 0.5 * g.cellW;
        if (style == ST_RESIDENTIAL) {
          // Balcony stacks: whole columns of balconies, a few missing.
          let colH = hash3_u(s.seed ^ 0x51u, f, bitcast<u32>(ci));
          if (u2f(colH) < 0.45 && r < 0.9 && row > j0) {
            var fl = 0u;
            if ((colH >> 9u) % 3u == 0u) { fl |= IF_GLASS; }
            if ((h >> 13u) % 4u == 0u) { fl |= IF_LIT; }
            emit(T_BALCONY, spot(s, fc, cx, y + 0.02), vec3f(g.cellW * 0.95, 1.0, 1.0), 0.5, rgba(concrete * 1.1), rgba(vec3f(1.0, 0.75, 0.45)), fl, rank, false);
          } else if (r < 0.45) {
            let side = select(-1.0, 1.0, (h & 1024u) != 0u);
            emit(T_AC, spot(s, fc, winCx + side * (winW * 0.5 - 0.5), y + g.y0 * fh + 0.05), vec3f(1.0), 0.3, rgba(vec3f(0.42, 0.43, 0.42)), neon_accent(h >> 3u), IF_LIT, rank, true);
          }
        } else if (style == ST_SLUM) {
          if (r < 0.3) {
            emit(T_CAGE, spot(s, fc, winCx, y + g.y0 * fh + winH * 0.5), vec3f(winW * 1.08, winH * 1.06, 1.0), 0.0, rgba(concrete), neon_accent(h >> 5u), 0u, rank, false);
          } else if (r < 0.48) {
            emit(T_AWNING, spot(s, fc, winCx, y + g.y1 * fh + 0.12), vec3f(winW + 0.4, 1.0, 1.0), -0.3, rgba(concrete), neon_accent(h >> 5u), 0u, rank, false);
          }
          if (((h >> 16u) & 7u) < 3u) {
            let xo = select(-0.3, 0.3, (h & 2048u) != 0u) * winW;
            emit(T_AC, spot(s, fc, winCx + xo, y + 0.15), vec3f(1.0), 0.3, rgba(vec3f(0.38, 0.38, 0.36)), neon_accent(h >> 9u), IF_LIT, u2f(h >> 19u), true);
          }
        } else if (style == ST_METAL) {
          if (r < 0.3) {
            emit(T_VENT, spot(s, fc, cx, y + 0.08 * fh), vec3f(1.0), 0.5, rgba(vec3f(0.16, 0.16, 0.17)), 0u, 0u, rank, true);
          }
        }
      }
    }
  }
}
