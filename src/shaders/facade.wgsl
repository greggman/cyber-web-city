// Procedural facade materials. All detail comes from the shader, not geometry:
// window grids with interior mapping (fake rooms with parallax), blinds,
// curtains and silhouettes, LED facades, edge strips, roofs and the ground.
#include "lighting.wgsl"

struct Shaded { color: vec3f, normal: vec3f, roughness: f32, reflectivity: f32 };

// Style ids (src/city/segments.ts).
const ST_GLASS = 0u;
const ST_RESIDENTIAL = 1u;
const ST_METAL = 2u;
const ST_LED = 3u;
const ST_SLUM = 4u;
const ST_MONOLITH = 5u;
const ST_PODIUM = 6u;
const ST_STRUCTURE = 7u;
const ST_NEONRING = 8u;
const ST_BRIDGE = 9u;
const ST_GROUND = 10u;

const F_EDGE = 1u;
const F_BANDS = 2u;
const F_BEACON = 4u;
const F_NOWIN = 8u;
const F_TOPGLOW = 16u;

// Per-fragment context passed to the style functions.
struct Ctx {
  world: vec3f,
  n: vec3f,
  t: vec3f,          // horizontal tangent (direction of increasing facade.x)
  b: vec3f,          // bitangent (up along the wall)
  facade: vec2f,     // meters along wall, world height
  fw: vec2f,         // facade meters per pixel (for anti-aliasing)
  viewT: vec3f,      // view direction in tangent space (z into the wall)
  seed: u32,
  time: f32,
  hRel: f32,         // 0..1 height within segment
};

fn u_of(x: f32) -> u32 { return bitcast<u32>(i32(floor(x))); }

// Fraction of a box pulse [a, b] within [0, 1] cell coordinates, anti-aliased by width w.
fn aa_box(x: f32, a: f32, b: f32, w: f32) -> f32 {
  let ww = max(w, 1e-4);
  return saturate((x - a) / ww + 0.5) * saturate((b - x) / ww + 0.5);
}

// How much detail survives at this distance (1 = full, 0 = use averages).
fn detail(cellMeters: vec2f, fw: vec2f) -> f32 {
  let px = min(cellMeters.x / max(fw.x, 1e-5), cellMeters.y / max(fw.y, 1e-5));
  return smoothstep(2.0, 6.0, px);
}

fn light_color(kind: u32, h: f32, tint: vec3f) -> vec3f {
  // Mostly the building tint, with some variation in color temperature.
  var c = tint;
  if (h < 0.15) { c = vec3f(1.0, 0.62, 0.32); }           // tungsten
  else if (h < 0.25) { c = vec3f(0.75, 0.88, 1.0); }      // fluorescent
  else if (h < 0.28 && kind == ST_SLUM) { c = vec3f(1.0, 0.2, 0.6); }
  else if (h < 0.31 && kind == ST_SLUM) { c = vec3f(0.2, 1.0, 0.8); }
  else if (h < 0.33) { c = vec3f(0.4, 0.5, 1.0); }        // TV glow
  return c;
}

// Interior mapping: ray-cast into a fake room behind the window.
// f: position within the room's window plane (0..1), room: size in meters
// (width, height, depth), v: view direction in tangent space (z into room).
fn interior(f: vec2f, room: vec3f, v_in: vec3f, seed: u32, light: vec3f, kind: u32) -> vec3f {
  let v = vec3f(v_in.xy, max(v_in.z, 0.05));
  let p = vec3f(f * room.xy, 0.0);
  let tx = select(-p.x / v.x, (room.x - p.x) / v.x, v.x > 0.0);
  let ty = select(-p.y / v.y, (room.y - p.y) / v.y, v.y > 0.0);
  let tz = room.z / v.z;
  let t = min(min(abs(tx), abs(ty)), tz);
  let h = p + v * t;
  let hs = hash_u(seed);
  let wallTint = mix(vec3f(0.3, 0.27, 0.24), vec3f(0.55, 0.52, 0.5), u2f(hs));
  var c: vec3f;
  if (t == tz) {
    // Back wall with a darker wainscot and a picture/shelf.
    let uv = h.xy / room.xy;
    c = wallTint * (0.65 + 0.35 * smoothstep(0.0, 0.8, uv.y));
    let shelf = step(0.3, uv.x) * step(uv.x, 0.6) * step(0.45, uv.y) * step(uv.y, 0.75) * step(0.5, u2f(hs >> 3u));
    c = mix(c, vec3f(0.15, 0.12, 0.1), shelf * 0.8);
  } else if (t == abs(ty)) {
    if (v.y > 0.0) {
      // Ceiling with a light panel.
      let q = h.xz / room.xz;
      let panel = step(abs(q.x - 0.5), 0.2) * step(abs(q.y - 0.4), 0.15);
      c = vec3f(0.6) + panel * 3.0;
    } else {
      // Floor.
      c = mix(vec3f(0.22, 0.17, 0.13), vec3f(0.3, 0.3, 0.32), u2f(hs >> 5u)) * 0.6;
    }
  } else {
    c = wallTint * 0.8;
  }
  // Light falls off toward the back.
  c *= mix(1.15, 0.6, h.z / room.z);
  // Silhouettes (furniture/people) on a mid-depth plane.
  let zMid = room.z * (0.35 + 0.3 * u2f(hs >> 7u));
  let tm = zMid / v.z;
  if (tm < t && u2f(hs >> 11u) < 0.55) {
    let q = (p.xy + v.xy * tm) / room.xy;
    let px = fract(q.x * (1.0 + floor(u2f(hs >> 13u) * 2.0)));
    // A desk/sofa band plus occasionally a standing figure.
    let desk = step(q.y, 0.28) * step(0.1, px) * step(px, 0.85);
    let fx = u2f(hs >> 17u);
    let body = step(abs(q.x - fx), 0.06) * step(q.y, 0.55);
    let head = step(length((q - vec2f(fx, 0.62)) * vec2f(1.0, room.y / room.x)), 0.05);
    let person = (body + head) * step(0.6, u2f(hs >> 19u));
    c = mix(c, vec3f(0.02), saturate(desk + person) * 0.9);
  }
  return c * light;
}

