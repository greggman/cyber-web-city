// The player's flying car (placeholder shape; see docs/NURBS.md).
// Convention: meters, +X right, +Y up, nose toward -Z, y = 0 is the ground.
import {NurbsCurve, loft} from '../nurbs/nurbs';
import type {Model} from '../nurbs/model';
import type {Vec3} from '../math/vec';

export const SPINNER_DRIVER_EYE: Vec3 = [-0.35, 1.25, 0.1];

/** Half cross-section (right side, from bottom center to top center). */
function section(z: number, w: number, h: number, base: number): NurbsCurve {
  return NurbsCurve.fromPoints(
    [
      [0, base, z],
      [w * 0.9, base, z],
      [w, base + h * 0.4, z],
      [w * 0.8, base + h, z],
      [0, base + h, z],
    ],
    3,
  );
}

export function buildSpinner(): Model {
  const body = loft([
    section(-2.7, 0.3, 0.2, 0.55),
    section(-2.2, 0.85, 0.45, 0.45),
    section(-0.8, 1.1, 0.55, 0.4),
    section(1.2, 1.15, 0.6, 0.4),
    section(2.5, 0.9, 0.55, 0.45),
  ]);
  const canopy = loft([
    NurbsCurve.arc([0, 0.95, -0.9], [1, 0, 0], [0, 1, 0], 0.15, 0, Math.PI / 2),
    NurbsCurve.arc([0, 0.95, 0.0], [1, 0, 0], [0, 1, 0], 0.95, 0, Math.PI / 2),
    NurbsCurve.arc([0, 0.95, 1.4], [1, 0, 0], [0, 1, 0], 0.7, 0, Math.PI / 2),
  ]);
  return {
    name: 'spinner (placeholder)',
    parts: [
      {
        name: 'body',
        surface: body,
        material: 'paint',
        color: [0.3, 0.32, 0.35],
        mirror: true,
      },
      {
        name: 'canopy',
        surface: canopy,
        material: 'glass',
        mirror: true,
        doubleSided: true,
      },
    ],
  };
}
