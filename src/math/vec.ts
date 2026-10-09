// Small vector/matrix library. Matrices are column-major Float32Arrays, as
// WGSL expects. Vectors are plain number tuples for readability on the CPU.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
export type Mat4 = Float32Array;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const sub = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const scale = (a: Vec3, s: number): Vec3 => [
  a[0] * s,
  a[1] * s,
  a[2] * s,
];
export const mul = (a: Vec3, b: Vec3): Vec3 => [
  a[0] * b[0],
  a[1] * b[1],
  a[2] * b[2],
];
export const dot = (a: Vec3, b: Vec3) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vec3, b: Vec3) => length(sub(a, b));
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-20 ? scale(a, 1 / l) : [0, 0, 0];
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];
export const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export function mat4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiply(
  a: Mat4,
  b: Mat4,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) {
        s += a[k * 4 + row] * b[c * 4 + k];
      }
      r[c * 4 + row] = s;
    }
  }
  out.set(r);
  return out;
}

/**
 * Reversed-Z infinite perspective (depth 1 at the near plane, 0 at infinity).
 * Maps view space (-Z forward) to WebGPU clip space.
 */
export function perspectiveReversedInfinite(
  fovY: number,
  aspect: number,
  near: number,
): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = 0;
  m[11] = -1;
  m[14] = near;
  return m;
}

/** Camera-to-world matrix looking from eye toward target. */
export function lookAtCamera(
  eye: Vec3,
  target: Vec3,
  up: Vec3 = [0, 1, 0],
): Mat4 {
  const z = normalize(sub(eye, target));
  let x = normalize(cross(up, z));
  if (length(x) < 1e-6) {
    x = [1, 0, 0];
  }
  const y = cross(z, x);
  const m = new Float32Array(16);
  m.set([...x, 0, ...y, 0, ...z, 0, ...eye, 1]);
  return m;
}

/** Builds a camera-to-world matrix from a basis (right, up, back) and position. */
export function fromBasis(x: Vec3, y: Vec3, z: Vec3, p: Vec3): Mat4 {
  const m = new Float32Array(16);
  m.set([...x, 0, ...y, 0, ...z, 0, ...p, 1]);
  return m;
}

export function invert(m: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  const a = m;
  const b00 = a[0] * a[5] - a[1] * a[4];
  const b01 = a[0] * a[6] - a[2] * a[4];
  const b02 = a[0] * a[7] - a[3] * a[4];
  const b03 = a[1] * a[6] - a[2] * a[5];
  const b04 = a[1] * a[7] - a[3] * a[5];
  const b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12];
  const b07 = a[8] * a[14] - a[10] * a[12];
  const b08 = a[8] * a[15] - a[11] * a[12];
  const b09 = a[9] * a[14] - a[10] * a[13];
  const b10 = a[9] * a[15] - a[11] * a[13];
  const b11 = a[10] * a[15] - a[11] * a[14];
  const det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const id = 1 / det;
  const r = [
    (a[5] * b11 - a[6] * b10 + a[7] * b09) * id,
    (a[2] * b10 - a[1] * b11 - a[3] * b09) * id,
    (a[13] * b05 - a[14] * b04 + a[15] * b03) * id,
    (a[10] * b04 - a[9] * b05 - a[11] * b03) * id,
    (a[6] * b08 - a[4] * b11 - a[7] * b07) * id,
    (a[0] * b11 - a[2] * b08 + a[3] * b07) * id,
    (a[14] * b02 - a[12] * b05 - a[15] * b01) * id,
    (a[8] * b05 - a[10] * b02 + a[11] * b01) * id,
    (a[4] * b10 - a[5] * b08 + a[7] * b06) * id,
    (a[1] * b08 - a[0] * b10 - a[3] * b06) * id,
    (a[12] * b04 - a[13] * b02 + a[15] * b00) * id,
    (a[9] * b02 - a[8] * b04 - a[11] * b00) * id,
    (a[5] * b07 - a[4] * b09 - a[6] * b06) * id,
    (a[0] * b09 - a[1] * b07 + a[2] * b06) * id,
    (a[13] * b01 - a[12] * b03 - a[14] * b00) * id,
    (a[8] * b03 - a[9] * b01 + a[10] * b00) * id,
  ];
  out.set(r);
  return out;
}

export function translation(t: Vec3): Mat4 {
  const m = mat4();
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  return m;
}

export function rotationY(a: number): Mat4 {
  const m = mat4();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

export function rotationX(a: number): Mat4 {
  const m = mat4();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

export function rotationZ(a: number): Mat4 {
  const m = mat4();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

export function scaling(s: Vec3): Mat4 {
  const m = mat4();
  m[0] = s[0];
  m[5] = s[1];
  m[10] = s[2];
  return m;
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [
    (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w,
    (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w,
    (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) / w,
  ];
}

export function transformDir(m: Mat4, d: Vec3): Vec3 {
  return [
    m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
    m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
    m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
  ];
}

/** Rotates v around a unit axis by angle (Rodrigues). */
export function rotateAround(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = axis;
  return add(
    add(scale(v, c), scale(cross(k, v), s)),
    scale(k, dot(k, v) * (1 - c)),
  );
}

/** Extracts 5 frustum planes (inward facing, xyz normal + w) from a view-projection. */
export function frustumPlanes(vp: Mat4): Vec4[] {
  const row = (r: number): Vec4 => [vp[r], vp[4 + r], vp[8 + r], vp[12 + r]];
  const r0 = row(0);
  const r1 = row(1);
  const r2 = row(2);
  const r3 = row(3);
  const planes: Vec4[] = [
    [r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]],
    [r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]],
    [r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]],
    [r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]],
    // Reversed-Z: near plane is z <= w, i.e. w - z >= 0. The far plane is at
    // infinity so it is omitted.
    [r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]],
  ];
  return planes.map(p => {
    const l = Math.hypot(p[0], p[1], p[2]);
    return [p[0] / l, p[1] / l, p[2] / l, p[3] / l] as Vec4;
  });
}