// A generic lit-window facade. Returns surface params via the inout.
struct WinStyle {
  cellW: f32,
  floorH: f32,
  winX0: f32, winX1: f32,
  winY0: f32, winY1: f32,
  roomCells: f32,
  roomDepth: f32,
  litFrac: f32,
  brightness: f32,
  blinds: f32,       // probability of blinds
  curtains: f32,     // probability of colored curtains
};

fn window_facade(c: Ctx, ws: WinStyle, kind: u32, tint: vec3f, sf: ptr<function, Surface>) -> f32 {
  let cell = vec2f(c.facade.x / ws.cellW, c.facade.y / ws.floorH);
  let id = floor(cell);
  let f = fract(cell);
  let dpx = c.fw / vec2f(ws.cellW, ws.floorH);
  let win = aa_box(f.x, ws.winX0, ws.winX1, dpx.x) * aa_box(f.y, ws.winY0, ws.winY1, dpx.y);
  let roomId = floor(id.x / ws.roomCells);
  let floorId = u_of(id.y);
  let hRoom = hash3_u(c.seed, u_of(roomId), floorId);
  // Floors/zones tend to be lit together (offices) with per-room variation.
  let zone = hash31(c.seed ^ 0x5bd1e995u, u_of(roomId / 4.0), floorId / 3u);
  let lit = step(u2f(hRoom), ws.litFrac * (0.4 + 1.2 * zone));
  let det = detail(vec2f(ws.cellW, ws.floorH), c.fw);
  let lc = light_color(kind, u2f(hRoom >> 4u), tint) * ws.brightness * 0.6 * (0.06 + 1.6 * pow(u2f(hRoom >> 9u), 4.0));
  var em = vec3f(0.0);
  if (det > 0.0 && win > 0.0) {
    let fr = vec2f((fract(id.x / ws.roomCells) + f.x / ws.roomCells), (f.y - ws.winY0) / (ws.winY1 - ws.winY0));
    var inner = interior(clamp(fr, vec2f(0.0), vec2f(1.0)), vec3f(ws.cellW * ws.roomCells, ws.floorH * (ws.winY1 - ws.winY0), ws.roomDepth), c.viewT, hRoom, lc, kind);
    // Blinds / curtains on the upper part of the window.
    let hb = u2f(hRoom >> 21u);
    if (hb < ws.blinds) {
      let cover = 0.3 + 0.6 * u2f(hRoom >> 23u);
      let stripes = 0.7 + 0.3 * step(0.5, fract(fr.y * 20.0));
      inner = mix(inner, lc * 0.45 * stripes, step(1.0 - cover, fr.y));
    } else if (hb < ws.blinds + ws.curtains) {
      let cc = mix(vec3f(0.9, 0.3, 0.2), vec3f(0.3, 0.5, 0.9), u2f(hRoom >> 25u));
      let folds = 0.75 + 0.25 * sin(fr.x * 40.0);
      let open = 0.15 + 0.3 * u2f(hRoom >> 27u);
      inner = mix(inner, lc * cc * 0.6 * folds, step(open, abs(fr.x - 0.5) * 2.0));
    }
    em = inner * lit;
    // Unlit windows: occasional TV flicker.
    if (lit < 0.5 && u2f(hRoom >> 3u) < 0.06) {
      let flick = 0.5 + 0.5 * sin(c.time * (7.0 + 9.0 * u2f(hRoom)) + f32(hRoom & 255u));
      em = vec3f(0.25, 0.35, 0.9) * flick * 0.6 * smoothstep(0.0, 1.0, 1.0 - fr.y);
    }
  }
  // Average emission for distant windows.
  // Smooth per-building average for distant facades (no blocky zones),
  // with a faint per-floor variation that survives a little longer.
  let floorVar = 0.75 + 0.5 * hash21(c.seed ^ 0x2545f491u, floorId);
  let avg = ws.litFrac * 0.11 * tint * ws.brightness * floorVar * (ws.winX1 - ws.winX0) * (ws.winY1 - ws.winY0);
  (*sf).emissive += mix(avg, em * win, det);
  return win * det + (1.0 - det) * (ws.winX1 - ws.winX0) * (ws.winY1 - ws.winY0);
}

