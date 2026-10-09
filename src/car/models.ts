// Registry of vehicle models built with the NURBS API.
import type {Model} from '../nurbs/model';
import type {Vec3} from '../math/vec';
import {buildSpinner, SPINNER_DRIVER_EYE} from './spinner';

export interface ModelEntry {
  build: () => Model;
  /** Driver eye position in model space (for the cockpit camera). */
  driverEye: Vec3;
}

export const MODELS: Record<string, ModelEntry> = {
  spinner: {build: buildSpinner, driverEye: SPINNER_DRIVER_EYE},
};
