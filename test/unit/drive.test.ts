import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DriveControl} from '../../src/camera/drive';
import {makeRepelField} from '../../src/city/inside';
import {SegmentList, Style} from '../../src/city/segments';
import {Shape} from '../../src/city/meshes';
import {mat4} from '../../src/math/vec';

// Flying full throttle straight at a building must not get inside it:
// the soft walls push the car out and it slides along.
test('buildings softly repel the user-flown car', () => {
  const segs = new SegmentList();
  segs.push({
    x: 0,
    y: 0,
    z: -200,
    rotY: 0.3,
    sx: 80,
    sy: 400,
    sz: 80,
    taper: 1,
    twist: 0,
    shape: Shape.Box,
    style: Style.GlassOffice,
    seed: 1,
    colorA: 0,
    colorB: 0,
    flags: 0,
    floorH: 4,
  });
  const drive = new DriveControl();
  drive.repel = makeRepelField(segs);
  const start = {
    position: [5, 150, 0] as [number, number, number],
    forward: [0, 0, -1] as [number, number, number],
    up: [0, 1, 0] as [number, number, number],
    right: [1, 0, 0] as [number, number, number],
    speed: 80,
    matrix: mat4(),
  };
  drive.enter(start);
  let minDist = Infinity;
  for (let i = 0; i < 1200; i++) {
    const p = drive.update(1 / 60, {throttle: 1, steer: 0, climb: 0}, start);
    const r = drive.repel(p.position[0], p.position[1], p.position[2]);
    minDist = Math.min(minDist, r.dist);
  }
  assert.ok(minDist > -0.5, `got ${minDist.toFixed(2)} m inside the building`);
});
