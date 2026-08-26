import test from 'node:test';
import assert from 'node:assert/strict';

import {
  floorPlane, corners, toLocal, resizeFromCorner, pathLength, topDownMapping,
  rayBox, pickBox, rayPlaneZ, axisHeight, normYaw180, PICK, HANDLE,
} from '../../src/meshmark/web/geometry.js';

/** A slab of horizontal triangles at height z, plus optional vertical walls. */
function slab({ z, area = 1, n = 200 }) {
  return {
    cz: Float32Array.from({ length: n }, () => z),
    area: Float32Array.from({ length: n }, () => area / n),
    nz: Float32Array.from({ length: n }, () => 1),
  };
}
function concat(...parts) {
  const join = (k) => Float32Array.from(parts.flatMap((p) => [...p[k]]));
  return { cz: join('cz'), area: join('area'), nz: join('nz') };
}

test('the floor is found where it is, not at zero', () => {
  // The case this is ported from: two rooms whose floors sit at 108 mm and
  // 171 mm, both loaded at the origin. Assuming z=0 slices into one of them.
  const mesh = concat(
    slab({ z: 0.108, area: 40 }),                       // floor
    slab({ z: 0.9, area: 2 }),                          // a table top
    { cz: Float32Array.from([0.5, 0.6]), area: Float32Array.from([50, 50]), nz: Float32Array.from([0.02, -0.01]) } // walls
  );
  const floor = floorPlane(mesh);
  assert.ok(Math.abs(floor.z - 0.108) < 0.005, `floor came back at ${floor.z}`);
  assert.ok(floor.area > 30, 'the floor is the largest horizontal slab, by area');
});

test('area decides, not triangle count', () => {
  // A finely tessellated table top has many more triangles than a coarse floor.
  // Counting triangles would call the table the floor; weighting by area does not.
  const mesh = concat(
    slab({ z: 0.15, area: 40, n: 10 }),
    slab({ z: 0.75, area: 3, n: 5000 })
  );
  assert.ok(Math.abs(floorPlane(mesh).z - 0.15) < 0.01);
});

test('flatness is reported, because it decides whether a plane may replace it', () => {
  const n = 400;
  const mesh = {
    cz: Float32Array.from({ length: n }, (_, i) => 0.2 + (i % 2 ? 0.004 : -0.004)),
    area: Float32Array.from({ length: n }, () => 0.1),
    nz: Float32Array.from({ length: n }, () => 1),
  };
  const floor = floorPlane(mesh);
  assert.ok(Math.abs(floor.z - 0.2) < 1e-3);
  assert.ok(Math.abs(floor.residualStd - 0.004) < 5e-4, `std was ${floor.residualStd}`);
});

test('a mesh with no horizontal geometry says so instead of guessing', () => {
  const mesh = { cz: Float32Array.from([1, 2]), area: Float32Array.from([1, 1]), nz: Float32Array.from([0, 0.1]) };
  assert.throws(() => floorPlane(mesh), /no horizontal geometry/);
});

test('box corners rotate about the box centre', () => {
  const box = { xy: [10, 5], w: 2, d: 1, yaw: 90 };
  const c = corners(box);
  for (const [x, y] of c) {
    assert.ok(Math.abs(Math.hypot(x - 10, y - 5) - Math.hypot(1, 0.5)) < 1e-9);
  }
  // At 90 degrees the 2 m width lies along Y.
  const ys = c.map((p) => p[1]);
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 2) < 1e-9);
});

test('a point maps into the box frame and back', () => {
  const box = { xy: [-3, 7], w: 2, d: 1, yaw: 37 };
  const [u, v] = toLocal(box, -3, 7);
  assert.ok(Math.abs(u) < 1e-12 && Math.abs(v) < 1e-12, 'the centre is the origin of its own frame');
  const corner = corners(box)[2];
  const [cu, cv] = toLocal(box, corner[0], corner[1]);
  assert.ok(Math.abs(cu - 1) < 1e-9 && Math.abs(cv - 0.5) < 1e-9);
});

/** Distance from a world point to the nearest corner of a box. */
const missBy = (box, p) =>
  Math.min(...corners(box).map(([x, y]) => Math.hypot(x - p[0], y - p[1])));

