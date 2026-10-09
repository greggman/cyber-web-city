// Canopy droplets and condensation, simulated in the canopy's (u, v)
// texture space (u across the car, v front to back).
#include "common.wgsl"

struct Drop { uv: vec2f, vel: vec2f, radius: f32, life: f32, stick: f32, seed: f32 };
struct Params {
  dt: f32, time: f32, speed: f32, rain: f32,
  frame: u32, count: u32, pov: f32, _p: f32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> drops: array<Drop>;

fn rnd(seed: u32, k: u32) -> f32 { return hash21(seed, k); }

@compute @workgroup_size(64)
fn cs_update(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.count) { return; }
  var d = drops[i];
  let s = hash2_u(i, P.frame);
  d.life -= P.dt;
  if (d.life <= 0.0 || any(d.uv < vec2f(-0.05)) || any(d.uv > vec2f(1.05))) {
    // Respawn as a new raindrop hit (rate scales with rain).
    if (rnd(s, 1u) < P.rain * 0.9) {
      d.uv = vec2f(rnd(s, 2u), rnd(s, 3u));
      d.radius = mix(0.002, 0.009, pow(rnd(s, 4u), 3.0));
      d.vel = vec2f(0.0);
      d.life = mix(6.0, 30.0, rnd(s, 5u));
      d.stick = rnd(s, 6u);
      d.seed = rnd(s, 7u);
    } else {
      d.radius = 0.0;
    }
  }
  if (d.radius > 0.0) {
    // Big drops slide: airflow pushes them back (+v) with speed, gravity
    // pulls them toward the sides of the bubble. Stick-slip motion.
    let heavy = smoothstep(0.005, 0.009, d.radius);
    let side = sign(d.uv.x - 0.5) * smoothstep(0.1, 0.5, abs(d.uv.x - 0.5));
    let air = vec2f(0.0, 0.004 * P.speed);
    let grav = vec2f(side * 0.05, 0.02);
    let slip = step(0.3, fract(P.time * (0.5 + d.seed) + d.stick));
    let want = (air + grav) * heavy * slip;
    d.vel = mix(d.vel, want, saturate(P.dt * 4.0));
    d.uv += d.vel * P.dt;
    // Moving drops lose water to their trail.
    d.radius = max(0.0, d.radius - length(d.vel) * P.dt * 0.02);
    // Rain occasionally lands on a drop and grows it.
    if (rnd(s, 9u) < 0.002 * P.rain) { d.radius = min(0.012, d.radius + 0.002); }
  }
  drops[i] = d;
}

struct DOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) dir: vec2f,
  @location(2) moving: f32,
};

@group(0) @binding(2) var<storage, read> dropsRO: array<Drop>;

@vertex
fn vs_drop(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> DOut {
  let d = dropsRO[ii];
  let c = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1))[vi];
  let speed = length(d.vel);
  let dir = select(vec2f(0.0, 1.0), d.vel / max(speed, 1e-6), speed > 1e-5);
  let stretch = 1.0 + min(speed * 60.0, 2.5);
  let perp = vec2f(-dir.y, dir.x);
  let off = (perp * c.x + dir * c.y * stretch) * d.radius * 1.15;
  let uv = d.uv + off;
  var o: DOut;
  o.pos = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  if (d.radius <= 0.0) { o.pos = vec4f(2.0, 2.0, 0.0, 1.0); }
  o.local = vec2f(c.x, c.y * stretch);
  o.dir = dir;
  o.moving = min(speed * 80.0, 1.0);
  return o;
}

// Drop normal (rg) and coverage (a).
@fragment
fn fs_drop(i: DOut) -> @location(0) vec4f {
  // Teardrop: round head, tapered tail behind the motion.
  var q = i.local;
  let tail = max(-q.y - 0.5, 0.0) * i.moving;
  q.x *= 1.0 + tail * 1.5;
  q.y = select(q.y, -0.5 - (-q.y - 0.5) / (1.0 + 2.0 * i.moving), q.y < -0.5);
  let r = length(q);
  if (r > 1.0) { discard; }
  let n = q * (0.6 + 0.4 * r);
  let perp = vec2f(-i.dir.y, i.dir.x);
  let nUv = perp * n.x + i.dir * n.y;
  let cov = smoothstep(1.0, 0.8, r);
  return vec4f(nUv * 0.5 + 0.5, 0.0, cov);
}

// Drops wipe condensation (written with a 'min' blend into the fog map).
@fragment
fn fs_wipe(i: DOut) -> @location(0) vec4f {
  let r = length(i.local / vec2f(1.0, 1.0 + 1.5 * i.moving));
  if (r > 1.2) { discard; }
  return vec4f(0.0);
}

struct FsO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex
fn vs_full(@builtin(vertex_index) vi: u32) -> FsO {
  let f = fullscreen_vertex(vi);
  var o: FsO;
  o.pos = f.pos;
  o.uv = f.uv;
  return o;
}

@group(0) @binding(3) var fogPrev: texture_2d<f32>;
@group(0) @binding(4) var dropTex: texture_2d<f32>;
@group(0) @binding(5) var samp: sampler;

// Condensation regrows over time, heaviest near the canopy edges, and a
// periodic defog sweep from the front vents clears it.
@fragment
fn fs_fog(i: FsO) -> @location(0) vec4f {
  let prev = textureSampleLevel(fogPrev, samp, i.uv, 0.0).r;
  let edge = max(smoothstep(0.25, 0.0, i.uv.x), smoothstep(0.75, 1.0, i.uv.x));
  let low = smoothstep(0.5, 1.0, i.uv.y);
  let maxFog = (0.35 + 0.45 * max(edge, low * 0.6)) * (0.7 + 0.3 * vnoise2(i.uv * 9.0));
  var f = min(maxFog, prev + P.dt * 0.03 * (0.5 + edge));
  // Start in a steady state (the cabin has been fogging up for a while).
  if (P.frame < 2u) { f = maxFog * 0.85; }
  // Defog sweep every ~40 s.
  let sweep = fract(P.time / 40.0) * 3.0;
  f *= 1.0 - smoothstep(0.08, 0.0, abs(i.uv.y - sweep)) * 0.6;
  return vec4f(f, 0.0, 0.0, 1.0);
}

@group(0) @binding(6) var fogCur: texture_2d<f32>;

// Final fx: rg = droplet normal, b = condensation, a = droplet coverage.
@fragment
fn fs_combine(i: FsO) -> @location(0) vec4f {
  let d = textureSampleLevel(dropTex, samp, i.uv, 0.0);
  let fog = textureSampleLevel(fogCur, samp, i.uv, 0.0).r * mix(0.3, 1.0, P.pov);
  let n = mix(vec2f(0.5), d.rg, d.a);
  return vec4f(n, fog * (1.0 - d.a), d.a);
}