// LED facade animations.
fn led_pattern(c: Ctx, colA: vec3f, colB: vec3f) -> vec3f {
  let pix = 0.6;
  let p = floor(c.facade / pix) * pix;
  let mode = c.seed % 6u;
  let t = c.time;
  var v = 0.0;
  var col = colB;
  if (mode == 0u) {
    // Rising color waves.
    v = pow(0.5 + 0.5 * sin(p.y * 0.08 - t * 2.0 + sin(p.x * 0.05) * 2.0), 6.0);
    col = mix(colA, colB, 0.5 + 0.5 * sin(p.y * 0.01 + t * 0.3));
  } else if (mode == 1u) {
    // Scrolling horizontal bars (ticker).
    let bar = floor(p.y / 6.0);
    v = step(0.4, fract(p.x * 0.02 + t * (0.3 + hash11(u32(bar)) * 0.5) * select(-1.0, 1.0, (u32(bar) & 1u) == 0u)));
    v *= step(0.25, fract(p.y / 6.0));
    col = select(colA, colB, (u32(bar) % 3u) == 0u);
  } else if (mode == 2u) {
    // Scanning horizontal bands with a bright leading edge.
    let band = fract(p.y / 40.0 - t * 0.35);
    v = pow(band, 4.0) + 0.15 * step(0.5, fract(p.x / 2.4 + p.y / 2.4));
    col = mix(colA, colB, step(0.5, fract(p.y / 80.0 - t * 0.175)));
  } else if (mode == 3u) {
    // Giant blocky glyphs (like characters in a sign).
    let g = floor(p / vec2f(18.0, 18.0));
    let cellp = fract(p / 18.0);
    let gh = hash3_u(c.seed, u_of(g.x), u_of(g.y + floor(t * 0.5)));
    let sub = floor(cellp * 5.0);
    let bit = (gh >> u32(sub.x + sub.y * 5.0)) & 1u;
    v = f32(bit) * step(0.1, cellp.x) * step(cellp.x, 0.9) * step(0.1, cellp.y) * step(cellp.y, 0.9);
    col = select(colA, colB, (gh & 1u) == 0u);
  } else if (mode == 4u) {
    // Vertical rain of light.
    let colx = floor(p.x / 1.2);
    let speed = 20.0 + 40.0 * hash11(u32(colx) + c.seed);
    let y = fract((p.y + t * speed) / 120.0 + hash11(u32(colx) * 7u));
    v = pow(y, 6.0);
    col = colB;
  } else {
    // Twinkling pixel clusters (random LED blocks switching on and off).
    let blk = floor(p / vec2f(3.0, 3.0));
    let tick = floor(t * 2.0 + hash21(u32(blk.x * 7.0 + 3.0), u32(blk.y)) * 10.0);
    let on = step(0.72, u2f(hash3_u(c.seed, u_of(blk.x * 31.0 + blk.y), u_of(tick))));
    v = on * (0.5 + 0.5 * hash21(u_of(blk.x), u_of(blk.y)));
    col = mix(colA, colB, hash21(u_of(blk.y), 9u));
  }
  // LED pixel grid visible up close.
  let det = detail(vec2f(pix, pix), c.fw);
  let q = fract(c.facade / pix) - 0.5;
  let dotMask = mix(1.0, smoothstep(0.5, 0.3, length(q)) * 1.6, det);
  return col * v * dotMask;
}

fn grime(c: Ctx) -> f32 {
  // Vertical streaks and blotches.
  let s = vnoise2(vec2f(c.facade.x * 0.7, c.facade.y * 0.03 + f32(c.seed & 63u)));
  let b = vnoise2(c.facade * 0.08 + vec2f(f32(c.seed & 127u)));
  return 0.65 + 0.35 * s * b;
}

