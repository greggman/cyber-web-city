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
const T_STALL = 9u;
const T_HVAC = 10u;
const T_TANK = 11u;
const T_DISH = 12u;
const T_VENTSTACK = 13u;
const T_LAUNDRY = 14u;
const T_LOUVRE = 15u;
const T_CATWALK = 16u;
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
@group(0) @binding(4) var<storage, read_write> draws: array<DrawArgs, 17>;
@group(0) @binding(5) var<storage, read_write> instances: array<Inst>;
@group(0) @binding(6) var<storage, read> types: array<TypeInfo, 17>;
@group(0) @binding(7) var hiz: texture_2d<f32>;
// Ad screens hang just off the wall: details under them would poke through.
// segRange[segment] = (first, count) into blockers.
struct Blocker { pos: vec3f, hw: f32, right: vec3f, hh: f32, normal: vec3f, _p: f32 };
@group(0) @binding(8) var<storage, read> segRange: array<vec2u>;
@group(0) @binding(9) var<storage, read> blockers: array<Blocker>;

var<private> g_si: u32;

fn blocked(c: vec3f, r: f32) -> bool {
  let rg = segRange[g_si];
  for (var k = rg.x; k < rg.x + rg.y; k++) {
    let b = blockers[k];
    let d = c - b.pos;
    let dn = dot(d, b.normal);
    if (abs(dot(d, b.right)) < b.hw + r && abs(d.y) < b.hh + r && dn > -4.0 - r && dn < 4.0 + r) {
      return true;
    }
  }
  return false;
}