test('resizing keeps the pinned corner exactly where it is', () => {
  // Without this the box walks off the object as it is resized.
  const box = { xy: [0, 0], w: 2, d: 2, yaw: 0 };
  const pin = corners(box)[2];               // (1, 1)
  const out = resizeFromCorner(box, pin, -3, -4);
  assert.ok(missBy(out, pin) < 1e-9, 'the pinned corner moved');
  assert.ok(Math.abs(out.w - 4) < 1e-9 && Math.abs(out.d - 5) < 1e-9);
});

test('resizing works on a rotated box too', () => {
  const box = { xy: [1, 2], w: 2, d: 1, yaw: 45 };
  const pin = corners(box)[1];
  const out = resizeFromCorner(box, pin, 5, 5);
  assert.ok(missBy(out, pin) < 1e-9);
  assert.equal(out.yaw, 45, 'resizing must not rotate the box');
});

test('dragging through the pin flips the box instead of collapsing it', () => {
  // The bug this replaced: with the pin re-derived from the box each frame,
  // dragging past it made the "opposite corner" the point under the cursor, so
  // width and depth went to the minimum and the box vanished. Held fixed, the
  // same drag is just a flip -- and dragging further keeps growing it.
  const start = { xy: [0, 0], w: 2, d: 2, yaw: 30 };
  const pin = corners(start)[2];
  const dragged = corners(start)[0];
  // A cursor path that starts on one side of the pin and ends well past it.
  // Deliberately never exactly on the pin: there both sides are legitimately
  // zero and the 5 cm minimum-size clamp takes over, which is a different case.
  const path = [dragged, [0, 0], [1.2, 2.2], [3, 4], [5, 6]];
  assert.ok(
    Math.sign(path[0][0] - pin[0]) !== Math.sign(path.at(-1)[0] - pin[0]),
    'the test path must actually cross the pin, or it proves nothing'
  );

  let box = start;
  const sizes = [];
  for (const [x, y] of path) {
    box = resizeFromCorner(box, pin, x, y);   // same pin for the whole drag
    sizes.push([+box.w.toFixed(4), +box.d.toFixed(4)]);
    assert.ok(missBy(box, pin) < 1e-9, `pin moved at cursor ${x},${y}`);
    assert.equal(box.yaw, 30, 'a resize must never rotate the box');
  }
  sizes.forEach(([w, d], i) => {
    assert.ok(w > 0.05 && d > 0.05,
      `step ${i} collapsed to the minimum instead of flipping: ${w} x ${d}`);
  });
  const area = ([w, d]) => w * d;
  assert.ok(area(sizes.at(-1)) > area(sizes[0]),
    `dragging past the pin and onward must grow the box, got ${JSON.stringify(sizes)}`);
});

/* ------------------------------------------------------- clicking in 3D */

/** A unit box on a floor at z = 0, centred on the origin. */
const unit = { xy: [0, 0], w: 1, d: 1, h: 1, yaw: 0 };

test('a ray down the middle enters the box at its padded face', () => {
  // Aimed along +Y from five metres out, at half height. The near face is at
  // y = -0.5, and the pad moves the surface the click may land on to -0.56.
  const t = rayBox(unit, [0, -5, 0.5], [0, 1, 0], 0);
  assert.ok(Math.abs(t - (5 - 0.5 - PICK.PAD_M)) < 1e-9, `entered at ${t}`);
});

test('a ray that goes past the box misses it', () => {
  assert.equal(rayBox(unit, [3, -5, 0.5], [0, 1, 0], 0), null);
  // Over the top, too: the volume ends at the box height plus the pad.
  assert.equal(rayBox(unit, [0, -5, 1.5], [0, 1, 0], 0), null);
});

test('the pad is what makes a wireframe box clickable', () => {
  // 3 cm outside the drawn side: a miss on the geometry, a hit on the thing a
  // person was aiming at.
  const at = (x) => rayBox(unit, [x, -5, 0.5], [0, 1, 0], 0);
  assert.equal(at(0.53) !== null, true, 'a click just outside the face must select it');
  assert.equal(at(0.5 + PICK.PAD_M + 0.01), null, 'and one clearly outside must not');
});

