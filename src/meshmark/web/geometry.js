/* Geometry with no three.js in it, so it can be tested outside a browser.
 *
 * Everything here takes plain arrays and returns plain values. That is the whole
 * point: the floor-finding below decides where every annotation sits vertically,
 * and "we looked at it in the browser and it seemed fine" is not a check.
 */

/* What a click in the 3D view is allowed to hit.
 *
 * A box drawn on a scanned object rarely encloses it exactly, and an annotation
 * box is a wireframe: aiming at one is aiming at a line. Both numbers exist so
 * that a click near a box counts as a click on it. */
export const PICK = {
  PAD_M: 0.06,        // every box is grown by this before the ray test
  COINCIDENT_M: 0.8,  // hits within this of the nearest one count as the same depth
};

/* The 3D drag handles: how they are hit, how far they sit from the box, and how
 * far a drag may take a box. Kept here beside the functions the drags use, so
 * the drawn handle and the region that grabs it cannot drift apart. */
export const HANDLE = {
  GRAB_PX: 16,        // pointer-to-handle screen distance that counts as a grab
  DRAW_PX: 18,        // drawn size, deliberately under twice GRAB_PX: a handle
                      // must never be harder to hit than it looks
  LIFT_M: 0.02,       // floor handles ride this far up, clear of the floor itself
  ROTATE_OUT_M: 0.32, // how far past the box's half-width the rotate handle sits
  // A drag is a coarse instrument -- a pixel is centimetres at arm's length --
  // so it stops well short of the 5 cm a typed number may still ask for.
  MIN_SIDE_M: 0.08,
  HEIGHT_MIN_M: 0.05,
  HEIGHT_MAX_M: 6.0,
};

/* Smallest a box may be made by dragging a corner in the top-down view, where a
 * pixel is millimetres and a genuinely small object can be traced. */
export const BOX = { MIN_SIDE_M: 0.05 };

/* Floor search. A scanned room rarely sits at z = 0 -- the two this was
 * developed against are at 108 mm and 171 mm -- and every height in the tool is
 * measured from the floor, so getting this wrong shifts the cut height, the box
 * bases and the route markers together, by an amount that looks plausible. */
export const FLOOR = {
  HORIZONTAL_NZ: 0.94,   // |normal.z| above this counts as horizontal
  SEARCH_HEIGHT_M: 1.0,  // how far above the lowest geometry to look
  BIN_M: 0.01,           // 1 cm resolves a floor from a cabinet's kick plate
  GATHER_M: 0.05,        // half-thickness of the slab collected around the peak
};

/**
 * Height of the floor, as the largest horizontal slab in the lowest metre.
 *
 * @param {{cz: ArrayLike<number>, area: ArrayLike<number>, nz: ArrayLike<number>}} tris
 *   per-triangle centroid height, area and normal z, in world space.
 * @returns {{z: number, residualStd: number, area: number, triangles: number}}
 */
export function floorPlane(tris) {
  const { cz, area, nz } = tris;
  const n = cz.length;
  if (!n) throw new Error('floorPlane: no triangles');

  let base = Infinity;
  let horizontal = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(nz[i]) > FLOOR.HORIZONTAL_NZ) horizontal++;
    if (cz[i] < base) base = cz[i];
  }
  if (!horizontal) throw new Error('floorPlane: no horizontal geometry at all');

  const bins = Math.max(1, Math.round(FLOOR.SEARCH_HEIGHT_M / FLOOR.BIN_M));
  const hist = new Float64Array(bins);
  let searched = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(nz[i]) <= FLOOR.HORIZONTAL_NZ) continue;
    const d = cz[i] - base;
    if (d < 0 || d >= FLOOR.SEARCH_HEIGHT_M) continue;
    // Weighted by area, not counted. Photogrammetry meshes are wildly
    // non-uniform in vertex density, so counting triangles near a height
    // measures reconstruction detail, not how much floor is there.
    hist[Math.min(bins - 1, Math.floor(d / FLOOR.BIN_M))] += area[i];
    searched++;
  }
  if (!searched) {
    throw new Error(
      `floorPlane: no horizontal geometry within ${FLOOR.SEARCH_HEIGHT_M} m of the bottom`
    );
  }

  let peakBin = 0;
  for (let b = 1; b < bins; b++) if (hist[b] > hist[peakBin]) peakBin = b;
  const peak = base + (peakBin + 0.5) * FLOOR.BIN_M;

  let wsum = 0, zsum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(nz[i]) <= FLOOR.HORIZONTAL_NZ) continue;
    if (Math.abs(cz[i] - peak) > FLOOR.GATHER_M) continue;
    wsum += area[i]; zsum += area[i] * cz[i]; count++;
  }
  const mean = zsum / wsum;
  let var_ = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(nz[i]) <= FLOOR.HORIZONTAL_NZ) continue;
    if (Math.abs(cz[i] - peak) > FLOOR.GATHER_M) continue;
    var_ += area[i] * (cz[i] - mean) ** 2;
  }
  // Flatness is reported because it decides a downstream question: a floor
  // planar to millimetres may be replaced by a fitted plane, one planar to
  // centimetres may not.
  return { z: mean, residualStd: Math.sqrt(var_ / wsum), area: wsum, triangles: count };
}