// Max distance (m) at which each type is generated (scaled by quality).
fn type_range(t: u32) -> f32 {
  switch t {
    case T_STALL: { return 300.0; }
    case T_HVAC, T_TANK: { return 700.0; }
    case T_DISH, T_VENTSTACK: { return 450.0; }
    case T_LEDGE, T_FIN, T_PIPE, T_LOUVRE, T_CATWALK: { return 650.0; }
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

// Big open box roofs sometimes carry a painted helipad (facade.wgsl,
// rooftops.ts).
fn helipad(s: Segment) -> bool {
  return s.shape <= 1u && min(s.size.x, s.size.z) * s.taper > 40.0 && (s.seed & 7u) < 2u && (s.flags & 64u) == 0u;
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
  // Hero faces (on the flight corridors) keep their kit 1.5x further out.
  let hero = select(1.0, 1.5, (segments[g_si].flags & 128u) != 0u);
  let lim = type_range(t) * P.distScale * hero * (0.55 + 0.45 * rank);
  let d = distance(center, P.camPos) - radius;
  if (d > lim) { return; }
  if (!in_frustum(center, radius)) { return; }
  if (blocked(center, radius)) { return; }
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

// Muted, varied clothing colours for laundry.
fn laundry_color(h: u32) -> u32 {
  let c = vec3f(f32(h & 255u), f32((h >> 8u) & 255u), f32((h >> 16u) & 255u)) / 255.0;
  return rgba(mix(c, vec3f(0.6), 0.3));
}

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

// Taper scale at world height y.
fn tp_at(s: Segment, y: f32) -> f32 {
  return mix(1.0, s.taper, clamp((y - s.pos.y) / s.size.y, 0.0, 1.0));
}

@compute @workgroup_size(64)
fn cs_emit(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let si = near[wg.x];
  g_si = si;
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
  let cellRange = 360.0 * P.distScale * select(1.0, 1.5, (s.flags & 128u) != 0u);

  // ---- Rooftops (ART_BIBLE.md 9): composed around the core penthouse
  // (rooftops.ts places it: roof_core()), not scattered. HVAC units in a
  // row along its long side, a tank group at one end, vent stacks along
  // its wall, dishes near the parapet, a 1.1 m parapet on every edge; the
  // rest of the roof stays clear.
  if (has_roof(s)) {
    let tp = s.taper;
    let RX = s.size.x * tp;
    let RZ = s.size.z * tp;
    let longX = RX >= RZ;
    let L = max(RX, RZ);
    let S = min(RX, RZ);
    let up = vec3f(0.0, 1.0, 0.0);
    let core = roof_core(s);
    let cA = 0.16 * L;
    let cB = 0.16 * S;
    let hh = hash_u(s.seed ^ 0x2b2ae3u);
    let side = select(-1.0, 1.0, (hh & 1u) != 0u);
    let nH = 4 + i32((hh >> 4u) % 5u);
    let nT = 2 + i32((hh >> 8u) % 5u);
    let nV = 3 + i32((hh >> 12u) % 4u);
    let nD = i32((hh >> 16u) % 5u);
    let hvacS = 3.0 + 2.5 * u2f_rot(hh, 20u);
    let tankS = 2.4 + 1.4 * u2f_rot(hh, 24u);
    let ang = s.rotY + s.twist + select(PI * 0.5, 0.0, longX);
    let dirA = vec3f(cos(ang), 0.0, sin(ang));
    for (var k = i32(li); k < 48; k += 64) {
      var a = 0.0;
      var b = 0.0;
      var t = T_HVAC;
      var scl = vec3f(1.0);
      var fixedSize = false;
      var col = rgba(vec3f(0.36, 0.37, 0.38));
      var flags = 0u;
      if (k < 6 || k >= 30) {
        // k 0..5 and 30..35: HVAC rows; 36..47: extra clusters below.
        // HVAC rows: one along the core, a second on its far side on big
        // roofs.
        let q = select(k, k - 30, k >= 30 && k < 36);
        if (k >= 36) {
          // A second tank group at the other end (k 36..41) and a vent
          // stack farm along the far edge (42..47).
          let q2 = k - 36;
          if (q2 < 6) {
            if (q2 >= nT || L < 30.0) { continue; }
            let c2 = q2 / 2;
            let r2 = q2 % 2;
            let pitch = tankS + 0.8;
            a = -(L * 0.5 - 3.1 - tankS * 0.5 - f32(c2) * pitch) * select(1.0, -1.0, (hh & 2u) != 0u);
            b = (f32(r2) - 0.5) * pitch + (S * 0.5 - 3.1 - pitch) * side;
            t = T_TANK;
            scl = vec3f(tankS);
            fixedSize = true;
            col = rgba(mix(vec3f(0.32, 0.3, 0.27), vec3f(0.28, 0.2, 0.15), u2f_rot(hh, 26u)));
          } else {
            let q3 = q2 - 6;
            a = (f32(q3) - 2.5) * 2.2;
            b = -side * (S * 0.5 - 2.2);
            t = T_VENTSTACK;
            scl = vec3f(1.2 + 0.6 * u2f_rot(hh, u32(q3) + 3u));
            fixedSize = true;
            col = rgba(vec3f(0.3, 0.3, 0.31));
          }
        } else {
        let ringRoof = (s.flags & 64u) != 0u;
        if (q >= nH || (k >= 30 && (L < 25.0 || !(core || ringRoof)))) { continue; }
        let spacing = hvacS + 1.5;
        a = (f32(q) - f32(nH - 1) * 0.5) * spacing;
        b = select(S * 0.5 - 3.1 - hvacS * 0.5, cB + 3.0 + hvacS * 0.5, core) * select(side, -side, k >= 30);
        scl = vec3f(hvacS, hvacS * 0.7, 1.6);
        flags = IF_LIT;
        }
      } else if (k < 12) {
        let q = k - 6;
        if (q >= nT) { continue; }
        let c2 = q / 2;
        let r2 = q % 2;
        let pitch = tankS + 0.8;
        let a0 = select(L * 0.5 - 3.1 - tankS * 0.5 - f32(c2) * pitch, cA + 2.0 + tankS * 0.5 + f32(c2) * pitch, core);
        a = a0 * select(1.0, -1.0, (hh & 2u) != 0u);
        b = (f32(r2) - 0.5) * pitch - select(S * 0.5 - 3.1 - pitch, 0.0, core) * side;
        t = T_TANK;
        scl = vec3f(tankS);
        fixedSize = true;
        col = rgba(mix(vec3f(0.3, 0.22, 0.16), vec3f(0.32, 0.33, 0.34), u2f_rot(hh, 28u)));
      } else if (k < 18) {
        let q = k - 12;
        if (!core || q >= nV) { continue; }
        a = (f32(q) - f32(nV - 1) * 0.5) * 2.0;
        b = -side * (cB + 1.0);
        t = T_VENTSTACK;
        scl = vec3f(1.6);
        fixedSize = true;
        col = rgba(vec3f(0.3, 0.3, 0.31));
      } else if (k < 22) {
        let q = k - 18;
        if (q >= nD) { continue; }
        let hd = hash_u(hh + u32(q) * 31u);
        a = (u2f(hd) - 0.5) * (L - 6.0);
        b = select(-1.0, 1.0, (hd & 256u) != 0u) * (S * 0.5 - 1.3);
        t = T_DISH;
        scl = vec3f(1.5 + 1.5 * u2f_rot(hd, 12u));
        fixedSize = true;
        col = rgba(vec3f(0.55, 0.55, 0.53));
      } else if (k < 26) {
        if (s.shape > 1u) { continue; }
        // Parapet on each edge (the ledge mesh, standing 1.1 m tall).
        let f = u32(k - 22);
        if (f >= 4u) { continue; }
        let fc = face_of(s, f, 4u);
        let top = s.pos.y + s.size.y;
        emit(T_LEDGE, spot(s, fc, 0.0, top + 0.55), vec3f(face_width(s, fc, top) + 0.2, 1.1, 0.22), 0.0, rgba(vec3f(0.24, 0.23, 0.22)), 0u, 0u, 1.0, false);
        continue;
      } else {
        continue;
      }
      // Ring roofs keep the centre clear.
      if ((s.flags & 64u) != 0u && abs(a) < cA + 2.0 && abs(b) < cB + 2.0) { continue; }
      if (abs(a) > L * 0.5 - 1.0 || abs(b) > S * 0.5 - 1.0) { continue; }
      let lu = select(b / RX, a / RX, longX);
      let lv = select(a / RZ, b / RZ, longX);
      if (helipad(s) && length(vec2f(lu * RX, lv * RZ)) < 13.0) { continue; }
      if (s.shape >= 2u && length(vec2f(lu, lv)) > 0.42) { continue; }
      let x = seg_transform(s, vec3f(lu, 1.0, lv), up);
      var sp: Spot;
      sp.pos = x.world;
      sp.n = up;
      sp.t = dirA;
      emit(t, sp, scl, 0.0, col, neon_accent(hh >> 5u), flags, 1.0, fixedSize);
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
    // Mechanical floor every 15 floors on curtain walls (ART_BIBLE C1).
    if (style == ST_GLASS) { ledgeH = 0.2; ledgeD = 0.25; bandEvery = 15; }
    if (style == ST_METAL) { every = 2; ledgeH = 0.3; ledgeD = 0.35; }
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
        if (style == ST_SLUM) { d = 0.15 + 0.35 * u2f_rot(bodyHash, 5u); }
        if (bandEvery > 0 && row % bandEvery == 0) {
          d = 0.9;
          th = 0.55;
          col = darkMetal * 1.6;
          // Mechanical floor: a louvre band over the double-height floor and,
          // on the flight corridors, a maintenance catwalk on the ledge.
          if (style == ST_GLASS && y + 2.0 * fh < s.pos.y + s.size.y) {
            emit(T_LOUVRE, spot(s, fc, 0.0, y + 0.6), vec3f(w, 2.0 * fh - 1.2, 1.0), 0.5, rgba(darkMetal * 1.1), 0u, 0u, 1.0, false);
            if ((s.flags & 128u) != 0u) {
              emit(T_CATWALK, spot(s, fc, 0.0, y + 0.3), vec3f(w, 1.0, 1.0), 0.5, rgba(darkMetal * 2.2), 0u, 0u, 1.0, false);
            }
          }
        } else if (style == ST_GLASS || style == ST_METAL || style == ST_PODIUM) {
          col = darkMetal * 1.3;
        }
        emit(T_LEDGE, spot(s, fc, 0.0, y), vec3f(w + 0.2, th, d), 0.0, rgba(col), 0u, 0u, u2f_rot(rh, 8u), false);
      }
    }

    // Everything below snaps to the shared bay grid (segment.wgsl), the
    // same grid facade.wgsl draws its windows on (ART_BIBLE.md 3 and 6).
    // Faceted/round shapes only get ledges.
    if (s.shape > 1u) { continue; }
    let bay = seg_bay(s);
    let nB = face_bays(wBase, bay);
    if (nB <= 0) { continue; }
    let halfB = f32(nB) * bay * 0.5;
    let pierW = wBase * 0.5 - halfB;

    // ---- Vertical runs, chunked so they follow tapers and twists:
    // mullion fins and structural piers on bay lines, risers in service
    // bays, downpipes in the corner piers.
    {
      let chunk = fh * 6.0;
      var yBase = s.pos.y;
      if (style == ST_PODIUM) { yBase = max(s.pos.y, 7.5); }
      let nChunks = i32(ceil((s.pos.y + s.size.y - yBase) / chunk));
      let nLines = nB + 1;
      let perChunk = nLines + nB * 3 + 2;
      let total = perChunk * max(nChunks, 0);
      for (var k = i32(li); k < total; k += 64) {
        let ch = k / perChunk;
        let slot = k % perChunk;
        let ch0 = yBase + f32(ch) * chunk;
        let ch1 = min(ch0 + chunk, s.pos.y + s.size.y);
        if (ch1 - ch0 < 0.5) { continue; }
        var X = 0.0;
        var t = T_FIN;
        var scl = vec3f(0.0);
        var col = rgba(darkMetal);
        if (slot < nLines) {
          // Line between bays slot-1 and slot.
          X = (f32(slot) - f32(nB) * 0.5) * bay;
          if (style == ST_GLASS || style == ST_PODIUM) {
            // Mullion fin every 3 modules, structural pier every 6.
            if (slot % 3 != 0) { continue; }
            scl = select(vec3f(0.14, 1.0, 0.2), vec3f(0.8, 1.0, 0.6), slot % 6 == 0);
            col = rgba(darkMetal * 1.3);
          } else if (style == ST_MONOLITH) {
            scl = vec3f(0.9, 1.0, 0.9);
            col = rgba(vec3f(0.05, 0.045, 0.04));
          } else if (style == ST_METAL) {
            if (slot % 4 != 0) { continue; }
            scl = vec3f(0.2, 1.0, 0.35);
            col = rgba(vec3f(0.12, 0.12, 0.13));
          } else {
            continue;
          }
        } else if (slot < nLines + nB * 3) {
          let q = slot - nLines;
          let i = q / 3;
          let p = q % 3;
          if (bay_class(s, i, nB) != BAY_S) { continue; }
          if (style == ST_SLUM && p == 2) { continue; }
          X = bay_center(i, nB, bay) + (f32(p) - 1.0) * 0.45;
          t = T_PIPE;
          let pr = 0.2 + 0.06 * f32(p);
          scl = vec3f(pr, 1.0, pr);
          col = rgba(darkMetal * 1.4);
        } else {
          if (style != ST_RESIDENTIAL && style != ST_SLUM) { continue; }
          if (pierW < 0.45) { continue; }
          let side = select(-1.0, 1.0, slot == perChunk - 1);
          X = side * (halfB + pierW * 0.5);
          t = T_PIPE;
          scl = vec3f(0.2, 1.0, 0.2);
          col = rgba(darkMetal * 1.4);
        }
        let a = spot(s, fc, X * tp_at(s, ch0), ch0);
        let b = spot(s, fc, X * tp_at(s, ch1), ch1);
        emit(t, a, vec3f(scl.x, distance(a.pos, b.pos), scl.z), 0.5, col, rgba(unpack_color(s.colorB)), 0u, 1.0, false);
      }
    }

    // ---- Shop canopies on the podium's 8 m shop bays (facade.wgsl
    // shopfront uses the same grid); depth and height vary per shop.
    if (style == ST_PODIUM && s.pos.y < 1.0) {
      let sb = shop_bay(s);
      let nS = face_bays(wBase, sb);
      let market = seg_typology(s) == DISTRICT_MARKET || seg_typology(s) == DISTRICT_SLUM;
      for (var k = i32(li); k < nS; k += 64) {
        let sp = shop_params(s, k, nS);
        let X = bay_center(k, nS, sb);
        // Canopy at the shop's mount height, 1.5 / 2.5 / 3.5 m deep (the
        // mesh is 1.7 m deep at scale 1); the fascia sign sits above it.
        emit(T_CANOPY, spot(s, fc, X, sp.y), vec3f(sb * 0.9, 1.0, sp.x / 1.7), 0.0, rgba(darkMetal), rgba(vec3f(1.0, 0.85, 0.6)), select(IF_LIT, 0u, sp.w > 0.5), 1.0, false);
        // Market and slum streets: a stall in front of most open shops.
        let hs = hash3_u(s.seed ^ 0x51ed27u, bitcast<u32>(min(k, nS - 1 - k)), 3u);
        if (market && sp.w < 0.5 && u2f(hs) < 0.7) {
          let off = (u2f_rot(hs, 8u) - 0.5) * (sb - 2.4);
          emit(T_STALL, spot(s, fc, X + off, 0.0), vec3f(1.0), 0.0, rgba(mix(vec3f(0.35, 0.25, 0.18), vec3f(0.3, 0.3, 0.32), u2f_rot(hs, 12u))), neon_accent(hs >> 3u), IF_LIT, u2f_rot(hs, 16u), true);
        }
      }
    }

    // ---- Cell items near the camera, by bay class. The column decides the
    // item type and side, the unit (floor) only decides presence; positions
    // are exact functions of the window opening.
    if (style == ST_RESIDENTIAL || style == ST_SLUM || style == ST_METAL) {
      if (horiz > cellRange) { continue; }
      let band = sqrt(max(cellRange * cellRange - horiz * horiz, 0.0));
      let ya = max(s.pos.y, P.camPos.y - band);
      let yb = min(s.pos.y + s.size.y, P.camPos.y + band);
      let ra = max(i32(floor(ya / fh)), j0);
      let rb = min(i32(ceil(yb / fh)), j1);
      if (rb <= ra) { continue; }
      let total = (rb - ra) * nB;
      for (var k = i32(li); k < total; k += 64) {
        let row = ra + k / nB;
        let i = k % nB;
        let cls = bay_class(s, i, nB);
        if (cls == BAY_S || cls == BAY_C) { continue; }
        let y = f32(row) * fh;
        let tpy = tp_at(s, y + 0.5 * fh);
        let r = win_rect(s, cls);
        let bw = bay * tpy;
        let cx = bay_center(i, nB, bay) * tpy;
        let winW = (r.y - r.x) * bw;
        let winCx = cx + ((r.x + r.y) * 0.5 - 0.5) * bw;
        let winY0 = y + r.z * fh;
        let winY1 = y + r.w * fh;
        let hc = hash3_u(s.seed ^ 0x51u, f, bitcast<u32>(i));
        let hu = hash3_u(hc, bitcast<u32>(row), 7u);
        let pu = u2f(hu);
        let rank = u2f_rot(hu, 7u);
        let side = select(-1.0, 1.0, (hc & 1024u) != 0u);
        if (style == ST_RESIDENTIAL) {
          if (row <= j0) { continue; }
          if (cls == BAY_N) {
            emit(T_VENT, spot(s, fc, winCx, winY1 + 0.08), vec3f(0.55), 0.5, rgba(vec3f(0.3, 0.3, 0.31)), 0u, 0u, rank, true);
          } else if (u2f(hc) < 0.45) {
            // Balcony column: same railing all the way up.
            var fl = 0u;
            if (u2f_rot(hc, 9u) < 0.33) { fl |= IF_GLASS; }
            if (u2f_rot(hu, 13u) < 0.3) { fl |= IF_LIT; }
            emit(T_BALCONY, spot(s, fc, cx, y + 0.02), vec3f(bw * 0.95, 1.0, 1.0), 0.5, rgba(concrete * 1.1), rgba(vec3f(1.0, 0.75, 0.45)), fl, rank, false);
          } else {
            // AC under the window, on this column's side.
            if (pu < 0.8) {
              emit(T_AC, spot(s, fc, winCx + side * (winW * 0.5 - 0.5), winY0 + 0.05), vec3f(1.0), 0.3, rgba(vec3f(0.55, 0.55, 0.52)), neon_accent(hu >> 3u), IF_LIT, rank, true);
            }
            if (u2f_rot(hu, 17u) < 0.12) {
              emit(T_CAGE, spot(s, fc, winCx, (winY0 + winY1) * 0.5), vec3f(winW * 1.08, (winY1 - winY0) * 1.06, 1.0), 0.0, rgba(concrete), neon_accent(hu >> 5u), 0u, rank, false);
            } else if (u2f_rot(hu, 21u) < 0.4) {
              emit(T_LAUNDRY, spot(s, fc, winCx, winY1 - 0.05), vec3f(1.0), -0.4, rgba(vec3f(0.2)), laundry_color(hu), 0u, rank, true);
            }
          }
        } else if (style == ST_SLUM) {
          let ct = u2f(hc);
          if (ct < 0.35) {
            if (pu < 0.75) {
              emit(T_CAGE, spot(s, fc, winCx, (winY0 + winY1) * 0.5), vec3f(winW * 1.08, (winY1 - winY0) * 1.06, 1.0), 0.0, rgba(concrete), neon_accent(hc >> 5u), 0u, rank, false);
            }
          } else if (ct < 0.6) {
            if (pu > 0.7 && u2f_rot(hu, 21u) < 0.6) {
              emit(T_LAUNDRY, spot(s, fc, winCx, winY1 - 0.05), vec3f(1.0), -0.4, rgba(vec3f(0.2)), laundry_color(hu), 0u, rank, true);
            }
            if (pu < 0.7) {
              emit(T_AWNING, spot(s, fc, winCx, winY1 + 0.12), vec3f(winW + 0.4, 1.0, 1.0), -0.3, rgba(concrete), neon_accent(hc >> 5u), 0u, rank, false);
            }
          }
          if (u2f_rot(hu, 16u) < 0.5) {
            emit(T_AC, spot(s, fc, winCx + side * 0.3 * winW, y + 0.15), vec3f(1.0), 0.3, rgba(vec3f(0.5, 0.5, 0.47)), neon_accent(hu >> 9u), IF_LIT, u2f_rot(hu, 19u), true);
          }
        } else {
          // Metal: louvred vents every third floor, on a few columns.
          if (row % 3 == 0 && u2f(hc) < 0.2) {
            emit(T_VENT, spot(s, fc, cx, y + 0.08 * fh), vec3f(1.0), 0.5, rgba(vec3f(0.16, 0.16, 0.17)), 0u, 0u, rank, true);
          }
        }
      }
    }
  }
}