fn shade_wall(c: Ctx, s: Segment, sf: ptr<function, Surface>) {
  let tint = unpack_color(s.colorA);
  let accent = unpack_color(s.colorB);
  let style = s.style;
  var ws: WinStyle;
  let g = grime(c);
  if ((s.flags & F_NOWIN) != 0u) {
    let panel = fract(c.facade / vec2f(1.2, 1.0));
    (*sf).albedo = vec3f(0.09, 0.09, 0.1) * (0.8 + 0.3 * step(0.1, panel.x)) * g;
    (*sf).metallic = 0.6;
    (*sf).roughness = 0.5;
    (*sf).reflectivity = 0.3;
  } else if (style == ST_GLASS) {
    ws = WinStyle(1.6, s.floorH, 0.06, 0.94, 0.14, 0.98, 4.0, 9.0, 0.12, 2.4, 0.35, 0.0);
    let w = window_facade(c, ws, style, tint, sf);
    let glass = mix(vec3f(0.02, 0.035, 0.05), vec3f(0.03, 0.05, 0.06), hash11(c.seed));
    // Mullions (vertical) and transoms catch neon specular; spandrels are
    // ribbed dark panels.
    let cellF = fract(vec2f(c.facade.x / ws.cellW, c.facade.y / ws.floorH));
    let det = detail(vec2f(ws.cellW, ws.floorH), c.fw);
    let mull = (1.0 - aa_box(cellF.x, 0.04, 0.96, c.fw.x / ws.cellW)) * det;
    let rib = step(0.5, fract(c.facade.y * 2.5)) * (1.0 - step(0.14, cellF.y)) * det;
    var frameCol = vec3f(0.05, 0.055, 0.06) * g;
    frameCol = mix(frameCol, vec3f(0.35, 0.37, 0.4), mull);
    frameCol *= 1.0 - rib * 0.4;
    (*sf).albedo = mix(frameCol, glass, w);
    (*sf).roughness = mix(mix(0.35, 0.18, mull), 0.04, w);
    (*sf).metallic = mix(0.8, 0.0, w);
    (*sf).reflectivity = mix(mix(0.4, 0.7, mull), 0.9, w);
  } else if (style == ST_RESIDENTIAL) {
    ws = WinStyle(3.4, s.floorH, 0.18, 0.82, 0.25, 0.85, 1.0, 5.0, 0.22, 1.6, 0.2, 0.45);
    let w = window_facade(c, ws, style, tint, sf);
    let concrete = mix(vec3f(0.16, 0.15, 0.14), vec3f(0.2, 0.17, 0.14), hash11(c.seed + 3u)) * g;
    // Balcony ledges.
    let fy = fract(c.facade.y / s.floorH);
    let ledge = aa_box(fy, 0.0, 0.08, c.fw.y / s.floorH) * step(0.5, fract(c.facade.x / (ws.cellW * 2.0)));
    // Balcony railings, AC units with glowing fan grilles, drain pipes.
    let cellR = fract(vec2f(c.facade.x / ws.cellW, c.facade.y / s.floorH));
    let cid = floor(vec2f(c.facade.x / ws.cellW, c.facade.y / s.floorH));
    let detR = detail(vec2f(ws.cellW, s.floorH), c.fw);
    let rail = ledge * step(0.5, fract(c.facade.x * 4.0)) * aa_box(cellR.y, 0.08, 0.22, c.fw.y / s.floorH) * detR;
    let hac = hash3_u(c.seed ^ 0x77u, u_of(cid.x), u_of(cid.y));
    let ac = select(0.0, 1.0, (hac & 3u) == 0u) * aa_box(cellR.x, 0.84, 0.98, 0.02) * aa_box(cellR.y, 0.3, 0.55, 0.02) * detR;
    let pipeX = fract(c.facade.x / (ws.cellW * 3.0));
    let pipe = aa_box(pipeX, 0.0, 0.025, c.fw.x / (ws.cellW * 3.0)) * detR;
    var wall = concrete * (1.0 - 0.6 * ledge);
    wall = mix(wall, vec3f(0.22, 0.22, 0.24), rail * 0.8);
    wall = mix(wall, vec3f(0.28, 0.28, 0.3), ac);
    wall = mix(wall, vec3f(0.06, 0.06, 0.07), pipe);
    (*sf).albedo = mix(wall, vec3f(0.02), w);
    (*sf).roughness = mix(mix(0.8, 0.35, max(pipe, rail)), 0.1, w);
    (*sf).reflectivity = mix(0.15, 0.6, w);
    // Some AC units have a faint indicator glow.
    (*sf).emissive += vec3f(0.2, 0.9, 0.5) * ac * select(0.0, 0.25, (hac & 12u) == 0u);
  } else if (style == ST_METAL) {
    ws = WinStyle(3.0, s.floorH, 0.04, 0.96, 0.35, 0.7, 3.0, 6.0, 0.25, 1.2, 0.3, 0.0);
    let w = window_facade(c, ws, style, tint, sf);
    let panel = fract(c.facade / vec2f(3.0, s.floorH));
    let seam = 1.0 - (1.0 - aa_box(panel.x, 0.0, 0.03, c.fw.x / 3.0)) * (1.0 - aa_box(panel.y, 0.0, 0.03, c.fw.y / s.floorH));
    let base = mix(vec3f(0.08, 0.09, 0.1), vec3f(0.12, 0.11, 0.1), hash11(c.seed + 9u));
    (*sf).albedo = mix(base * (1.0 - 0.5 * seam) * g, vec3f(0.02), w);
    (*sf).metallic = mix(0.7, 0.0, w);
    (*sf).roughness = mix(0.45, 0.1, w);
    (*sf).reflectivity = 0.4;
  } else if (style == ST_SLUM) {
    // Irregular windows: per floor random cell widths.
    let fid = u_of(c.facade.y / s.floorH);
    let cw = 2.2 + 2.5 * hash21(c.seed, fid);
    ws = WinStyle(cw, s.floorH, 0.15 + 0.1 * hash21(c.seed + 1u, fid), 0.8, 0.25, 0.8, 1.0, 4.0, 0.55, 1.3, 0.15, 0.4);
    let w = window_facade(c, ws, style, tint, sf);
    let concrete = mix(vec3f(0.14, 0.13, 0.12), vec3f(0.18, 0.12, 0.1), hash11(c.seed + 5u)) * g * g;
    // AC units: small dark boxes under some windows.
    let cell = fract(vec2f(c.facade.x / cw, c.facade.y / s.floorH));
    let cid = floor(vec2f(c.facade.x / cw, c.facade.y / s.floorH));
    let ac = select(0.0, 1.0, (hash3_u(c.seed, u_of(cid.x), u_of(cid.y)) & 7u) <= 1u) * aa_box(cell.x, 0.3, 0.6, 0.02) * aa_box(cell.y, 0.05, 0.22, 0.02);
    (*sf).albedo = mix(mix(concrete, vec3f(0.3, 0.3, 0.32), ac), vec3f(0.02), w);
    (*sf).roughness = mix(0.85, 0.15, w);
    (*sf).reflectivity = 0.2;
    // Tiny neon signs scattered on the walls.
    let sc = floor(c.facade / vec2f(9.0, 7.0));
    let sh = hash3_u(c.seed ^ 0xabcdu, u_of(sc.x), u_of(sc.y));
    if ((sh & 31u) == 0u) {
      let sp = fract(c.facade / vec2f(9.0, 7.0));
      let m = aa_box(sp.x, 0.2, 0.8, 0.05) * aa_box(sp.y, 0.35, 0.65, 0.05);
      let col = select(accent, vec3f(1.0) - accent * 0.5, (sh & 32u) == 0u);
      let flick = select(1.0, step(0.3, fract(c.time * 3.0 + f32(sh & 255u) * 0.1)), (sh & 64u) == 0u);
      (*sf).emissive += col * m * 4.0 * flick;
    }
  } else if (style == ST_MONOLITH) {
    // Dark stone with horizontal strip windows every few floors and ribs.
    let band = fract(c.facade.y / (s.floorH * 3.0));
    let rib = aa_box(fract(c.facade.x / 6.0), 0.0, 0.12, c.fw.x / 6.0);
    let strip = aa_box(band, 0.0, 0.18, c.fw.y / (s.floorH * 3.0)) * (1.0 - rib);
    let row = u_of(c.facade.y / (s.floorH * 3.0));
    let seg = u_of(c.facade.x / 24.0);
    let lit = select(0.0, 1.0, (hash3_u(c.seed, row, seg) & 15u) <= 11u);
    let flick = 0.85 + 0.15 * sin(c.time * 0.5 + f32(row));
    (*sf).albedo = vec3f(0.035, 0.03, 0.028) * (1.0 + rib * 0.6);
    (*sf).roughness = 0.35;
    (*sf).metallic = 0.3;
    (*sf).reflectivity = 0.5;
    (*sf).emissive += tint * strip * lit * 2.6 * flick;
  } else if (style == ST_PODIUM) {
    // Shopfronts on the ground floors, offices above.
    let shopH = 7.0;
    if (c.world.y < shopH) {
      let sx = fract(c.facade.x / 8.0);
      let sid = u_of(c.facade.x / 8.0);
      let hs = hash2_u(c.seed, sid);
      let glass = aa_box(sx, 0.05, 0.95, c.fw.x / 8.0) * aa_box(c.facade.y, 0.3, 5.0, c.fw.y);
      let shop = mix(tint, unpack_color(hash_u(hs) | 0xff000000u), 0.4) * (1.5 + 2.0 * u2f(hs));
      let signBand = aa_box(c.facade.y, 5.4, 6.6, c.fw.y) * aa_box(sx, 0.1, 0.9, c.fw.x / 8.0);
      let signCol = select(accent, vec3f(1.0, 0.95, 0.85), (hs & 3u) == 0u);
      (*sf).emissive += shop * glass * step(0.15, u2f(hs >> 4u)) + signCol * signBand * 5.0;
      (*sf).albedo = mix(vec3f(0.1), vec3f(0.02), glass);
      (*sf).roughness = 0.2;
      (*sf).reflectivity = 0.5;
    } else {
      ws = WinStyle(2.0, 4.5, 0.08, 0.92, 0.15, 0.95, 3.0, 8.0, 0.25, 2.0, 0.3, 0.0);
      let w = window_facade(c, ws, ST_GLASS, tint, sf);
      (*sf).albedo = mix(vec3f(0.08) * g, vec3f(0.02, 0.03, 0.04), w);
      (*sf).roughness = mix(0.6, 0.05, w);
      (*sf).reflectivity = mix(0.2, 0.8, w);
    }
  } else if (style == ST_LED && s.shape == 5u) {
    // Spheres: latitude rings and meridians like a lit globe.
    let lat = fract(c.facade.y / 6.0 - c.time * 0.2);
    let ang = atan2(c.n.z, c.n.x);
    let mer = abs(fract(ang / TAU * 24.0 + c.time * 0.02) - 0.5);
    let rings = smoothstep(0.12, 0.0, abs(lat - 0.5));
    let lines = smoothstep(0.06, 0.0, mer);
    (*sf).albedo = vec3f(0.03);
    (*sf).roughness = 0.2;
    (*sf).reflectivity = 0.5;
    (*sf).emissive += mix(accent, tint, rings) * (rings * 2.5 + lines * 1.5 + 0.25);
  } else if (style == ST_LED) {
    let led = led_pattern(c, tint, accent);
    (*sf).albedo = vec3f(0.02);
    (*sf).roughness = 0.3;
    (*sf).reflectivity = 0.3;
    (*sf).emissive += led * 1.5;
  } else if (style == ST_STRUCTURE) {
    // Truss lattice: dark metal with diagonal bracing and small lights.
    let q = fract(c.facade / vec2f(8.0, 8.0));
    let diag = min(abs(q.x - q.y), abs(q.x + q.y - 1.0));
    let frame = min(min(q.x, 1.0 - q.x), min(q.y, 1.0 - q.y));
    let m = 1.0 - smoothstep(0.03, 0.06, min(diag, frame));
    (*sf).albedo = mix(vec3f(0.015), vec3f(0.12, 0.12, 0.13), m);
    (*sf).metallic = 0.8;
    (*sf).roughness = 0.4;
    (*sf).reflectivity = 0.3;
    let lp = fract(c.facade / vec2f(8.0, 24.0)) - vec2f(0.5, 0.5);
    let blink = step(0.5, fract(c.time * 0.5 + hash11(c.seed) ));
    (*sf).emissive += accent * smoothstep(0.08, 0.0, length(lp * vec2f(8.0, 24.0)) / 8.0) * 6.0 * blink;
  } else if (style == ST_NEONRING) {
    let pulse = 0.75 + 0.25 * sin(c.time * 2.0 + c.facade.x * 0.05);
    (*sf).albedo = vec3f(0.02);
    (*sf).emissive += accent * 5.0 * pulse;
  } else if (style == ST_BRIDGE) {
    ws = WinStyle(2.0, 5.0, 0.04, 0.96, 0.25, 0.85, 3.0, 6.0, 0.8, 1.6, 0.0, 0.0);
    let w = window_facade(c, ws, ST_GLASS, tint, sf);
    (*sf).albedo = mix(vec3f(0.06), vec3f(0.02, 0.03, 0.04), w);
    (*sf).roughness = mix(0.5, 0.05, w);
    (*sf).reflectivity = 0.7;
  }
  // LED strips and bands.
  let flags = s.flags;
  if ((flags & F_BANDS) != 0u) {
    let every = s.floorH * f32(4u + (c.seed % 9u));
    let fb = fract(c.facade.y / every);
    let band = aa_box(fb, 0.0, 0.6 / every, c.fw.y / every);
    let chase = 0.6 + 0.4 * sin(c.facade.x * 0.05 - c.time * 1.5);
    (*sf).emissive += accent * band * 3.5 * chase;
  }
  if ((flags & F_TOPGLOW) != 0u) {
    let top = s.pos.y + s.size.y;
    let d = top - c.world.y;
    (*sf).emissive += accent * aa_box(d, 0.0, 1.0, c.fw.y) * 4.0;
  }
}

