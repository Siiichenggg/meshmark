import test from 'node:test';
import assert from 'node:assert/strict';

import {
  floorPlane, corners, toLocal, resizeFromCorner, pathLength, topDownMapping,
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