/** The four corners of an oriented box, in world XY, starting bottom-left. */
export function corners(box) {
  const r = ((box.yaw || 0) * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const hw = box.w / 2, hd = box.d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => [
    box.xy[0] + u * c - v * s,
    box.xy[1] + u * s + v * c,
  ]);
}

/** A world point expressed in a box's own rotated frame. */
export function toLocal(box, x, y) {
  const r = (-(box.yaw || 0) * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const dx = x - box.xy[0], dy = y - box.xy[1];
  return [dx * c - dy * s, dx * s + dy * c];
}

/**
 * Resize a box by dragging one corner, keeping `pin` -- a world point, normally
 * the opposite corner -- exactly where it is.
 *
 * The pin is a position and not a corner index, which matters more than it
 * looks. Re-deriving "the opposite corner" from the box on every mouse move is
 * only correct while the drag stays on one side of it: drag past it and the box
 * flips, the opposite corner is no longer at that index, and the next event
 * measures the box against the point being dragged. Width and depth collapse to
 * the minimum and the box vanishes under the cursor. Capturing the pin once, at
 * mousedown, makes the result a function of (pin, cursor, yaw) alone, so a drag
 * through the pin flips the box and keeps going.
 *
 * `min` is a parameter because the two views resize at different resolutions:
 * see BOX.MIN_SIDE_M and HANDLE.MIN_SIDE_M.
 */
export function resizeFromCorner(box, pin, x, y, min = BOX.MIN_SIDE_M) {
  const [lu, lv] = toLocal(box, x, y);
  const [ou, ov] = toLocal(box, pin[0], pin[1]);
  const w = Math.max(min, Math.abs(lu - ou));
  const d = Math.max(min, Math.abs(lv - ov));
  const mu = (lu + ou) / 2, mv = (lv + ov) / 2;
  const r = ((box.yaw || 0) * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return {
    ...box,
    w, d,
    xy: [box.xy[0] + mu * c - mv * s, box.xy[1] + mu * s + mv * c],
  };
}

/**
 * Where a ray enters an oriented box standing on the floor, or null for a miss.
 *
 * A slab test in the box's own frame. The three tests it replaced each failed on
 * a real object: hit-testing the projected centre made a two-metre counter
 * unselectable anywhere but its middle; hit-testing the footprint on the floor
 * plane missed anything tall, because from a standing viewpoint the ray through
 * a monitor lands on the floor well behind its base; hit-testing the drawn
 * wireframe asked the user to click a line.
 *
 * `dir` need not be normalised, but the returned distance is in its units --
 * pass a normalised direction (three's Raycaster does) to get metres.
 *
 * Height comes from the caller: a box with none is a footprint, which `pad`
 * still gives enough of a volume to be clicked on.
 */
export function rayBox(box, origin, dir, floorZ, pad = PICK.PAD_M) {
  const r = (-(box.yaw || 0) * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const ox = origin[0] - box.xy[0], oy = origin[1] - box.xy[1];
  const lo = [ox * c - oy * s, ox * s + oy * c, origin[2] - floorZ];
  const ld = [dir[0] * c - dir[1] * s, dir[0] * s + dir[1] * c, dir[2]];
  const mn = [-box.w / 2 - pad, -box.d / 2 - pad, 0];
  const mx = [box.w / 2 + pad, box.d / 2 + pad, (box.h || 0) + pad];

  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    // Parallel to this pair of planes: no slab to enter, so the only question is
    // whether the ray is already between them.
    if (Math.abs(ld[i]) < 1e-9) {
      if (lo[i] < mn[i] || lo[i] > mx[i]) return null;
      continue;
    }
    let a = (mn[i] - lo[i]) / ld[i], b = (mx[i] - lo[i]) / ld[i];
    if (a > b) { const swap = a; a = b; b = swap; }
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0;
}

/**
 * Index of the box a ray selects, or -1. Empty slots are skipped, so the array
 * can be indexed the same way as the object list it came from.
 */
export function pickBox(boxes, origin, dir, floorZ) {
  const hits = [];
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!b || !b.xy) continue;
    const t0 = rayBox(b, origin, dir, floorZ);
    if (t0 !== null) hits.push({ i, t0, area: b.w * b.d });
  }
  if (!hits.length) return -1;
  hits.sort((a, b) => a.t0 - b.t0);
  // Front-most wins, except between hits at effectively the same depth, where
  // the smaller footprint does. An instrument tray sits inside the volume of the
  // counter it stands on, and depth alone would make the counter the only thing
  // on that side of the room anybody could select.
  const near = hits.filter((h) => h.t0 < hits[0].t0 + PICK.COINCIDENT_M);
  near.sort((a, b) => a.area - b.area);
  return near[0].i;
}

/**
 * Where a ray crosses the horizontal plane at height `z`, as [x, y], or null.
 *
 * Null covers both ways this has no answer: a ray along the plane, and a plane
 * behind the viewer -- looking up above the horizon, the floor is behind you,
 * and the algebra happily returns a point kilometres away in the wrong
 * direction.
 */
export function rayPlaneZ(origin, dir, z) {
  if (Math.abs(dir[2]) < 1e-9) return null;
  const t = (z - origin[2]) / dir[2];
  if (t <= 0) return null;
  return [origin[0] + t * dir[0], origin[1] + t * dir[1]];
}

/**
 * Height above `floorZ` of the point on a box's vertical axis nearest the ray.
 *
 * This is what makes a height drag work off the floor plane: the pointer never
 * meets the axis, so the drag reads the closest approach to it instead. Null
 * when the ray runs along the axis, where every height is equally close.
 */
export function axisHeight(origin, dir, cx, cy, floorZ) {
  const w0 = [origin[0] - cx, origin[1] - cy, origin[2] - floorZ];
  const a = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
  const b = dir[2];
  const d0 = dir[0] * w0[0] + dir[1] * w0[1] + dir[2] * w0[2];
  const den = a - b * b;
  if (den <= 1e-9) return null;
  return (a * w0[2] - b * d0) / den;
}

/**
 * A yaw reduced to the one turn of it that names the same rectangle.
 *
 * A box is symmetric under half a turn, so 200 degrees and 20 degrees are the
 * same box, and only one of them is on the panel's -90..90 slider. The interval
 * is closed at -90 and open at 90 -- both name the same rectangle, and picking
 * one keeps a dragged yaw and a typed yaw from disagreeing by 180 degrees.
 */
export function normYaw180(deg) {
  return ((deg % 180) + 270) % 180 - 90;
}

/** Total length of a polyline given as [[x, y], ...]. */
export function pathLength(waypoints) {
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    total += Math.hypot(
      waypoints[i][0] - waypoints[i - 1][0],
      waypoints[i][1] - waypoints[i - 1][1]
    );
  }
  return total;
}

/** Mapping between world metres and top-down pixels, both directions. */
export function topDownMapping({ centre, metresPerPixel, pixels }) {
  return {
    toPx: (x, y) => [
      (x - centre[0]) / metresPerPixel + pixels / 2,
      pixels / 2 - (y - centre[1]) / metresPerPixel,
    ],
    toWorld: (px, py) => [
      (px - pixels / 2) * metresPerPixel + centre[0],
      (pixels / 2 - py) * metresPerPixel + centre[1],
    ],
  };
}
