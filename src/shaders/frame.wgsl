// Per-frame uniforms shared by every pass. Layout must match src/render/frame.ts.
struct Frame {
  viewProj: mat4x4f,          // jittered (for rasterization)
  viewProjNoJitter: mat4x4f,  // for motion vectors
  prevViewProj: mat4x4f,      // previous frame, no jitter
  invViewProj: mat4x4f,       // inverse of the jittered viewProj
  view: mat4x4f,
  proj: mat4x4f,
  invProj: mat4x4f,
  camToWorld: mat4x4f,
  camPos: vec3f, time: f32,
  resolution: vec2f, invResolution: vec2f,
  jitter: vec2f, near: f32, frameIndex: u32,
  fogColor: vec3f, fogDensity: f32,
  fogHeightFalloff: f32, rain: f32, wetness: f32, exposure: f32,
  tanHalfFov: vec2f, dt: f32, cameraMode: u32,
  carToWorld: mat4x4f,
  prevCarToWorld: mat4x4f,
  debugView: u32, quality: u32, cityGlow: f32, _pad0: f32,
  // City theme (src/city/theme.ts).
  fogHigh: vec3f, windowsLit: f32,
  skyHorizon: vec3f, weather: u32,   // 0 rain, 1 snow, 2 ash, 3 dust, 4 none
  mountains: f32, waterLevel: f32, flooded: f32, warpScale: f32,
  flares: f32, saturation: f32, _pad2: f32, _pad3: f32,
  grade: vec3f, _pad4: f32,
};