fn shade_roof(c: Ctx, s: Segment, capUv: vec2f, sf: ptr<function, Surface>) {
  let accent = unpack_color(s.colorB);
  let q = capUv;
  // Gravel with rooftop units.
  let cell = floor(q / 6.0);
  let h = hash3_u(s.seed, u_of(cell.x), u_of(cell.y));
  let unit = select(0.0, 1.0, (h & 7u) <= 1u);
  let n = vnoise2(q * 0.6);
  (*sf).albedo = mix(vec3f(0.06, 0.06, 0.065), vec3f(0.12), unit) * (0.8 + 0.4 * n);
  (*sf).roughness = 0.7;
  (*sf).reflectivity = 0.35;
  // Parapet edge glow.
  let half = s.size.xz * 0.5 * s.taper;
  let edge = min(half.x - abs(q.x), half.y - abs(q.y));
  let isBox = s.shape == 0u || s.shape == 1u;
  if ((s.flags & (F_TOPGLOW | F_EDGE)) != 0u && isBox) {
    (*sf).emissive += accent * aa_box(edge, -1.0, 0.8, max(c.fw.x, 0.05)) * 3.0;
  }
  if ((s.flags & F_BEACON) != 0u || s.style == ST_STRUCTURE) {
    // Blinking red aviation lights near the corners/center.
    let blink = step(0.55, fract(c.time * 0.8 + hash11(s.seed)));
    let corner = length(abs(q) - half * 0.85);
    (*sf).emissive += vec3f(1.0, 0.05, 0.02) * smoothstep(1.2, 0.0, corner) * 12.0 * blink;
  }
}

