// Procedural facade materials. All detail comes from the shader, not geometry:
// window grids with interior mapping (fake rooms with parallax), blinds,
// curtains and silhouettes, LED facades, edge strips, roofs and the ground.
#include "lighting.wgsl"
#include "warp.wgsl"

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
const F_RING = 64u;

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
  face: vec2f,       // base width of the face (0: round shape), taper scale
};

// The segment being shaded (for the shared bay grid in segment.wgsl).
var<private> g_seg: Segment;

// Position on the shared bay grid: (bay index or -1 in a pier, fraction).
fn wall_bay(c: Ctx, bay: f32) -> vec2f {
  return bay_at(c.facade.x / max(c.face.y, 1e-3), face_bays(c.face.x, bay), bay);
}

fn u_of(x: f32) -> u32 { return bitcast<u32>(i32(floor(x))); }

// Fraction of a box pulse [a, b] within [0, 1] cell coordinates, anti-aliased by width w.
fn aa_box(x: f32, a: f32, b: f32, w: f32) -> f32 {
  // Exact box-filter coverage of [a, b] over a pixel footprint of width w:
  // thin features seen at grazing angles fade to their true (small) area
  // instead of smearing across the whole face.
  let ww = max(w, 1e-4);
  return saturate((min(x + ww * 0.5, b) - max(x - ww * 0.5, a)) / ww);
}

// How much detail survives at this distance (1 = full, 0 = use averages).
fn detail(cellMeters: vec2f, fw: vec2f) -> f32 {
  let px = min(cellMeters.x / max(fw.x, 1e-5), cellMeters.y / max(fw.y, 1e-5));
  return smoothstep(2.0, 6.0, px);
}

