// Bind group 0 shared by all scene shading passes: frame uniforms and the
// clustered light lists.
#include "frame.wgsl"
#include "common.wgsl"
#include "clusters.wgsl"

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> lights: array<Light>;
@group(0) @binding(2) var<storage, read> clusterCounts: array<u32>;
@group(0) @binding(3) var<storage, read> clusterLights: array<u32>;

// Set by fragment entry points so lighting can find its cluster.
var<private> g_fragCoord: vec4f;
