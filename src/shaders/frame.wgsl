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
};
