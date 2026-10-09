# NURBS modeling API

Everything lives in `src/nurbs/`. There are no external libraries. Models are
lists of NURBS surface **parts** with materials. They are tessellated on load
and rendered by the game and by the preview page.

## Conventions

- Units are **meters**.
- **+X is right, +Y is up, and the nose points toward −Z.**
- `y = 0` is the ground under the vehicle when it is parked. In flight, the
  game positions the model itself.
- Surfaces are one-sided unless `doubleSided: true` is set. The front face is
  the side that `du × dv` points to (where u and v are the surface
  parameters). Use `surface.flipped()` if a part renders inside out.
- `mirror: true` on a part adds a copy mirrored across `x = 0` with its
  orientation preserved, so model only the right half (x ≥ 0) of symmetric
  parts.

## Curves: `NurbsCurve`

```ts
import {NurbsCurve} from '../nurbs/nurbs';

new NurbsCurve(degree, points, weights?, knots?) // knots default: clamped uniform
NurbsCurve.fromPoints(points, degree = 3)        // B-spline with this control polygon
NurbsCurve.interpolate(points, degree = 3)       // passes THROUGH the points
NurbsCurve.line(a, b)
NurbsCurve.arc(center, xAxis, yAxis, radius, a0, a1) // exact rational arc
NurbsCurve.circle(center, xAxis, yAxis, radius)

curve.evaluate(t)            // t in [0, 1]
curve.derivatives(t, n)      // [point, d1, ..., dn]
curve.tangent(t)
curve.sample(n)              // n + 1 points
curve.length()
curve.transform(p => ...)    // map control points (affine maps are exact)
curve.reversed()
```

## Surfaces: `NurbsSurface`

```ts
new NurbsSurface(degreeU, degreeV, points[u][v], weights?, knotsU?, knotsV?)
surface.evaluate(u, v)   // u, v in [0, 1]
surface.normal(u, v)
surface.derivatives(u, v) // {point, du, dv}
surface.transform(fn) / .flipped() / .transposed() / .mirrorX()
```

### Constructors (`src/nurbs/nurbs.ts`)

| Function | Result |
|---|---|
| `loft(sections, degreeV = 3, {resample?})` | Skin through section curves. u runs along each curve, v across sections. Sections with different control counts are resampled automatically, but for best quality give every section the same number of control points and the same degree. |
| `revolve(profile, origin, axis, angle = 2π)` | Exact surface of revolution. u runs along the profile, v around the axis. |
| `extrude(curve, dir)` | Linear extrusion. |
| `sweep(profile, rail, {sections, up, scaleAlong})` | Sweeps a profile drawn in local XY along a rail. `scaleAlong(t)` tapers it. |
| `bilinear(p00, p10, p01, p11)` | Flat or twisted four-corner patch. |

## Tessellation options (`part.tessellation`)

```ts
{
  segmentsU?, segmentsV?,   // fixed counts; otherwise adaptive
  maxAngle?: radians,       // default 7 degrees between adjacent facets
  maxEdge?: meters,         // default 0.25
  minSegments?, maxSegments?,
  keep?: (u, v) => boolean  // trim: drop triangles whose centroid fails
}
```

## Models and materials (`src/nurbs/model.ts`)

```ts
interface Part {
  name: string;
  surface: NurbsSurface;
  material: 'paint' | 'chrome' | 'metal' | 'glass' | 'tinted-glass' | 'emissive'
          | 'rubber' | 'plastic' | 'leather' | 'carbon' | 'screen';
  color?: Vec3;        // linear RGB 0..1
  emissive?: Vec3;     // HDR emission for 'emissive' (e.g. [8, 2, 1]), tint for 'screen'
  roughness?: number;
  mirror?: boolean;
  doubleSided?: boolean;
  screenId?: number;   // 'screen' content: 0 nav map, 1 gauges, 2 comms text
  tessellation?: TessOptions;
}
interface Model { name: string; parts: Part[] }
```

- `glass` is clear and transparent. The game adds rain droplets and
  condensation to it, using the glass part's (u, v) as texture coordinates,
  so keep the canopy as **one or a few smooth surfaces with well-behaved
  parameterization**.
- `emissive` parts are light bars, head and tail lights, and thruster glows.
  Values above 1 bloom.
- `screen` parts show animated dashboard content mapped over the part's
  (u, v).

## Previewing

```
npm run build
node test/car-shots.mjs spinner                       # default view set -> out/car/
node test/car-shots.mjs spinner side:studio pov:city  # specific views
node test/car-shots.mjs spinner interior:studio:nocanopy=1
```

The available views are `three-quarter`, `rear-three-quarter`, `front`, `rear`,
`side`, `top`, `low`, `interior` and `pov` (from the driver's eye, set by
`driverEye` in `src/car/models.ts`). The environments are `studio` and `city`.
To look at the page directly, run `npm run dev` and open
`http://localhost:8080/car-preview.html?view=three-quarter&env=city&spin=1`.
