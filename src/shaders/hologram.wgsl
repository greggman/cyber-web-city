// Building-sized holograms: a box proxy is rasterized; the fragment shader
// raymarches an animated SDF inside it and accumulates glowing,
// translucent, scanlined light (additive, depth-limited by the scene).
#include "scene.wgsl"
#include "sdf.wgsl"
#include "sky.wgsl"

struct Holo {
  pos: vec3f, scale: f32,
  color: vec3f, kind: u32,
  color2: vec3f, rot: f32,
};

@group(1) @binding(0) var<storage, read> holos: array<Holo>;
@group(1) @binding(1) var depthTex: texture_depth_2d;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) idx: u32,
};

// Object-space bounds per kind (y up, feet at 0).
fn holo_bounds(kind: u32) -> vec3f {
  switch kind {
    case 1u: { return vec3f(0.9, 1.1, 0.8); }     // face (centered at y=1)
    case 2u: { return vec3f(1.2, 0.5, 1.2); }     // koi ring
    case 3u: { return vec3f(0.8, 1.0, 0.8); }     // jellyfish
    case 4u: { return vec3f(0.9, 0.9, 0.9); }     // logo
    default: { return vec3f(0.9, 1.15, 0.6); }    // dancer
  }
}
fn holo_center(kind: u32) -> vec3f {
  switch kind {
    case 1u: { return vec3f(0.0, 1.0, 0.0); }
    case 2u: { return vec3f(0.0, 0.5, 0.0); }
    case 3u: { return vec3f(0.0, 0.3, 0.0); }
    case 4u: { return vec3f(0.0, 0.9, 0.0); }
    default: { return vec3f(0.0, 1.1, 0.0); }
  }
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let h = holos[ii];
  // 36-vertex cube from bits.
  let idx = array<u32, 36>(0,2,1, 1,2,3, 4,5,6, 5,7,6, 0,1,4, 1,5,4, 2,6,3, 3,6,7, 0,4,2, 2,4,6, 1,3,5, 3,7,5)[vi];
  let c = vec3f(f32(idx & 1u), f32((idx >> 1u) & 1u), f32((idx >> 2u) & 1u)) * 2.0 - 1.0;
  let local = holo_center(h.kind) + c * holo_bounds(h.kind);
  let world = h.pos + rot_y(local, h.rot) * h.scale;
  var o: VOut;
  o.pos = frame.viewProj * vec4f(world, 1.0);
  if (distance(h.pos, frame.camPos) > 6000.0) { o.pos = vec4f(0.0, 0.0, -1.0, 1.0); }
  o.idx = ii;
  return o;
}

fn holo_sdf(kind: u32, p: vec3f, t: f32) -> f32 {
  switch kind {
    case 1u: {
      var id = 0u;
      return sd_face(p - vec3f(0.0, 1.0, 0.0), t, &id);
    }
    case 2u: {
      var d = 1e9;
      for (var k = 0; k < 3; k++) {
        let a = t * 0.35 + f32(k) * TAU / 3.0;
        let c = vec3f(cos(a) * 0.85, 0.5 + 0.15 * sin(t + f32(k)), sin(a) * 0.85);
        let q = rot_y(p - c, -a - PI * 0.5);
        d = min(d, sd_koi(q * 1.8, t + f32(k)) / 1.8);
      }
      return d;
    }
    case 3u: { return sd_jelly(p - vec3f(0.0, 0.0, 0.0), t); }
    case 4u: { return sd_logo(p - vec3f(0.0, 0.9, 0.0), t); }
    default: { return sd_dancer(p, t * 0.8); }
  }
}

fn box_hit(ro: vec3f, rd: vec3f, bmin: vec3f, bmax: vec3f) -> vec2f {
  let inv = 1.0 / rd;
  let t0 = (bmin - ro) * inv;
  let t1 = (bmax - ro) * inv;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  return vec2f(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  let h = holos[i.idx];
  let uv = i.pos.xy * frame.invResolution;
  let sceneD = textureLoad(depthTex, vec2i(i.pos.xy), 0);
  let sceneDist = select(1e9, linear_depth(sceneD, frame.near), sceneD > 0.0);
  let wpos = world_from_depth(uv, 1e-3, frame.invViewProj);
  let rdW = normalize(wpos - frame.camPos);
  // Object space (scale 1).
  let ro = rot_y((frame.camPos - h.pos) / h.scale, -h.rot);
  let rd = rot_y(rdW, -h.rot);
  let c = holo_center(h.kind);
  let b = holo_bounds(h.kind);
  let span = box_hit(ro, rd, c - b, c + b);
  if (span.y <= max(span.x, 0.0)) { discard; }
  // Depth along the view ray -> object space distance limit.
  let fwd = -vec3f(frame.view[0][2], frame.view[1][2], frame.view[2][2]);
  let maxT = sceneDist / max(dot(rdW, fwd), 1e-3) / h.scale;
  var t = max(span.x, 0.0);
  let tEnd = min(span.y, maxT);
  let time = frame.time + f32(h.kind) * 10.0 + h.rot * 5.0;
  // Glitch: occasional horizontal band offsets.
  let gl = step(0.93, hash11(u32(frame.time * 8.0) + i.idx * 31u));
  var glow = 0.0;
  var surf = 0.0;
  var yHit = 0.0;
  for (var k = 0; k < 56; k++) {
    if (t >= tEnd) { break; }
    var p = ro + rd * t;
    p.x += gl * 0.05 * sin(floor(p.y * 20.0) * 3.0);
    let d = holo_sdf(h.kind, p, time);
    glow += exp(-max(d, 0.0) * 30.0) * 0.035;
    if (d < 0.004) {
      // Fresnel-ish rim from the SDF gradient.
      let e = 0.01;
      let n = normalize(vec3f(
        holo_sdf(h.kind, p + vec3f(e, 0.0, 0.0), time) - d,
        holo_sdf(h.kind, p + vec3f(0.0, e, 0.0), time) - d,
        holo_sdf(h.kind, p + vec3f(0.0, 0.0, e), time) - d));
      surf = 0.1 + pow(1.0 - abs(dot(n, rd)), 2.0) * 1.5;
      // Wireframe contour lines over the surface.
      let grid = max(step(0.92, fract(p.y * 24.0)), step(0.95, fract(atan2(p.z, p.x) * 6.0)));
      surf += grid * 0.8;
      yHit = p.y;
      break;
    }
    t += max(d * 0.9, 0.01);
  }
  if (surf <= 0.0 && glow < 0.02) { discard; }
  let wy = (h.pos.y + yHit * h.scale);
  let scan = 0.65 + 0.35 * step(0.5, fract(wy * 0.5 - frame.time * 2.0));
  let flick = 0.85 + 0.15 * sin(frame.time * 31.0 + f32(i.idx)) * sin(frame.time * 7.0);
  let col = mix(h.color, h.color2, saturate(yHit * 0.5));
  var c3 = (col * surf * scan + h.color * glow) * flick * 1.6;
  // Atmospheric fade with distance.
  let dist = t * h.scale;
  c3 *= exp(-dist * 0.00025);
  // Up close a projection washes out instead of filling the frame.
  // Up close, relative to its size, a projection washes out so it never
  // swamps the frame (it reads from a distance).
  let camDist = distance(frame.camPos, h.pos + vec3f(0.0, h.scale, 0.0));
  c3 *= mix(0.15, 1.0, smoothstep(2.0 * h.scale, 5.0 * h.scale, camDist));
  return vec4f(c3, 0.0);
}