// Ground: wet asphalt avenues with lane lines and ground-level traffic lights.
fn shade_ground(c: Ctx, sf: ptr<function, Surface>) {
  let SUPERP = 300.0;
  let AVE = 64.0;
  let p = c.world.xz;
  let g = p - round(p / SUPERP) * SUPERP; // offset from the nearest avenue centerlines
  let inAveX = abs(g.x) < AVE * 0.5;
  let inAveZ = abs(g.y) < AVE * 0.5;
  let road = inAveX || inAveZ;
  let n = vnoise2(p * 0.3) * 0.5 + vnoise2(p * 2.1) * 0.5;
  let puddle = smoothstep(0.55, 0.7, vnoise2(p * 0.08 + 3.0));
  (*sf).albedo = vec3f(0.035) * (0.7 + 0.6 * n);
  (*sf).roughness = mix(0.35, 0.03, puddle);
  (*sf).reflectivity = mix(0.6, 1.0, puddle);
  if (!road) {
    // Sidewalks and plazas: lit by shopfronts.
    (*sf).albedo = vec3f(0.05) * (0.8 + 0.4 * n);
    (*sf).emissive += vec3f(1.0, 0.55, 0.3) * 0.02;
    return;
  }
  // Lane lines.
  let along = select(g.x, g.y, inAveX);   // coordinate across the road
  let lengthwise = select(p.y, p.x, !inAveX);
  let lane = fract(along / 8.0);
  let dash = step(0.5, fract(lengthwise / 12.0));
  let line = aa_box(lane, 0.0, 0.03, c.fw.x / 8.0) * dash * select(1.0, 0.0, inAveX && inAveZ);
  (*sf).albedo += vec3f(0.25) * line;
  // Ground traffic: moving headlights / taillights in lanes.
  if (!(inAveX && inAveZ)) {
    let laneId = floor(along / 4.0);
    let dir = select(-1.0, 1.0, laneId >= 0.0);
    let speed = 14.0 + 6.0 * hash11(u32(laneId + 100.0));
    let pos = lengthwise * dir - c.time * speed;
    let cid = floor(pos / 22.0);
    let present = step(hash11(u32(cid + 5000.0) ^ u32(laneId + 77.0)), 0.55);
    let x = fract(pos / 22.0) * 22.0;
    let lat = fract(along / 4.0) - 0.5;
    let lights = smoothstep(1.4, 0.0, abs(x - 1.0)) * smoothstep(0.35, 0.1, abs(abs(lat) - 0.22));
    let col = select(vec3f(1.0, 0.05, 0.02) * 3.0, vec3f(1.0, 0.9, 0.7) * 4.0, dir > 0.0);
    (*sf).emissive += col * lights * present;
  }
}

