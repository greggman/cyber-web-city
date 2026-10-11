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
  for (const steer of [1, -1]) {
    drive.enter(start);
    let p = start;
    for (let i = 0; i < 180; i++) {
      p = drive.update(1 / 60, {steer, climb: 0, speed: 0}, start);
    }
    // Horizontal right of the heading.
    const f = p.forward;
    const l = Math.hypot(f[0], f[2]);
    const lean = (p.up[0] * -f[2] + p.up[2] * f[0]) / l;
    assert.ok(lean * steer > 0.05, `steer ${steer}: lean ${lean.toFixed(3)}`);
  }
});

// Diving flat out never takes the car below the floor: it levels off.
test('the user-flown car cannot fly into the ground', () => {
  const drive = new DriveControl();
  const start = {
    position: [0, 200, 0] as [number, number, number],
    forward: [0, 0, -1] as [number, number, number],
    up: [0, 1, 0] as [number, number, number],
    right: [1, 0, 0] as [number, number, number],
    speed: 80,
    matrix: mat4(),
  };
  drive.enter(start);
  let minY = Infinity;
  for (let i = 0; i < 60 * 30; i++) {
    const p = drive.update(1 / 60, {steer: 0, climb: -1, speed: 1}, start);
    minY = Math.min(minY, p.position[1]);
  }
  assert.ok(minY > 9, `got down to ${minY.toFixed(2)} m`);
});

// Steering keys are on/off; the car must still turn in and out smoothly
// (a virtual wheel): no jump in turn rate when a key goes down or up.
test('steering keys turn the car in and out smoothly', () => {
  const drive = new DriveControl();
  const start = {
    position: [0, 150, 0] as [number, number, number],
    forward: [0, 0, -1] as [number, number, number],
    up: [0, 1, 0] as [number, number, number],
    right: [1, 0, 0] as [number, number, number],
    speed: 38,
    matrix: mat4(),
  };
  drive.enter(start);
  const dt = 1 / 60;
  const yaws: number[] = [];
  for (let i = 0; i < 60 * 6; i++) {
    // Hold right for 3 s, then let go.
    const steer = i < 180 ? 1 : 0;
    const p = drive.update(dt, {steer, climb: 0, speed: 0}, start);
    yaws.push(Math.atan2(p.forward[0], p.forward[2]));
  }
  const rates: number[] = [];
  for (let i = 1; i < yaws.length; i++) {
    const d = Math.atan2(
      Math.sin(yaws[i] - yaws[i - 1]),
      Math.cos(yaws[i] - yaws[i - 1]),
    );
    rates.push(Math.abs(d) / dt);
  }
  const max = Math.max(...rates);
  assert.ok(max > 0.5, `barely turned (max ${max.toFixed(2)} rad/s)`);
  // Gentle start: the first frames turn almost nothing.
  assert.ok(rates[2] < max * 0.03, `jumped in: ${rates[2].toFixed(3)} rad/s`);
  // No frame-to-frame jumps in turn rate, pressing or releasing.
  for (let i = 1; i < rates.length; i++) {
    const j = Math.abs(rates[i] - rates[i - 1]);
    assert.ok(j < 0.02, `turn rate jumped ${j.toFixed(3)} at frame ${i}`);
  }
  // Back to straight after letting go.
  assert.ok(rates[rates.length - 1] < max * 0.05, 'still turning');
});

// Pressing the opposite key while turning answers at once (about 0.1 s).
test('counter-steering reverses the turn quickly', () => {
  const drive = new DriveControl();
  const start = {
    position: [0, 150, 0] as [number, number, number],
    forward: [0, 0, -1] as [number, number, number],
    up: [0, 1, 0] as [number, number, number],
    right: [1, 0, 0] as [number, number, number],
    speed: 38,
    matrix: mat4(),
  };
  drive.enter(start);
  const dt = 1 / 60;
  const yaw = (p: {forward: number[]}) =>
    Math.atan2(p.forward[0], p.forward[2]);
  let p = start;
  // Full right turn for 3 s.
  for (let i = 0; i < 180; i++) {
    p = drive.update(dt, {steer: 1, climb: 0, speed: 0}, start);
  }
  // Then hard left: count frames until the car turns left.
  let prev = yaw(p);
  let frames = 0;
  let maxJump = 0;
  let prevRate = 0;
  for (; frames < 240; frames++) {
    p = drive.update(dt, {steer: -1, climb: 0, speed: 0}, start);
    const y = yaw(p);
    const rate = Math.atan2(Math.sin(y - prev), Math.cos(y - prev)) / dt;
    if (frames > 0) maxJump = Math.max(maxJump, Math.abs(rate - prevRate));
    prevRate = rate;
    prev = y;
    if (rate > 0.02) break;
  }
  assert.ok(
    frames < 20,
    `took ${(frames / 60).toFixed(2)} s to turn the other way`,
  );
  assert.ok(
    maxJump < 0.3, // quick, but not an instant flip
    `turn rate jumped ${maxJump.toFixed(3)} rad/s in a frame`,
  );
});
