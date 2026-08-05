/* Geometry with no three.js in it, so it can be tested outside a browser.
 *
 * Everything here takes plain arrays and returns plain values. That is the whole
 * point: the floor-finding below decides where every annotation sits vertically,
 * and "we looked at it in the browser and it seemed fine" is not a check.
 */

/* Floor search, ported from the measurement code this tool grew out of.
 * A scan's floor is found, never assumed. The two rooms it was built on sit at
 * 108 mm and 171 mm, both loaded at the origin, so an absolute cut that clears
 * one slices into the other -- and the resulting error reads as "that object is
 * oddly short" rather than as a bug. */
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
 */
export function resizeFromCorner(box, pin, x, y) {
  const [lu, lv] = toLocal(box, x, y);
  const [ou, ov] = toLocal(box, pin[0], pin[1]);
  const w = Math.max(0.05, Math.abs(lu - ou));
  const d = Math.max(0.05, Math.abs(lv - ov));
  const mu = (lu + ou) / 2, mv = (lv + ov) / 2;
  const r = ((box.yaw || 0) * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return {
    ...box,
    w, d,
    xy: [box.xy[0] + mu * c - mv * s, box.xy[1] + mu * s + mv * c],
  };
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

/** Mapping between world metres and plate pixels, both directions. */
export function plateMapping({ centre, metresPerPixel, pixels }) {
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
