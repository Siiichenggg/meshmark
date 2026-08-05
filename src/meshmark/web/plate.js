/* The orthographic top-down plate, rendered from the mesh in the browser.
 *
 * The plate is the view where a position can be *measured*: an exact
 * world-to-pixel mapping, no perspective to argue with, a millimetres-per-pixel
 * figure printed under it. The 3D view is where an object can be *identified*,
 * which the plate frequently cannot do -- a trash can and a stack of folded
 * linen look much the same from directly above.
 *
 * The earlier version of this tool got its plate from a Blender script run
 * ahead of time, which made "annotate a mesh" mean "install Blender, run our
 * render script, keep a meta.json in step with it". Rendering it here from the
 * mesh already loaded costs one frame and removes all of that -- and gains
 * something the offline plate could not do: the plate re-renders when the
 * ceiling cut moves, so sliding the cut down reveals the floor beneath it.
 *
 * Orientation is the hazard. A flipped axis here produces annotations that look
 * entirely reasonable and are mirrored, which no screenshot review catches. So
 * `verifyMapping` renders a probe at a known asymmetric position and checks it
 * lands where the mapping says; the page runs it once at startup.
 */

import * as THREE from 'three';

/** World-space bounds of everything under `root`. */
export function bounds(root) {
  return new THREE.Box3().setFromObject(root);
}

/**
 * Per-triangle centroid height, area and normal z, in world space.
 * Written with raw arithmetic rather than Vector3s: a photogrammetry shell is
 * a few hundred thousand triangles and three allocations per triangle is felt.
 */
export function collectTriangles(meshes) {
  let total = 0;
  for (const m of meshes) {
    const g = m.geometry;
    if (!g || !g.attributes.position) continue;
    total += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }
  const cz = new Float32Array(total);
  const area = new Float32Array(total);
  const nz = new Float32Array(total);

  let k = 0;
  for (const m of meshes) {
    const g = m.geometry;
    if (!g || !g.attributes.position) continue;
    m.updateWorldMatrix(true, false);
    const e = m.matrixWorld.elements;
    const pos = g.attributes.position;
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    const xs = new Float64Array(3), ys = new Float64Array(3), zs = new Float64Array(3);
    for (let i = 0; i + 2 < n; i += 3) {
      for (let c = 0; c < 3; c++) {
        const v = idx ? idx.getX(i + c) : i + c;
        const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
        xs[c] = e[0] * x + e[4] * y + e[8] * z + e[12];
        ys[c] = e[1] * x + e[5] * y + e[9] * z + e[13];
        zs[c] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
      const ax = xs[1] - xs[0], ay = ys[1] - ys[0], az = zs[1] - zs[0];
      const bx = xs[2] - xs[0], by = ys[2] - ys[0], bz = zs[2] - zs[0];
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nzz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nzz);
      cz[k] = (zs[0] + zs[1] + zs[2]) / 3;
      area[k] = len / 2;
      nz[k] = len > 1e-12 ? nzz / len : 0;
      k++;
    }
  }
  return { cz: cz.subarray(0, k), area: area.subarray(0, k), nz: nz.subarray(0, k) };
}

/**
 * Render `scene` from directly above into a canvas, plus the mapping to use it.
 *
 * @returns {{canvas: HTMLCanvasElement, centre: number[], metresPerPixel: number,
 *            pixels: number, span: number}}
 */
export function renderPlate(renderer, scene, { box, pixels, margin = 0.04 }) {
  const size = new THREE.Vector3();
  box.getSize(size);
  const centreV = new THREE.Vector3();
  box.getCenter(centreV);
  // Square, so one number describes the scale in both directions and the
  // world-to-pixel mapping stays a single multiply.
  const span = Math.max(size.x, size.y) * (1 + margin * 2);
  const px = Math.min(pixels, renderer.capabilities.maxTextureSize);

  const cam = new THREE.OrthographicCamera(-span / 2, span / 2, span / 2, -span / 2, 0.01, 1e6);
  // Explicitly Y-up for this camera even though the app orbits Z-up: the plate's
  // mapping assumes screen-right is +X and screen-up is +Y, and that is what a
  // camera looking down -Z with up = +Y gives.
  cam.up.set(0, 1, 0);
  cam.position.set(centreV.x, centreV.y, box.max.z + 1);
  cam.lookAt(centreV.x, centreV.y, box.min.z);
  cam.updateProjectionMatrix();

  const target = new THREE.WebGLRenderTarget(px, px, {
    colorSpace: THREE.SRGBColorSpace,
    depthBuffer: true,
  });
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, cam);
  const buffer = new Uint8Array(px * px * 4);
  renderer.readRenderTargetPixels(target, 0, 0, px, px, buffer);
  renderer.setRenderTarget(previous);
  target.dispose();

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  const image = canvas.getContext('2d').createImageData(px, px);
  // WebGL hands back rows bottom-up; a canvas is top-down. Row 0 of the canvas
  // has to be the top of the image, which is world +Y maximum.
  const stride = px * 4;
  for (let row = 0; row < px; row++) {
    image.data.set(buffer.subarray((px - 1 - row) * stride, (px - row) * stride), row * stride);
  }
  canvas.getContext('2d').putImageData(image, 0, 0);

  return {
    canvas,
    centre: [centreV.x, centreV.y],
    metresPerPixel: span / px,
    pixels: px,
    span,
  };
}

/**
 * Check the plate's world-to-pixel mapping against a probe, not against belief.
 *
 * Renders a small bright marker at a deliberately asymmetric world position and
 * reports where its pixels actually landed versus where the mapping predicts. A
 * mirrored axis passes every visual review and fails this.
 */
export function verifyMapping(renderer, plate, probeXY, z) {
  const probe = new THREE.Mesh(
    new THREE.BoxGeometry(plate.span / 40, plate.span / 40, 0.01),
    new THREE.MeshBasicMaterial({ color: 0xff00ff })
  );
  probe.position.set(probeXY[0], probeXY[1], z);
  const probeScene = new THREE.Scene();
  probeScene.background = new THREE.Color(0x000000);
  probeScene.add(probe);

  const box = new THREE.Box3(
    new THREE.Vector3(plate.centre[0] - plate.span / 2, plate.centre[1] - plate.span / 2, z - 1),
    new THREE.Vector3(plate.centre[0] + plate.span / 2, plate.centre[1] + plate.span / 2, z + 1)
  );
  // Same margin arithmetic as the real plate, or the probe is measured against a
  // different span than the one being checked.
  const shot = renderPlate(renderer, probeScene, { box, pixels: plate.pixels, margin: 0 });
  probe.geometry.dispose();
  probe.material.dispose();

  const data = shot.canvas.getContext('2d').getImageData(0, 0, shot.pixels, shot.pixels).data;
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 128 && data[i + 2] > 128 && data[i + 1] < 128) {
      const p = i / 4;
      sx += p % shot.pixels;
      sy += Math.floor(p / shot.pixels);
      n++;
    }
  }
  const expected = [
    (probeXY[0] - shot.centre[0]) / shot.metresPerPixel + shot.pixels / 2,
    shot.pixels / 2 - (probeXY[1] - shot.centre[1]) / shot.metresPerPixel,
  ];
  if (!n) return { ok: false, reason: 'probe not visible in the plate', expected };
  const found = [sx / n, sy / n];
  const errorPx = Math.hypot(found[0] - expected[0], found[1] - expected[1]);
  return {
    ok: errorPx < 2,
    found,
    expected,
    errorPx,
    errorM: errorPx * shot.metresPerPixel,
    probePixels: n,
  };
}