// Room light colour: warm : cool : tinted mixes per building type
// (ART_BIBLE.md 10). h is a per-room random number in [0, 1).
fn light_color(kind: u32, h: f32, tint: vec3f) -> vec3f {
  let warm = mix(tint, vec3f(1.0, 0.64, 0.34), 0.5 + 0.5 * fract(h * 7.0));
  let cool = mix(vec3f(0.78, 0.9, 1.0), vec3f(0.92, 0.95, 1.0), fract(h * 5.0));
  let fluoro = vec3f(0.62, 1.0, 0.72);
  let tinted = select(vec3f(1.0, 0.3, 0.55), vec3f(0.3, 0.85, 0.9), fract(h * 11.0) < 0.5);
  let tv = vec3f(0.4, 0.5, 1.0);
  switch kind {
    case ST_RESIDENTIAL: {
      if (h < 0.7) { return warm; }
      if (h < 0.85) { return cool; }
      return select(tv, tinted, h < 0.93);
    }
    case ST_SLUM: {
      if (h < 0.6) { return warm; }
      if (h < 0.8) { return fluoro; }
      return tinted;
    }
    case ST_MONOLITH: {
      return select(cool, vec3f(1.0, 0.6, 0.28), h < 0.9);
    }
    default: {
      // Offices: mostly cool-neutral.
      if (h < 0.3) { return warm; }
      if (h < 0.9) { return cool; }
      return tv;
    }
  }
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
    let shelf = step(0.3, uv.x) * step(uv.x, 0.6) * step(0.45, uv.y) * step(uv.y, 0.75) * step(0.5, u2f_rot(hs, 3u));
    c = mix(c, vec3f(0.15, 0.12, 0.1), shelf * 0.8);
  } else if (t == abs(ty)) {
    if (v.y > 0.0) {
      // Ceiling with a light panel.
      let q = h.xz / room.xz;
      let panel = step(abs(q.x - 0.5), 0.2) * step(abs(q.y - 0.4), 0.15);
      c = vec3f(0.6) + panel * 1.6;
    } else {
      // Floor.
      c = mix(vec3f(0.22, 0.17, 0.13), vec3f(0.3, 0.3, 0.32), u2f_rot(hs, 5u)) * 0.6;
    }
  } else {
    c = wallTint * 0.8;
  }
  // Light falls off toward the back.
  c *= mix(1.15, 0.6, h.z / room.z);
  // Silhouettes (furniture/people) on a mid-depth plane.
  let zMid = room.z * (0.35 + 0.3 * u2f_rot(hs, 7u));
  let tm = zMid / v.z;
  if (tm < t && u2f_rot(hs, 11u) < 0.55) {
    let q = (p.xy + v.xy * tm) / room.xy;
    let px = fract(q.x * (1.0 + floor(u2f_rot(hs, 13u) * 2.0)));
    // A desk/sofa band plus occasionally a standing figure.
    let desk = step(q.y, 0.28) * step(0.1, px) * step(px, 0.85);
    let fx = u2f_rot(hs, 17u);
    let body = step(abs(q.x - fx), 0.06) * step(q.y, 0.55);
    let head = step(length((q - vec2f(fx, 0.62)) * vec2f(1.0, room.y / room.x)), 0.05);
    let person = (body + head) * step(0.6, u2f_rot(hs, 19u));
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

// How deep windows sit in the wall (m) per style: curtain walls are nearly
// flush, concrete residential/slum blocks have deep reveals.
// Ambient occlusion inside a window reveal (set by window_facade; applied
// after the style sets the wall albedo).
var<private> g_revealAO: f32 = 1.0;

// ---------------------------------------------------------------- relief
// Analytic surface relief (ART_BIBLE.md 12). Features add the slope of a
// height field in tangent space (x along the wall, y up, meters) and the
// result tilts the normal once, after the wall is shaded, so every light
// (neon, clustered sign lights, reflections, SSR) rakes across it. A feature
// narrower than a few pixels fades out and its slope variance moves into
// roughness, so wet walls don't sparkle in the distance.
var<private> g_slope: vec2f;
var<private> g_slopeVar: f32;
var<private> g_joint: f32; // how much of the pixel is a joint/recess (holds water first)

// Slope of a rounded ridge (depth > 0) or groove (depth < 0) of width w
// centred at x = 0.
fn bump_slope(x: f32, w: f32, depth: f32) -> f32 {
  if (abs(x) >= w * 0.5) { return 0.0; }
  return -depth * PI / w * sin(TAU * x / w);
}

fn bump_mask(x: f32, w: f32) -> f32 {
  if (abs(x) >= w * 0.5) { return 0.0; }
  return 0.5 + 0.5 * cos(TAU * x / w);
}

// Distance from x to the nearest multiple of `period` (signed).
fn to_line(x: f32, period: f32) -> f32 { return x - round(x / period) * period; }

// Adds a feature's slope, faded by its pixel size; the lost part of its
// slope variance (sigma2, already scaled by coverage) goes to roughness.
fn add_relief(c: Ctx, slope: vec2f, fwid: f32, sigma2: f32) {
  // TAA resolves 1-2 px features, so relief fades later than texture
  // detail: fully on from 2.5 px, gone below 0.75 px.
  let px = fwid / max(max(c.fw.x, c.fw.y), 1e-5);
  let k = smoothstep(0.75, 2.5, px);
  g_slope += slope * k;
  g_slopeVar += (1.0 - k) * sigma2;
}

fn apply_relief(c: Ctx, sf: ptr<function, Surface>) {
  (*sf).normal = normalize((*sf).normal - c.t * g_slope.x - c.b * g_slope.y);
  let r = (*sf).roughness;
  (*sf).roughness = min(sqrt(r * r + g_slopeVar), 1.0);
}

fn recess_for(kind: u32) -> f32 {
  switch kind {
    case ST_GLASS: { return 0.14; }
    case ST_RESIDENTIAL: { return 0.5; }
    case ST_SLUM: { return 0.42; }
    case ST_METAL: { return 0.3; }
    default: { return 0.25; }
  }
}

fn window_facade(c: Ctx, ws_in: WinStyle, kind: u32, tint: vec3f, sf: ptr<function, Surface>) -> f32 {
  var ws = ws_in;
  // Columns come from the shared bay grid (segment.wgsl), so the kit placed
  // by details_emit.wgsl lines up with these windows.
  let nB = face_bays(c.face.x, ws.cellW);
  let bx = bay_at(c.facade.x / max(c.face.y, 1e-3), nB, ws.cellW);
  let cls = bay_class(g_seg, i32(bx.x), nB);
  if (cls == BAY_N) {
    let r = win_rect(g_seg, BAY_N);
    ws.winX0 = r.x;
    ws.winX1 = r.y;
    ws.winY0 = r.z;
    ws.winY1 = r.w;
  }
  let cell = vec2f(bx.x + bx.y, c.facade.y / ws.floorH);
  let id = floor(cell);
  let f = fract(cell);
  let dpx = c.fw / vec2f(ws.cellW * c.face.y, ws.floorH);
  var win = aa_box(f.x, ws.winX0, ws.winX1, dpx.x) * aa_box(f.y, ws.winY0, ws.winY1, dpx.y);
  // Corner piers and service bays are solid wall.
  if (bx.x < 0.0 || cls == BAY_S || cls == BAY_C) { win = 0.0; }
  if (cls == BAY_C) {
    // Stair core: a glass-block slot, cool-lit, with landings half a floor off.
    let slot = aa_box(bx.y, 0.38, 0.62, dpx.x) * (1.0 - 0.5 * aa_box(fract(cell.y + 0.5), 0.0, 0.06, dpx.y));
    let blocks = mix(1.0, 0.6, step(0.85, fract(c.facade.y * 4.0)) * detail(vec2f(0.25), c.fw));
    // Landings are lit unevenly (dead tubes, timers), dim fluorescent green.
    let landing = hash3_u(c.seed ^ 0x2545f491u, u_of(bx.x), u_of(cell.y + 0.5));
    let on = step(u2f(landing), 0.55) * (0.5 + 0.5 * u2f_rot(landing, 8u));
    (*sf).emissive += vec3f(0.55, 0.8, 0.65) * 0.12 * slot * blocks * on;
  }
  let roomId = floor(id.x / ws.roomCells);
  let floorId = u_of(id.y);
  let hRoom = hash3_u(c.seed, u_of(roomId), floorId);
  // Floors/zones tend to be lit together (offices) with per-room variation.
  let zone = hash31(c.seed ^ 0x5bd1e995u, u_of(roomId / 4.0), floorId / 3u);
  var lit = step(u2f(hRoom), ws.litFrac * (0.4 + 1.2 * zone));
  var litAvg = ws.litFrac;
  if (kind == ST_GLASS) {
    // Offices light up in whole-floor runs of 2-6 floors (ART_BIBLE C1),
    // with the odd dark bay inside a lit run.
    let runLen = 2u + c.seed % 5u;
    let run = (floorId + (c.seed >> 8u) % runLen) / runLen;
    let runLit = step(hash21(c.seed ^ 0x9e3779b9u, run), 0.5);
    lit = runLit * step(0.3, u2f_rot(hRoom, 13u));
    // Far away the lit runs stay visible as bands until they get small.
    litAvg = mix(0.2, runLit * 0.38, detail(vec2f(ws.cellW * 4.0, ws.floorH * f32(runLen)), c.fw));
  }
  let det = detail(vec2f(ws.cellW, ws.floorH), c.fw);
  let lc = light_color(kind, u2f_rot(hRoom, 4u), tint) * ws.brightness * 0.6 * (0.1 + 1.3 * pow(u2f_rot(hRoom, 9u), 2.5));
  // Panes of one room differ a little (blinds angle, lamps, furniture).
  let pane = 0.7 + 0.6 * hash31(c.seed ^ 0x68e31da4u, u_of(id.x), floorId);
  var em = vec3f(0.0);
  var reveal = 0.0;
  // Light spilling out of a lit window onto the wall/sill around it.
  if (det > 0.0 && win < 1.0) {
    let lpm = f * vec2f(ws.cellW, ws.floorH);
    let q0 = vec2f(ws.winX0 * ws.cellW, ws.winY0 * ws.floorH);
    let q1 = vec2f(ws.winX1 * ws.cellW, ws.winY1 * ws.floorH);
    let dd = max(max(q0 - lpm, lpm - q1), vec2f(0.0));
    // Mostly downward onto the sill.
    let dist = length(dd * vec2f(1.0, select(2.0, 0.8, lpm.y < q0.y)));
    (*sf).emissive += lc * pane * lit * det * (1.0 - win) * 0.05 * exp(-dist * 2.5);
    if (bx.x >= 0.0 && cls != BAY_S && cls != BAY_C) {
      // Recessed frame band (0.08 m) with a bevelled outer edge, and a sill
      // lip under the opening: its top faces the sky and catches every sign
      // reflection in the rain (ART_BIBLE.md 12.2).
      let fwd = 0.08;
      let inX = lpm.x > q0.x - fwd && lpm.x < q1.x + fwd;
      let inY = lpm.y > q0.y - fwd && lpm.y < q1.y + fwd;
      if (inX && inY) {
        let ex = min(lpm.x - (q0.x - fwd), (q1.x + fwd) - lpm.x);
        let ey = (q1.y + fwd) - lpm.y;
        // Outer bevel: the frame face sits 0.05 m back from the wall.
        let sx = select(1.0, -1.0, lpm.x > (q0.x + q1.x) * 0.5);
        var sl = vec2f(sx * bump_slope(ex - 0.012, 0.024, 0.03), -bump_slope(ey - 0.012, 0.024, 0.03));
        add_relief(c, sl, 0.024, 0.02 * 0.1);
        g_revealAO *= mix(1.0, 0.72, detail(vec2f(fwd), c.fw));
        g_joint = max(g_joint, 0.6);
      }
      let sillY = q0.y - fwd - 0.035;
      if (lpm.x > q0.x - fwd - 0.1 && lpm.x < q1.x + fwd + 0.1) {
        let dy = lpm.y - sillY;
        add_relief(c, vec2f(0.0, bump_slope(dy, 0.07, 0.05)), 0.07, 0.05 * 0.05);
        // Drip groove shadow under the lip.
        g_revealAO *= 1.0 - 0.35 * bump_mask(dy + 0.05, 0.03) * detail(vec2f(0.03), c.fw);
      }
    }
  }
  if (det > 0.0 && win > 0.0) {
    // Recessed window: trace the view ray into the opening. It either
    // reaches the glass (look into the room from the hit point: parallax)
    // or hits the side/top/bottom of the opening (the reveal).
    let D = recess_for(kind);
    let v = c.viewT;
    let vz = max(v.z, 0.05);
    let lp = f * vec2f(ws.cellW, ws.floorH);
    let r0 = vec2f(ws.winX0 * ws.cellW, ws.winY0 * ws.floorH);
    let r1 = vec2f(ws.winX1 * ws.cellW, ws.winY1 * ws.floorH);
    var hit = lp + v.xy * (D / vz);
    if (any(hit < r0) || any(hit > r1)) {
      // Which side does the ray leave the opening through first?
      let tx = select((r0.x - lp.x) / min(v.x, -1e-4), (r1.x - lp.x) / max(v.x, 1e-4), v.x > 0.0);
      let ty = select((r0.y - lp.y) / min(v.y, -1e-4), (r1.y - lp.y) / max(v.y, 1e-4), v.y > 0.0);
      let ts = max(min(tx, ty), 0.0);
      let depth = ts * vz;
      let nT = select(vec2f(0.0, -sign(v.y)), vec2f(-sign(v.x), 0.0), tx < ty);
      // The reveal faces across the opening (tangent-space normal nT).
      (*sf).normal = normalize(c.t * nT.x + c.b * nT.y + c.n * 0.15);
      reveal = det * win;
      // Darker deeper in; the room light spills onto it when lit.
      g_revealAO = 1.0 - 0.55 * saturate(depth / D);
      em = lc * lit * 0.12 * (0.4 + 0.6 * saturate(depth / D));
      hit = lp + v.xy * ts;
    }
    let fr = vec2f(
      (fract(id.x / ws.roomCells) + clamp(hit.x / ws.cellW, 0.0, 1.0) / ws.roomCells),
      (hit.y / ws.floorH - ws.winY0) / (ws.winY1 - ws.winY0));
    var inner = interior(clamp(fr, vec2f(0.0), vec2f(1.0)), vec3f(ws.cellW * ws.roomCells, ws.floorH * (ws.winY1 - ws.winY0), ws.roomDepth), c.viewT, hRoom, lc, kind);
    // Blinds / curtains on the upper part of the window.
    let hb = u2f_rot(hRoom, 21u);
    if (hb < ws.blinds) {
      let cover = 0.3 + 0.6 * u2f_rot(hRoom, 23u);
      let stripes = 0.7 + 0.3 * step(0.5, fract(fr.y * 20.0));
      inner = mix(inner, lc * 0.45 * stripes, step(1.0 - cover, fr.y));
    } else if (hb < ws.blinds + ws.curtains) {
      let cc = mix(vec3f(0.9, 0.3, 0.2), vec3f(0.3, 0.5, 0.9), u2f_rot(hRoom, 25u));
      let folds = 0.75 + 0.25 * sin(fr.x * 40.0);
      let open = 0.15 + 0.3 * u2f_rot(hRoom, 27u);
      inner = mix(inner, lc * cc * 0.6 * folds, step(open, abs(fr.x - 0.5) * 2.0));
    }
    if (reveal == 0.0) {
      // Unlit rooms aren't black holes: the city glow and the street below
      // faintly light the ceiling and furniture.
      let dimRoom = interior(clamp(fr, vec2f(0.0), vec2f(1.0)), vec3f(ws.cellW * ws.roomCells, ws.floorH * (ws.winY1 - ws.winY0), ws.roomDepth), c.viewT, hRoom, vec3f(0.05, 0.04, 0.06) * frame.cityGlow, kind);
      em = mix(dimRoom, inner * pane, lit);
    }
    // Unlit windows: occasional TV flicker.
    if (reveal == 0.0 && lit < 0.5 && u2f_rot(hRoom, 3u) < 0.015) {
      let flick = 0.75 + 0.25 * sin(c.time * (1.5 + 2.0 * u2f(hRoom)) + f32(hRoom & 255u));
      em = vec3f(0.25, 0.35, 0.9) * flick * 0.6 * smoothstep(0.0, 1.0, 1.0 - fr.y);
    }
  }
  // Average emission for distant windows.
  // Smooth per-building average for distant facades (no blocky zones),
  // with a faint per-floor variation that survives a little longer.
  let floorVar = 0.75 + 0.5 * hash21(c.seed ^ 0x2545f491u, floorId);
  // 0.13 ~ the mean of interior colour x room light (see lc above).
  let avg = litAvg * 0.13 * tint * ws.brightness * floorVar * (ws.winX1 - ws.winX0) * (ws.winY1 - ws.winY0);
  (*sf).emissive += mix(avg, em * win, det);
  // Reveal pixels are wall material, not glass.
  return win * det * (1.0 - step(0.001, reveal)) + (1.0 - det) * (ws.winX1 - ws.winX0) * (ws.winY1 - ws.winY0);
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
    v = step(0.72, fract(p.x * 0.02 + t * (0.3 + hash11(u32(bar)) * 0.5) * select(-1.0, 1.0, (u32(bar) & 1u) == 0u)));
    v *= step(0.25, fract(p.y / 6.0));
    col = select(colA, colB, (u32(bar) % 3u) == 0u);
  } else if (mode == 2u) {
    // Scanning horizontal bands with a bright leading edge.
    let band = fract(p.y / 40.0 - t * 0.35);
    v = pow(band, 4.0) + 0.15 * step(0.5, fract(p.x / 2.4 + p.y / 2.4));
    col = mix(colA, colB, step(0.5, fract(p.y / 80.0 - t * 0.175)));
  } else if (mode == 3u) {
    // Giant characters scrolling smoothly upward in columns (a vertical
    // ticker). Glyphs are fixed per position along the strip, so nothing
    // blinks; the motion is continuous.
    let colW = 18.0;
    let colId = floor(p.x / colW);
    let speed = 4.0 + 3.0 * hash11(u32(colId + 300.0));
    let yy = p.y + t * speed;
    let g = floor(vec2f(p.x, yy) / colW);
    let cellp = fract(vec2f(p.x, yy) / colW);
    let gh = hash3_u(c.seed, u_of(g.x), u_of(g.y));
    let sub = floor(cellp * 5.0);
    let bit = (gh >> u32(sub.x + sub.y * 5.0)) & 1u;
    let sb = fract(cellp * 5.0);
    let ring = 1.0 - step(0.16, sb.x) * step(sb.x, 0.84) * step(0.16, sb.y) * step(sb.y, 0.84);
    v = f32(bit) * (0.15 + 0.85 * ring) * step(0.1, cellp.x) * step(cellp.x, 0.9) * step(0.1, cellp.y) * step(cellp.y, 0.9);
    col = select(colA, colB, (gh & 1u) == 0u);
  } else if (mode == 4u) {
    // Vertical rain of light.
    let colx = floor(p.x / 1.2);
    let speed = 20.0 + 40.0 * hash11(u32(colx) + c.seed);
    let y = fract((p.y + t * speed) / 120.0 + hash11(u32(colx) * 7u));
    v = pow(y, 6.0);
    col = colB;
  } else {
    // Equalizer: continuous vertical bars rising and falling smoothly.
    let barW = 2.4;
    let bar = floor(p.x / barW);
    let hb = hash11(u32(bar + 700.0) ^ c.seed);
    let level = 0.5 + 0.35 * sin(t * (0.8 + hb) + hb * 20.0) + 0.15 * sin(t * 2.3 + bar * 0.7);
    let span = 60.0;
    let local = fract(p.y / span);
    let inBar = step(0.12, fract(p.x / barW)) * step(fract(p.x / barW), 0.88);
    v = inBar * step(local, level) * (0.4 + 0.6 * local / max(level, 0.05));
    col = mix(colA, colB, local);
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

// Weathering on top of a wall's material: per-panel tint jitter, rain
// streaks running down from every floor's sills and from the parapet, and
// splash dirt near the ground. Fades to its average where it would alias.
fn weathering(c: Ctx, s: Segment) -> f32 {
  let fh = s.floorH;
  let detP = detail(vec2f(3.0, fh), c.fw);
  let detS = detail(vec2f(0.6, 2.0), c.fw);
  let pid = floor(vec2f(c.facade.x / 3.0, c.facade.y / fh));
  let panel = 0.88 + 0.24 * hash31(s.seed ^ 0x2c1b3c6du, u_of(pid.x), u_of(pid.y));
  // Streaks: per 0.3 m column strength, longest right under the sill.
  let col = floor(c.facade.x / 0.3);
  let hs = hash3_u(s.seed ^ 0x297a2d39u, u_of(col), u_of(pid.y));
  let len = 0.3 + 0.7 * u2f(hs);
  let below = 1.0 - fract(c.facade.y / fh); // 0 at the sill, 1 at the floor
  let streak = step(u2f_rot(hs, 8u), 0.35) * smoothstep(len, 0.0, below) * (0.5 + 0.5 * vnoise2(vec2f(c.facade.x * 3.0, c.facade.y * 0.7)));
  // Runoff from the parapet and splash dirt at street level.
  let top = s.pos.y + s.size.y - c.world.y;
  let runoff = smoothstep(14.0, 0.0, top) * (0.4 + 0.6 * vnoise2(vec2f(c.facade.x * 1.3, c.world.y * 0.08)));
  let splash = smoothstep(4.0, 0.0, c.world.y) * 0.5;
  let fine = mix(0.9, 1.0 - 0.28 * streak, detS);
  // Structure that reads at mid range: floor slab edges and pilasters,
  // fading to their average (not to flat) with distance.
  let detF = detail(vec2f(4.0, fh), c.fw) * (1.0 - detail(vec2f(0.25), c.fw) * 0.5);
  let slab = aa_box(fract(c.facade.y / fh), 0.0, 0.07, c.fw.y / fh);
  let pilStep = 6.0 + 3.0 * f32(s.seed % 3u);
  let pil = aa_box(fract(c.facade.x / pilStep), 0.0, 0.08, c.fw.x / pilStep);
  let structure = mix(0.93, (1.0 - 0.45 * slab) * (1.0 + 0.3 * pil), detF);
  return mix(1.0, panel, detP) * fine * structure * (1.0 - 0.3 * runoff) * (1.0 - splash);
}

// A blocky pseudo-glyph (5x5 cells) for shop signs: strokes from a hash.
fn sign_glyph(p: vec2f, h: u32) -> f32 {
  if (any(p < vec2f(0.0)) || any(p >= vec2f(1.0))) { return 0.0; }
  let q = vec2u(p * 5.0);
  // Mirror-ish: horizontal and vertical strokes look like characters.
  let row = (h >> (q.y * 5u)) & 31u;
  let colBits = (h >> (q.x * 3u + 7u)) & 1u;
  let on = ((row >> q.x) & 1u) | select(0u, colBits, q.y == 2u || q.x == 2u);
  return f32(on);
}

// Street-level shopfront: an 8 m bay with a lit interior or a rolling
// shutter, a mullioned glass front and a sign board with glyphs above.
fn shopfront(c: Ctx, tint: vec3f, accent: vec3f, sf: ptr<function, Surface>) {
  // Shop bays (8 m Core, 5 m Market/Slum) on the shared grid; each shop's
  // canopy depth/height, fascia and shutter come from shop_params(), which
  // details_emit.wgsl also uses for the canopy (ART_BIBLE.md 7).
  let bayW = shop_bay(g_seg);
  // Heights from the street (podiums may start below ground).
  let y = c.world.y;
  let wb = wall_bay(c, bayW);
  let sx = wb.y;
  let sid = u_of(wb.x);
  let inBay = step(0.0, wb.x);
  let sp = shop_params(g_seg, i32(wb.x), face_bays(c.face.x, bayW));
  let mount = sp.y;
  let hs = hash2_u(c.seed, sid);
  let det = detail(vec2f(1.0), c.fw);
  let glassTop = mount - 0.15;
  let glass = aa_box(sx, 0.05, 0.95, c.fw.x / bayW) * aa_box(y, 0.3, glassTop, c.fw.y) * inBay;
  let shuttered = sp.w > 0.5;
  // Shop light: warm 50%, cool fluorescent 30%, tinted 20%.
  let lt = u2f_rot(hs, 20u);
  var shopCol = vec3f(1.0, 0.78, 0.52);
  if (lt > 0.5) { shopCol = vec3f(0.8, 0.95, 1.0); }
  if (lt > 0.8) { shopCol = mix(unpack_color(hash_u(hs) | 0xff000000u), vec3f(1.0), 0.3); }
  var wall = vec3f(0.12, 0.11, 0.1);
  var em = vec3f(0.0);
  if (shuttered) {
    // Corrugated roller shutter with a little graffiti color.
    let rib = 0.75 + 0.25 * step(0.5, fract(y * 6.0));
    let graf = step(0.72, vnoise2(vec2f(c.facade.x, y) * vec2f(0.8, 1.5) + f32(hs & 63u))) * det;
    wall = mix(vec3f(0.3, 0.3, 0.31) * rib, unpack_color(hash_u(hs + 7u) | 0xff000000u) * 0.4, graf);
    // Rolling-shutter slats: fine horizontal glints under the canopy light.
    add_relief(c, vec2f(0.0, 0.006 * TAU / 0.08 * cos(TAU * y / 0.08)) * glass, 0.04, 0.03 * glass);
    (*sf).albedo = mix(vec3f(0.1), wall, glass);
    (*sf).roughness = 0.5;
    (*sf).metallic = 0.6 * glass;
  } else {
    // Glass with mullions; the shop inside is an interior-mapped room.
    let mull = (1.0 - aa_box(fract(sx * 3.0), 0.03, 0.97, c.fw.x * 3.0 / bayW)) * det;
    let fr = vec2f(sx, saturate((y - 0.3) / (glassTop - 0.3)));
    let inner = interior(fr, vec3f(bayW, glassTop - 0.3, 6.0), c.viewT, hs, shopCol * (1.0 + 1.4 * u2f_rot(hs, 9u)), ST_PODIUM);
    em = mix(inner, vec3f(0.0), mull) * glass;
    (*sf).albedo = mix(vec3f(0.1), mix(vec3f(0.02), vec3f(0.25), mull), glass);
    (*sf).roughness = mix(0.6, 0.05, glass);
    (*sf).reflectivity = mix(0.2, 0.8, glass);
  }
  // Fascia sign above the canopy: dark board, lit glyphs, thin neon border.
  let b0 = mount + 0.25;
  let fh = sp.z;
  let board = aa_box(y, b0, b0 + fh, c.fw.y) * aa_box(sx, 0.06, 0.94, c.fw.x / bayW) * inBay;
  let signCol = select(accent, vec3f(1.0, 0.95, 0.85), (hs & 3u) == 0u);
  let bw = bayW * 0.88;
  let bp = vec2f((sx - 0.06) / 0.88 * bayW, y - b0); // meters on the board
  let border = board * (1.0 - aa_box(bp.x, 0.08, bw - 0.08, c.fw.x) * aa_box(bp.y, 0.08, fh - 0.08, c.fw.y));
  let gw = fh * 0.75;
  let nG = min(2u + (hs >> 12u) % 4u, u32(floor((bw - 0.4) / gw)));
  let x0 = (bw - f32(nG) * gw) * 0.5;
  let gi = floor((bp.x - x0) / gw);
  var glyph = 0.0;
  if (gi >= 0.0 && gi < f32(nG)) {
    let gp = vec2f(fract((bp.x - x0) / gw) * 1.25 - 0.12, (bp.y - fh * 0.18) / (fh * 0.64));
    glyph = sign_glyph(gp, hash_u(hs + u32(gi) * 977u));
  }
  let lit = mix(0.35, glyph, det); // far away: average brightness
  let flick = select(1.0, 0.6 + 0.4 * step(0.3, fract(c.time * 3.1 + f32(hs & 31u) * 0.1)), (hs & 60u) == 0u);
  // Fascias are the lowest brightness rank of the street's signs.
  em += signCol * board * (lit * 2.2 + border * 2.8) * flick;
  (*sf).albedo = mix((*sf).albedo, vec3f(0.03), board);
  (*sf).emissive += em;
}

// V-joints on a panel grid: vertical every `pw` meters along the bay grid
// (or plain facade meters when pw is not the bay), horizontal every `ph`.
fn panel_joints(c: Ctx, xLine: f32, yLine: f32, w: f32, depth: f32, mask: f32) {
  let sl = vec2f(bump_slope(xLine, w, depth), bump_slope(yLine, w, depth)) * mask;
  add_relief(c, sl, w, 0.05 * w * 2.0);
  g_joint = max(g_joint, max(bump_mask(xLine, w), bump_mask(yLine, w)) * mask);
}

fn shade_wall(c: Ctx, s: Segment, sf: ptr<function, Surface>) {
  let tint = unpack_color(s.colorA);
  let accent = unpack_color(s.colorB);
  let style = s.style;
  var ws: WinStyle;
  let g = grime(c);
  if ((s.flags & F_NOWIN) != 0u) {
    let panel = fract(c.facade / vec2f(1.2, 1.0));
    (*sf).albedo = vec3f(0.15, 0.15, 0.16) * (0.8 + 0.3 * step(0.1, panel.x)) * g;
    (*sf).metallic = 0.6;
    (*sf).roughness = 0.5;
    (*sf).reflectivity = 0.3;
  } else if (style == ST_GLASS) {
    let r = win_rect(s, BAY_W);
    ws = WinStyle(seg_bay(s), s.floorH, r.x, r.y, r.z, r.w, 4.0, 9.0, 0.12, 1.5, 0.35, 0.0);
    let w = window_facade(c, ws, style, tint, sf);
    let glass = mix(vec3f(0.02, 0.035, 0.05), vec3f(0.03, 0.05, 0.06), hash11(c.seed));
    // Mullions (vertical) and transoms catch neon specular; spandrels are
    // ribbed dark panels.
    let cellF = vec2f(wall_bay(c, ws.cellW).y, fract(c.facade.y / ws.floorH));
    let det = detail(vec2f(ws.cellW, ws.floorH), c.fw);
    let mull = (1.0 - aa_box(cellF.x, 0.07, 0.93, c.fw.x / ws.cellW)) * det;
    let rib = step(0.5, fract(c.facade.y * 2.5)) * (1.0 - step(0.14, cellF.y)) * det;
    var frameCol = vec3f(0.11, 0.115, 0.12) * g;
    frameCol = mix(frameCol, vec3f(0.55, 0.57, 0.6), mull);
    frameCol *= 1.0 - rib * 0.4;
    (*sf).albedo = mix(frameCol, glass, w);
    (*sf).roughness = mix(mix(0.35, 0.18, mull), 0.04, w);
    (*sf).metallic = mix(0.8, 0.0, w);
    (*sf).reflectivity = mix(mix(0.4, 0.7, mull), 0.9, w);
    // Mullion caps proud of the glass (the glints that sweep across a
    // tower as the camera moves), spandrel inset chamfers and ribs.
    let mx = to_line(cellF.x, 1.0) * ws.cellW;
    add_relief(c, vec2f(bump_slope(mx, 0.06, 0.08), 0.0), 0.06, 0.05 * 0.04);
    let spand = 1.0 - step(r.z, cellF.y);
    let sy = cellF.y * ws.floorH;
    let chamfer = bump_slope(sy - 0.02, 0.04, -0.03) - bump_slope(sy - (r.z * ws.floorH - 0.02), 0.04, -0.03);
    let ribs = 0.01 * TAU / 0.4 * cos(TAU * sy / 0.4) * spand;
    add_relief(c, vec2f(0.0, chamfer * spand), 0.04, 0.0);
    add_relief(c, vec2f(0.0, ribs), 0.2, 0.02 * spand);
  } else if (style == ST_RESIDENTIAL) {
    let r = win_rect(s, BAY_W);
    ws = WinStyle(seg_bay(s), s.floorH, r.x, r.y, r.z, r.w, 2.0, 5.0, 0.22, 1.6, 0.2, 0.45);
    let w = window_facade(c, ws, style, tint, sf);
    let concrete = mix(vec3f(0.3, 0.28, 0.26), vec3f(0.36, 0.3, 0.25), hash11(c.seed + 3u)) * g;
    // Slab edge line at every floor (the balconies, AC units, cages and
    // risers are kit pieces on the bay grid: details_emit.wgsl).
    let fy = fract(c.facade.y / s.floorH);
    let slab = aa_box(fy, 0.0, 0.06, c.fw.y / s.floorH);
    (*sf).albedo = mix(concrete * (1.0 - 0.35 * slab), vec3f(0.02), w);
    (*sf).roughness = mix(0.8, 0.1, w);
    (*sf).reflectivity = mix(0.15, 0.6, w);
    // Precast panel V-joints on the bay lines and at mid-floor.
    let jb = wall_bay(c, ws.cellW);
    panel_joints(c, to_line(jb.y, 1.0) * ws.cellW, to_line(c.facade.y / s.floorH + 0.5, 1.0) * s.floorH, 0.02, -0.02, 1.0 - w);
  } else if (style == ST_METAL) {
    // Ribbon windows split into 1.5 m panes by mullions; room width varies
    // per floor so lit rooms don't all read as identical dashes.
    let fidM = u_of(c.facade.y / s.floorH);
    let rc = 2.0 + floor(4.0 * hash21(c.seed ^ 0x3c6ef372u, fidM));
    let r = win_rect(s, BAY_W);
    ws = WinStyle(seg_bay(s), s.floorH, r.x, r.y, r.z, r.w, rc, 6.0, 0.25, 1.2, 0.5, 0.1);
    let w = window_facade(c, ws, style, tint, sf);
    let panel = fract(c.facade / vec2f(3.0, s.floorH));
    let seam = 1.0 - (1.0 - aa_box(panel.x, 0.0, 0.03, c.fw.x / 3.0)) * (1.0 - aa_box(panel.y, 0.0, 0.03, c.fw.y / s.floorH));
    panel_joints(c, to_line(c.facade.x, 3.0), to_line(c.facade.y, s.floorH), 0.03, -0.02, 1.0 - w);
    // Pillowed panels: soft oil-can reflections.
    let pc = (panel - 0.5) * vec2f(3.0, s.floorH);
    add_relief(c, -pc * vec2f(0.006 / 2.25, 0.006 / (0.25 * s.floorH * s.floorH)) * (1.0 - w), 1.5, 0.0);
    let base = mix(vec3f(0.16, 0.17, 0.19), vec3f(0.22, 0.2, 0.18), hash11(c.seed + 9u));
    (*sf).albedo = mix(base * (1.0 - 0.5 * seam) * g, vec3f(0.02), w);
    (*sf).metallic = mix(0.7, 0.0, w);
    (*sf).roughness = mix(0.45, 0.1, w);
    (*sf).reflectivity = 0.4;
  } else if (style == ST_SLUM) {
    // One bay width per building (rooms differ between buildings, but
    // each building's windows stack: ART_BIBLE.md S1).
    let r = win_rect(s, BAY_W);
    ws = WinStyle(seg_bay(s), s.floorH, r.x, r.y, r.z, r.w, 1.0, 4.0, 0.55, 1.3, 0.15, 0.4);
    let w = window_facade(c, ws, style, tint, sf);
    let concrete = mix(vec3f(0.26, 0.24, 0.22), vec3f(0.32, 0.22, 0.18), hash11(c.seed + 5u)) * g * g;
    (*sf).albedo = mix(concrete, vec3f(0.02), w);
    (*sf).roughness = mix(0.85, 0.15, w);
    (*sf).reflectivity = 0.2;
    // Board-formed concrete: 0.15 m board lines, seen in grazing light.
    add_relief(c, vec2f(0.0, 0.004 * TAU / 0.15 * cos(TAU * c.facade.y / 0.15)) * (1.0 - w), 0.075, 0.01);
    // Tiny neon signs scattered on the walls.
    let sc = floor(c.facade / vec2f(9.0, 7.0));
    let sh = hash3_u(c.seed ^ 0xabcdu, u_of(sc.x), u_of(sc.y));
    if ((sh & 31u) == 0u) {
      let sp = fract(c.facade / vec2f(9.0, 7.0));
      let m = aa_box(sp.x, 0.2, 0.8, 0.05) * aa_box(sp.y, 0.35, 0.65, 0.05);
      let col = select(accent, vec3f(1.0) - accent * 0.5, (sh & 32u) == 0u);
      // Steady, except a rare faulty tube that stutters now and then.
      let faulty = (sh & 448u) == 0u;
      let burst = step(0.92, fract(c.time * 0.13 + f32(sh & 255u) * 0.37));
      let flick = select(1.0, 1.0 - burst * step(0.5, fract(c.time * 9.0)), faulty);
      (*sf).emissive += col * m * 4.0 * flick;
    }
  } else if (style == ST_MONOLITH) {
    // Dark stone with horizontal strip windows every few floors and ribs;
    // the strips are real rooms (interior mapping, varied lights, blinds).
    let bandH = s.floorH * 3.0;
    let r = win_rect(s, BAY_W);
    ws = WinStyle(seg_bay(s), bandH, r.x, r.y, r.z, r.w, 1.0 + floor(3.0 * hash11(c.seed + 21u)), 8.0, 0.6, 5.0, 0.45, 0.1);
    let w = window_facade(c, ws, style, tint, sf);
    let rib = aa_box(wall_bay(c, ws.cellW).y, 0.0, 0.12, c.fw.x / ws.cellW);
    (*sf).albedo = mix(vec3f(0.07, 0.065, 0.06) * (1.0 + rib * 0.6) * g, vec3f(0.02), w);
    // Basalt joints, 1.5 x 0.75 m, staggered.
    let course = floor(c.facade.y / 0.75);
    panel_joints(c, to_line(c.facade.x + 0.75 * (course % 2.0), 1.5), to_line(c.facade.y, 0.75), 0.012, -0.008, 1.0 - w);
    (*sf).roughness = mix(0.35, 0.06, w);
    (*sf).metallic = mix(0.3, 0.0, w);
    (*sf).reflectivity = mix(0.5, 0.85, w);
  } else if (style == ST_PODIUM) {
    // Shopfronts on the ground floors, offices above.
    let shopH = 7.0;
    if (c.world.y < shopH) {
      shopfront(c, tint, accent, sf);
    } else {
      // 3 m mullion grid with spandrels (no giant blank panes).
      ws = WinStyle(seg_bay(s), s.floorH, 0.06, 0.94, 0.3, 0.88, 3.0, 8.0, 0.25, 2.0, 0.3, 0.0);
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
    // Fade the animated pattern to its average where it would alias.
    let ledDet = detail(vec2f(5.0, 5.0), c.fw);
    let led = mix((tint + accent) * 0.012, led_pattern(c, tint, accent), ledDet);
    (*sf).albedo = vec3f(0.02);
    (*sf).roughness = 0.3;
    (*sf).reflectivity = 0.3;
    // LED panels come in strips with dark structural gaps between floors.
    let strip = aa_box(fract(c.facade.y / 4.0), 0.0, 0.62, c.fw.y / 4.0);
    (*sf).emissive += led * 0.5 * strip;
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
    let blink = 0.6 + 0.4 * sin(c.time * 1.2 + hash11(c.seed) * 6.28);
    (*sf).emissive += accent * smoothstep(0.08, 0.0, length(lp * vec2f(8.0, 24.0)) / 8.0) * 6.0 * blink;
  } else if (style == ST_NEONRING) {
    let pulse = 0.75 + 0.25 * sin(c.time * 2.0 + c.facade.x * 0.05);
    (*sf).albedo = vec3f(0.02);
    (*sf).emissive += accent * 5.0 * pulse;
  } else if (style == ST_BRIDGE) {
    ws = WinStyle(seg_bay(s), 5.0, 0.04, 0.96, 0.25, 0.85, 3.0, 6.0, 0.8, 1.6, 0.0, 0.0);
    let w = window_facade(c, ws, ST_GLASS, tint, sf);
    (*sf).albedo = mix(vec3f(0.06), vec3f(0.02, 0.03, 0.04), w);
    (*sf).roughness = mix(0.5, 0.05, w);
    (*sf).reflectivity = 0.7;
  }
  // LED strips and bands.
  let flags = s.flags;
  if ((flags & F_BANDS) != 0u) {
    // Mechanical floors only (every 15 floors), never every few floors.
    let every = s.floorH * 15.0;
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
  // Membrane/concrete panels with tar seams and patches, skylights glowing
  // from the floor below, and painted helipads on big roofs.
  let det = detail(vec2f(3.0), c.fw);
  let tile = floor(q / 3.0);
  let ft = fract(q / 3.0);
  let ht = hash3_u(s.seed ^ 0x1b873593u, u_of(tile.x), u_of(tile.y));
  let seam = (1.0 - aa_box(ft.x, 0.03, 0.97, c.fw.x / 3.0) * aa_box(ft.y, 0.03, 0.97, c.fw.y / 3.0)) * det;
  let n = vnoise2(q * 0.5 + vec2f(f32(s.seed & 255u)));
  let tar = smoothstep(0.7, 0.8, n) * 0.6;
  var alb = mix(vec3f(0.16, 0.155, 0.15), vec3f(0.22, 0.2, 0.18), u2f(ht)) * (0.85 + 0.3 * vnoise2(q * 1.7));
  alb = mix(alb, vec3f(0.05, 0.05, 0.055), max(tar * 0.8, seam * 0.6));
  (*sf).albedo = alb;
  (*sf).roughness = mix(0.75, 0.4, tar);
  (*sf).reflectivity = mix(0.3, 0.5, tar);
  let cell = floor(q / 6.0);
  let h = hash3_u(s.seed, u_of(cell.x), u_of(cell.y));
  let half = s.size.xz * 0.5 * s.taper;
  let inner = all(abs(cell * 6.0 + 3.0) < half - 4.0);
  // Skylights only as a row over a monolith atrium (ART_BIBLE.md 9).
  if (s.style == ST_MONOLITH && abs(q.y) < 4.0 && abs(q.x) < 9.0 && inner) {
    // Skylight: a glazed strip with warm light from below.
    let fc = fract(q / 6.0);
    let m = aa_box(fc.x, 0.2, 0.8, c.fw.x / 6.0) * aa_box(fc.y, 0.3, 0.7, c.fw.y / 6.0);
    let bars = mix(1.0, 0.4, step(0.85, fract(q.x * 1.5)) * det);
    (*sf).albedo = mix((*sf).albedo, vec3f(0.02), m);
    (*sf).roughness = mix((*sf).roughness, 0.08, m);
    (*sf).emissive += vec3f(1.0, 0.7, 0.42) * m * bars * (0.25 + 0.5 * u2f_rot(h, 8u));
  }
  // Helipad.
  if (s.shape <= 1u && min(half.x, half.y) > 20.0 && (s.seed & 7u) < 2u && (s.flags & F_RING) == 0u) {
    let r = length(q);
    let ring = aa_box(r, 9.0, 9.8, c.fw.x);
    let hx = aa_box(abs(q.x), 2.0, 2.8, c.fw.x) * aa_box(abs(q.y), 0.0, 4.0, c.fw.y);
    let hb = aa_box(abs(q.x), 0.0, 2.0, c.fw.x) * aa_box(abs(q.y), 0.0, 0.4, c.fw.y);
    let paint = max(ring, max(hx, hb));
    let col = select(vec3f(0.75, 0.6, 0.15), vec3f(0.8), (s.seed & 8u) != 0u);
    (*sf).albedo = mix((*sf).albedo, col, paint * 0.9);
    // Perimeter lights.
    let ang = atan2(q.y, q.x);
    let dots = smoothstep(0.35, 0.0, length(vec2f(r - 11.0, (fract(ang / TAU * 24.0) - 0.5) * r * TAU / 24.0)));
    (*sf).emissive += vec3f(0.2, 1.0, 0.4) * dots * 3.0;
  }
  // Parapet edge glow.
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
  // Road layout is defined in grid space (see warp.wgsl).
  let p = unwarp2(c.world.xz);
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

fn shade_facade(s: Segment, world: vec3f, n: vec3f, facade: vec2f, fw: vec2f, local: vec3f, capUv: vec2f, face: vec2f) -> Shaded {
  g_seg = s;
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
  c.face = face;
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
    sf.albedo *= g_revealAO;
    if (s.style != ST_LED && s.style != ST_NEONRING) {
      // Also on reflectivity: curtain walls read through their reflections.
      let wth = weathering(c, s);
      sf.albedo *= wth;
      sf.reflectivity *= wth * wth;
    }
    apply_relief(c, &sf);
    apply_wet(c, &sf, false);
    // Joints and recesses fill with water first (ART_BIBLE.md 12.4).
    sf.roughness = mix(sf.roughness, 0.05, g_joint * frame.wetness);
    // Vertical LED strips on box edges.
    // Edge strips: landmarks light only their top 30%; LED frames run full
    // height (ART_BIBLE.md 10).
    if ((s.flags & F_EDGE) != 0u && (c.hRel > 0.7 || s.style == ST_LED)) {
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