// Rain ripples: expanding rings from drop impacts on a 0.8 m grid. Returns a
// normal perturbation in the xz plane.
fn ripples(p: vec2f, time: f32) -> vec2f {
  var acc = vec2f(0.0);
  let cell = floor(p / 0.8);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = cell + vec2f(f32(x), f32(y));
      let h = hash21(u_of(c.x), u_of(c.y));
      let ctr = (c + vec2f(hash21(u_of(c.x) + 7u, u_of(c.y)), h)) * 0.8;
      let phase = fract(time * 1.3 + h * 7.0);
      let r = phase * 0.7;
      let d = p - ctr;
      let dist = length(d);
      let ring = sin((dist - r) * 40.0) * smoothstep(0.08, 0.0, abs(dist - r)) * (1.0 - phase);
      acc += d / max(dist, 1e-3) * ring;
    }
  }
  return acc * 0.25;
}

// Applies rain wetness to a surface: darker albedo, glossier, streaks on
// walls, puddles with ripples on flat ground and roofs.
fn apply_wet(c: Ctx, sf: ptr<function, Surface>, flat: bool) {
  let wet = frame.wetness;
  if (wet <= 0.0) { return; }
  if (flat) {
    let puddle = smoothstep(0.45, 0.62, vnoise2(c.world.xz * 0.11 + 7.0));
    let r = ripples(c.world.xz, c.time) * wet;
    (*sf).normal = normalize((*sf).normal + vec3f(r.x, 0.0, r.y) * (0.6 + puddle));
    (*sf).albedo *= mix(1.0, 0.45, wet * mix(0.6, 1.0, puddle));
    (*sf).roughness = mix((*sf).roughness, 0.02, wet * mix(0.55, 1.0, puddle));
    (*sf).reflectivity = max((*sf).reflectivity, wet * mix(0.55, 1.0, puddle));
  } else {
    // Water sheeting down walls in streaks.
    let streak = vnoise2(vec2f(c.facade.x * 1.7, c.facade.y * 0.04 + c.time * 0.6));
    let drip = smoothstep(0.55, 0.8, vnoise2(vec2f(c.facade.x * 9.0, c.facade.y * 0.35 + c.time * 3.0)));
    let w = wet * (0.4 + 0.6 * streak);
    (*sf).albedo *= mix(1.0, 0.7, w);
    (*sf).roughness = mix((*sf).roughness, (*sf).roughness * 0.3, w);
    (*sf).reflectivity = max((*sf).reflectivity, 0.35 * w);
    (*sf).normal = normalize((*sf).normal + c.t * (drip - 0.5) * 0.08 * wet);
  }
}