test('the box is tested in its own frame, not an axis-aligned one', () => {
  const flat = { xy: [0, 0], w: 2, d: 0.2, h: 1, yaw: 0 };   // two metres along X
  const turned = { ...flat, yaw: 90 };                       // the same, along Y
  // A ray along +X, half a metre off the centre line: past the end of the flat
  // box's 10 cm depth, and squarely through the middle of the turned one.
  assert.equal(rayBox(flat, [-5, 0.5, 0.5], [1, 0, 0], 0), null);
  assert.ok(rayBox(turned, [-5, 0.5, 0.5], [1, 0, 0], 0) !== null);
});

test('the box stands on the floor it was given, not on zero', () => {
  // The scanned rooms this was built for sit at 108 and 171 mm. A ray under the
  // raised floor must miss the box that stands on it.
  assert.equal(rayBox(unit, [0, -5, 0.05], [0, 1, 0], 0.171), null);
  assert.ok(rayBox(unit, [0, -5, 0.05 + 0.171], [0, 1, 0], 0.171) !== null);
});

test('a ray parallel to a face and outside it is a miss, not a divide by zero', () => {
  // Straight down, well off to the side: the X and Y slabs are parallel to the
  // ray and the guard has to answer from position alone.
  assert.equal(rayBox(unit, [4, 0, 3], [0, 0, -1], 0), null);
  const t = rayBox(unit, [0, 0, 3], [0, 0, -1], 0);
  assert.ok(Math.abs(t - (3 - 1 - PICK.PAD_M)) < 1e-9, `landed on the top at ${t}`);
});

test('the nearer of two boxes is the one picked', () => {
  const near = { ...unit, xy: [0, 0] };
  const far = { ...unit, xy: [0, 6] };
  assert.equal(pickBox([far, near], [0, -5, 0.5], [0, 1, 0], 0), 1);
  assert.equal(pickBox([near, far], [0, -5, 0.5], [0, 1, 0], 0), 0);
});

test('among boxes at the same depth the smaller one wins', () => {
  // A tray on a counter: the tray is inside the counter's volume, so depth alone
  // would make the tray unselectable for good.
  const counter = { xy: [0, 0], w: 2, d: 1, h: 0.9, yaw: 0 };
  const tray = { xy: [0, -0.3], w: 0.4, d: 0.3, h: 0.1, yaw: 0 };
  assert.equal(pickBox([counter, tray], [0, -5, 0.05], [0, 1, 0], 0), 1);
});

test('a box further back than the coincidence window does not steal the click', () => {
  const front = { xy: [0, 0], w: 2, d: 1, h: 1, yaw: 0 };
  // Small, and beyond COINCIDENT_M behind the front box's entry face.
  const behind = { xy: [0, 2], w: 0.2, d: 0.2, h: 1, yaw: 0 };
  assert.equal(pickBox([front, behind], [0, -5, 0.5], [0, 1, 0], 0), 0);
});

test('empty slots are skipped so the array can be indexed like the object list', () => {
  const boxes = [null, undefined, { xy: null }, unit];
  assert.equal(pickBox(boxes, [0, -5, 0.5], [0, 1, 0], 0), 3);
  assert.equal(pickBox([null, { xy: null }], [0, -5, 0.5], [0, 1, 0], 0), -1);
  assert.equal(pickBox([], [0, -5, 0.5], [0, 1, 0], 0), -1);
});

test('a click on the floor plane lands where the ray crosses it', () => {
  const p = rayPlaneZ([0, 0, 2], [0, 1, -1], 0.5);
  assert.ok(Math.abs(p[0]) < 1e-12 && Math.abs(p[1] - 1.5) < 1e-12, `landed at ${p}`);
  // The floor is where the annotation sits, not where the world happens to be flat.
  const raised = rayPlaneZ([0, 0, 2], [0, 1, -1], 0.171);
  assert.ok(Math.abs(raised[1] - 1.829) < 1e-12);
});

test('a ray that never reaches the floor plane says so', () => {
  assert.equal(rayPlaneZ([0, 0, 2], [0, 1, 0], 0), null, 'parallel to the plane');
  assert.equal(rayPlaneZ([0, 0, 2], [0, 1, 0.5], 0), null, 'looking up, away from it');
  assert.equal(rayPlaneZ([0, 0, 2], [0, 1, -1], 2), null, 'the plane is at the eye');
});

