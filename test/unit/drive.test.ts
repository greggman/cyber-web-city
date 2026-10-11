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
    const p = drive.update(1 / 60, {steer: 0, climb: 0, speed: 1}, start);
    const r = drive.repel(p.position[0], p.position[1], p.position[2]);
    minDist = Math.min(minDist, r.dist);
  }
  assert.ok(minDist > -0.5, `got ${minDist.toFixed(2)} m inside the building`);
});

// Handing back: the car flies itself to the new tour's start round a
// building in the way, never through it, then hands over.
test('the car flies itself round buildings to a new tour', () => {
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
    speed: 30,
    matrix: mat4(),
  };
  drive.enter(start);
  let arrived = false;
  drive.onRejoin = () => (arrived = true);
  // The tour starts behind the building.
  const goal: [number, number, number] = [0, 180, -420];
  drive.exit(p =>
    Math.hypot(p[0] - goal[0], p[2] - goal[2]) < 20 ? null : goal,
  );
  let minDist = Infinity;
  for (let i = 0; i < 60 * 25 && !arrived; i++) {
    const p = drive.update(1 / 60, {steer: 0, climb: 0, speed: 0}, start);
    const r = drive.repel(p.position[0], p.position[1], p.position[2]);
    minDist = Math.min(minDist, r.dist);
  }
  assert.ok(arrived, 'never arrived');
  assert.ok(minDist > -0.5, `got ${minDist.toFixed(2)} m inside the building`);
});

// Like the autopilot, the car leans into turns: steering right tilts its
// roof to the right.
test('the user-flown car banks into turns', () => {
  const drive = new DriveControl();
  const start = {
    position: [0, 150, 0] as [number, number, number],
    forward: [0, 0, -1] as [number, number, number],
    up: [0, 1, 0] as [number, number, number],
    right: [1, 0, 0] as [number, number, number],
    speed: 40,
    matrix: mat4(),
  };
  drive.enter(start);
  for (const steer of [1, -1]) {
    let p = start;
    for (let i = 0; i < 60; i++) {
      p = drive.update(1 / 60, {steer, climb: 0, speed: 0}, start);
    }
    // Horizontal right of the heading.
    const f = p.forward;
    const l = Math.hypot(f[0], f[2]);
    const lean = (p.up[0] * -f[2] + p.up[2] * f[0]) / l;
    assert.ok(lean * steer > 0.05, `steer ${steer}: lean ${lean.toFixed(3)}`);
  }
});