fn shade_facade(s: Segment, world: vec3f, n: vec3f, facade: vec2f, fw: vec2f, local: vec3f, capUv: vec2f) -> Shaded {
  var sf: Surface;
  sf.normal = n;
  sf.roughness = 0.6;
  sf.metallic = 0.0;
  sf.reflectivity = 0.2;
  sf.albedo = vec3f(0.05);
  sf.emissive = vec3f(0.0);
  var c: Ctx;
  c.world = world;
  c.n = n;
  c.facade = facade;
  c.fw = fw;
  c.seed = s.seed;
  c.time = frame.time;
  c.hRel = saturate(local.y / max(s.size.y, 1e-3));
  if (s.style == ST_GROUND) {
    shade_ground(c, &sf);
    apply_wet(c, &sf, true);
  } else if (n.y > 0.7) {
    shade_roof(c, s, capUv, &sf);
    apply_wet(c, &sf, true);
  } else if (n.y < -0.7) {
    // Undersides: dark with a grid of small lights.
    let q = fract(capUv / 6.0) - 0.5;
    sf.albedo = vec3f(0.03);
    sf.emissive = vec3f(1.0, 0.8, 0.6) * smoothstep(0.08, 0.0, length(q)) * 3.0;
  } else {
    c.t = normalize(cross(vec3f(0.0, 1.0, 0.0), n));
    c.b = cross(n, c.t);
    let vd = normalize(world - frame.camPos);
    c.viewT = vec3f(dot(vd, c.t), dot(vd, c.b), -dot(vd, n));
    shade_wall(c, s, &sf);
    apply_wet(c, &sf, false);
    // Vertical LED strips on box edges.
    if ((s.flags & F_EDGE) != 0u) {
      let accent = unpack_color(s.colorB);
      var ed = 1e9;
      if (s.shape == 0u || s.shape == 1u || s.shape == 6u) {
        let tp = mix(1.0, s.taper, c.hRel);
        let tw = s.twist * c.hRel;
        let lp = vec2f(cos(-tw) * local.x - sin(-tw) * local.z, sin(-tw) * local.x + cos(-tw) * local.z);
        let half = s.size.xz * 0.5 * tp;
        let e = half - abs(lp);
        // On a face one component is ~0 (the face axis); the other is the
        // distance to the nearest vertical edge.
        ed = max(e.x, e.y);
      } else {
        let ang = atan2(local.z, local.x);
        let k = fract(ang / TAU * 8.0);
        ed = min(k, 1.0 - k) * TAU / 8.0 * length(s.size.xz) * 0.35;
      }
      let chase = 0.55 + 0.45 * sin(world.y * 0.03 - frame.time * 2.0 + f32(s.seed & 15u));
      sf.emissive += accent * aa_box(ed, -0.1, 0.9, max(fw.x, 0.02)) * 4.0 * chase;
    }
  }
  var o: Shaded;
  o.color = shade_surface(sf, world);
  o.normal = sf.normal;
  o.roughness = sf.roughness;
  o.reflectivity = sf.reflectivity;
  return o;
}