test('a height drag reads the closest approach to the box axis', () => {
  // Worked by hand: the ray from (0, 0, 2) along (0, 1, -0.5) is nearest the
  // vertical axis through (0, 2) where it passes over that point, at z = 1.
  const t = axisHeight([0, 0, 2], [0, 1, -0.5], 0, 2, 0);
  assert.ok(Math.abs(t - 1) < 1e-12, `closest approach came back at ${t}`);
  // And the answer is measured from the floor, not from world zero.
  assert.ok(Math.abs(axisHeight([0, 0, 2], [0, 1, -0.5], 0, 2, 0.3) - 0.7) < 1e-12);
});

test('a ray along the axis has no one height, and says null rather than a number', () => {
  assert.equal(axisHeight([0, 0, 3], [0, 0, -1], 0, 0, 0), null);
  assert.equal(axisHeight([1, 1, 3], [0, 0, 1], 0, 0, 0), null, 'off the axis but still vertical');
});

test('a yaw is reduced to the half turn that names the same rectangle', () => {
  assert.equal(normYaw180(0), 0);
  assert.equal(normYaw180(45), 45);
  assert.equal(normYaw180(-45), -45);
  assert.equal(normYaw180(89), 89);
  assert.equal(normYaw180(180), 0);
  assert.equal(normYaw180(-180), 0);
  assert.equal(normYaw180(135), -45);
  // The one arbitrary choice, pinned here: a box turned a quarter turn either
  // way is the same box, and this is the end of the interval it is reported at.
  assert.equal(normYaw180(90), -90);
  assert.equal(normYaw180(-90), -90);
  assert.equal(normYaw180(270), -90);
});

test('every yaw lands inside the slider, and names the same rectangle it started as', () => {
  for (let deg = -720; deg <= 720; deg += 3.5) {
    const out = normYaw180(deg);
    assert.ok(out >= -90 && out < 90, `${deg} came back as ${out}, off the slider`);
    const turns = (deg - out) / 180;
    assert.ok(Math.abs(turns - Math.round(turns)) < 1e-9,
      `${deg} -> ${out} is not a whole number of half turns`);
  }
});

test('a corner drag in 3D stops short of the size a typed number may still ask for', () => {
  // Two floors on purpose: a pixel is millimetres in the top-down view and
  // centimetres at arm's length in 3D.
  const box = { xy: [0, 0], w: 1, d: 1, yaw: 0 };
  const pin = corners(box)[2];
  const tiny = resizeFromCorner(box, pin, pin[0], pin[1], HANDLE.MIN_SIDE_M);
  assert.equal(tiny.w, HANDLE.MIN_SIDE_M);
  assert.equal(resizeFromCorner(box, pin, pin[0], pin[1]).w, 0.05, 'the default floor is unchanged');
});

test('path length is the polyline, and is zero for fewer than two points', () => {
  assert.equal(pathLength([]), 0);
  assert.equal(pathLength([[1, 1]]), 0);
  assert.ok(Math.abs(pathLength([[0, 0], [3, 4], [3, 9]]) - 10) < 1e-12);
});

test('the top-down mapping round-trips, and is not mirrored', () => {
  const { toPx, toWorld } = topDownMapping({ centre: [2, -1], metresPerPixel: 0.0025, pixels: 2048 });
  const [px, py] = toPx(2.5, -0.4);
  const [x, y] = toWorld(px, py);
  assert.ok(Math.abs(x - 2.5) < 1e-9 && Math.abs(y + 0.4) < 1e-9);
  // The direction of each axis, stated rather than assumed. A mirrored plate
  // produces annotations that look entirely reasonable and are wrong.
  assert.ok(toPx(3, -1)[0] > toPx(1, -1)[0], 'more x must be further right');
  assert.ok(toPx(2, 0)[1] < toPx(2, -2)[1], 'more y must be further UP, i.e. lower row');
  assert.deepEqual(toPx(2, -1), [1024, 1024], 'the centre lands in the middle');
});
