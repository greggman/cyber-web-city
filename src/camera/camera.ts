// Camera state shared by the flight controller and renderer.
import {lookAtCamera, type Mat4, type Vec3} from '../math/vec';

export class Camera {
  camToWorld: Mat4 = lookAtCamera([0, 200, 0], [0, 200, -1]);
  fovY = (60 * Math.PI) / 180;
  near = 0.05;

  get position(): Vec3 {
    const m = this.camToWorld;
    return [m[12], m[13], m[14]];
  }

  get forward(): Vec3 {
    const m = this.camToWorld;
    return [-m[8], -m[9], -m[10]];
  }

  lookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]) {
    this.camToWorld = lookAtCamera(eye, target, up);
  }
}
