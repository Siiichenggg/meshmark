/* meshmark -- the annotator itself.
 *
 * Two linked views, because neither alone is enough. The orthographic top-down view is
 * where a position can be measured; the 3D view is where an object can be
 * identified. Both write the same annotation: click the mesh in 3D to place,
 * then nudge on the top-down view with the arrow keys at centimetre resolution.
 *
 * Coordinates are never converted. The mesh is loaded in whatever frame it was
 * authored in and every number written out is in that frame, so annotations are
 * usable by whatever produced the mesh without a transform anybody has to
 * remember. The top-down view's mapping is checked against a probe at startup rather
 * than assumed -- see topdown.js.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

import { translator, LANGS } from './i18n.js';
import * as store from './store.js';
import * as G from './geometry.js';
import { bounds, collectTriangles, renderTopDown, verifyMapping } from './topdown.js';

const $ = (id) => document.getElementById(id);
const SPEC = await (await fetch('./spec.json')).json();

/* ----------------------------------------------------------------- palette
 *
 * The stylesheet is where a colour is decided, including the colours drawn into
 * the two canvases -- which CSS cannot reach on its own. Reading them back out
 * of the computed style is the whole of the bridge: a hex literal here would be
 * a second home for the same decision, and the two would agree right up until
 * the theme changed under one of them.
 *
 * Read rather than cached at boot, because the theme can change while the page
 * is open -- the OS switches at sunset and the canvases are the only part of
 * the page that would not have noticed.
 */
const PALETTE_KEYS = ['floor', 'ink', 'muted', 'gt', 'est', 'bad', 'cam', 'marker'];
// Seeded with a colour that belongs to no theme: a variable that fails to
// resolve then draws visibly grey instead of handing "rgba(NaN…)" to a canvas.
const PAL = Object.fromEntries(PALETTE_KEYS.map((k) => [k, '#808080']));

function palette() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of PALETTE_KEYS) {
    const v = cs.getPropertyValue(`--${k}`).trim();
    if (v) PAL[k] = v;
  }
  return PAL;
}

/** The same colour, faded: how everything that is not the current object draws. */
function fade(colour, a) {
  const n = parseInt(String(colour).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ---------------------------------------------------------------- language */

let lang = localStorage.getItem(`${store.PREFIX}:lang`) || SPEC.lang || 'en';
if (!LANGS.includes(lang)) lang = 'en';
let t = translator(lang);

function applyStaticStrings() {
  document.documentElement.lang = lang;
  document.title = `meshmark · ${SPEC.scene}`;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }
  $('langbtn').textContent = t('lang.other');
  // Glyphs rather than words: there is nothing in them to translate, and text
  // written into the markup is text no language switch can reach.
  $('helpbtn').textContent = '?';
  $('helpbtn').title = t('help.title');
  $('helpclose').textContent = '×';
  $('helpclose').setAttribute('aria-label', t('help.title'));
  $('note').placeholder = t('obj.note');
}

function setLanguage(next) {
  lang = next;
  t = translator(lang);
  localStorage.setItem(`${store.PREFIX}:lang`, lang);
  applyStaticStrings();
  fillClassSelect();
  redraw();
}

/* ----------------------------------------------------------------- classes */

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const CLASSES = SPEC.classes.classes.map((c) => ({ ...c }));
const byId = new Map(CLASSES.map((c) => [c.id, c]));
const byAlias = new Map();
for (const c of CLASSES) {
  // Aliases let a preset claim the other names real reference files use --
  // "operating bed" for an operating table, "patient monitor" for a monitor --
  // instead of each spelling becoming a class of its own.
  for (const key of [c.id, slug(c.en), c.zh, ...(c.aliases || []).flatMap((a) => [a, slug(a)])]) {
    if (key) byAlias.set(key, c);
  }
}

/** The class a free-text label from a reference file refers to, if any. */
function classFor(label) {
  const c = byAlias.get(slug(label)) || byAlias.get(String(label));
  return c ? c.id : null;
}

/** Adopt a label the preset does not cover, rather than silently retyping it. */
function adoptClass(label) {
  const id = slug(label) || 'other';
  if (byId.has(id)) return id;
  const c = { id, en: String(label), zh: String(label), size_m: [0.5, 0.5, 0.9], adopted: true };
  CLASSES.push(c);
  byId.set(id, c);
  byAlias.set(id, c);
  return id;
}

/** Both languages, current one first: what makes the list readable to either reader. */
function clsLabel(id) {
  const c = byId.get(id);
  if (!c) return id;
  const other = lang === 'zh' ? c.en : c.zh;
  const primary = c[lang];
  return primary === other ? primary : `${primary} · ${other}`;
}
function clsSize(id) {
  const c = byId.get(id);
  return c ? c.size_m : [0.5, 0.5, 0.9];
}

/* ------------------------------------------------------------------- state */

const keys = store.keysFor(SPEC.scene, SPEC.baseline);
const targets = SPEC.targets.map((tg) => ({
  object_id: tg.object_id,
  cls: classFor(tg.label) || adoptClass(tg.label),
  reference_xy: tg.xy,
  radius_m: tg.radius_m,
  kind: 'reference',
  extra: tg.extra || {},
}));

const session = store.loadSession(localStorage, keys);
let ann = session.ann;
let extra = session.extra;
const routeState = store.loadRoutes(localStorage, keys);
let routes = routeState.routes;
let activeRoute = 0;

let cur = 0;
let addMode = false;
let pathMode = false;
// Draw and hit-test the current object alone. A room's worth of boxes overlaps
// in a 3D view from any angle a person can stand at, and the one being edited is
// the one that has to be legible.
let focusCur = localStorage.getItem(keys.focus) === '1';
let filter = 'all';
let floorZ = SPEC.floor_z_m;
let topDown = null;
let topDownCutHeight = SPEC.top_down.cut_height_m;

const OBJ = () => targets.concat(extra);
const current = () => OBJ()[cur];
const A = () => ann[current()?.object_id];
const classOf = (o) => (ann[o.object_id] || {}).cls || o.cls;

/* The box an annotation describes, as plain numbers for geometry.js. Height is
   defaulted here and nowhere else downstream, so a box drawn 0.9 m tall is the
   same box the picker and the handles measure. */
const boxOf = (a) => ({ xy: a.xy, w: a.w, d: a.d, h: a.h || 0.9, yaw: a.yaw || 0 });

/* Indices the current filter shows. Everything that walks the list -- the
   sidebar, Enter, the arrows -- walks this, so during a bulk add pass "next"
   means the next object you added, not the next reference target. */
const visible = () =>
  OBJ().reduce((acc, o, i) => {
    if (filter === 'all' || (filter === 'added') === (o.kind === 'added')) acc.push(i);
    return acc;
  }, []);

/* -------------------------------------------------------------------- 3D */

const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.localClippingEnabled = true;
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(palette().floor);
// Up axis is taken from the mesh, not imposed: the top-down view and the annotations
// are in the mesh's own frame, and rotating it here would put every exported
// coordinate in a frame nothing downstream knows about.
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
const ambient = new THREE.AmbientLight(0xffffff, 1.0);
scene.add(ambient);

const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
const overlay = new THREE.Group();
let roomMeshes = [];
let room = null;

/* --------------------------------------------------------------- mesh load */

function loadMesh() {
  const file = SPEC.mesh.file;
  if (SPEC.mesh.format === 'obj') {
    const mtl = (SPEC.mesh.companions || []).find((c) => c.toLowerCase().endsWith('.mtl'));
    const loader = new OBJLoader();
    if (!mtl) return loader.loadAsync(`./${file}`);
    return new MTLLoader().loadAsync(`./${mtl}`).then((materials) => {
      materials.preload();
      return loader.setMaterials(materials).loadAsync(`./${file}`);
    });
  }
  return new GLTFLoader().loadAsync(`./${file}`).then((gltf) => gltf.scene);
}

$('loading').textContent = t('view.loading');

try {
  room = await loadMesh();
} catch (err) {
  $('loading').className = 'error';
  $('loading').textContent = t('view.failed', { err: err.message || err });
  throw err;
}

room.traverse((o) => {
  if (!o.isMesh) return;
  roomMeshes.push(o);
  for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
    if (!m) continue;
    m.clippingPlanes = [clipPlane];
    m.side = THREE.DoubleSide;
  }
});
if (!roomMeshes.length) {
  $('loading').className = 'error';
  $('loading').textContent = t('view.failed', { err: `${SPEC.mesh.file}: no meshes in it` });
  throw new Error('no meshes');
}

/* How the scene is lit depends on whether it already is.
 *
 * A photogrammetry scan carries its lighting baked into the texture, and adding
 * a lamp to it double-lights the room: shading laid over shading that is already
 * there. Flat ambient is right for that, and was the only mode this had.
 *
 * An untextured mesh has no lighting at all, and under flat ambient every face
 * of every object returns exactly its base colour -- a silhouette with no edges,
 * in the one view whose entire job is letting a person identify what they are
 * looking at. So a mesh that brings no shading of its own gets some. */
const litAlready = roomMeshes.some((m) =>
  (Array.isArray(m.material) ? m.material : [m.material])
    .some((x) => x && (x.map || x.vertexColors || x.emissiveMap || x.aoMap)));
if (!litAlready) {
  ambient.intensity = 0.55;
  const sky = new THREE.HemisphereLight(0xdfe8ff, 0x2b3038, 1.1);
  scene.add(sky);
  const key = new THREE.DirectionalLight(0xffffff, 1.25);
  // Off-axis and from above: straight-on light flattens exactly the vertical
  // faces whose edges tell you where an object ends.
  key.position.set(2.5, -3.5, 6.0);
  scene.add(key);
}
scene.add(room);

if (floorZ === null || floorZ === undefined) {
  const floor = G.floorPlane(collectTriangles(roomMeshes));
  floorZ = floor.z;
  window.__floor = floor;
}
clipPlane.constant = floorZ + topDownCutHeight;
$('cut').value = topDownCutHeight;
$('cutval').textContent = topDownCutHeight.toFixed(2);

$('loading').textContent = t('view.topdown');
// Give the browser a chance to paint that message before the readback below,
// which is synchronous and takes a moment on a large topDown.
//
// Raced against a timer rather than awaiting the frame alone: requestAnimationFrame
// does not fire in a hidden tab, so awaiting it means a bundle opened in a
// background tab sits on this message until the tab is looked at -- forever, as
// far as anyone watching is concerned. Rendering itself is an explicit call and
// works hidden; only the frame callback does not.
await new Promise((resolve) => {
  requestAnimationFrame(resolve);
  setTimeout(resolve, 50);
});
buildTopDown();
scene.add(overlay);
$('loading').remove();

function buildTopDown() {
  overlay.visible = false;
  topDown = renderTopDown(renderer, scene, { box: bounds(room), pixels: SPEC.top_down.pixels });
  overlay.visible = true;
  topDownCutHeight = clipPlane.constant - floorZ;
  Object.assign(topDown, G.topDownMapping({
    centre: topDown.centre, metresPerPixel: topDown.metresPerPixel, pixels: topDown.pixels,
  }));
}

/* -------------------------------------------------------------- 3D overlay */

const ROUTE_COLOURS = [0x35d0ff, 0xffa23d, 0x8f7dff, 0x3ddc84, 0xff6fae];
const routeColour = (i) => ROUTE_COLOURS[i % ROUTE_COLOURS.length];

function rebuildOverlay() {
  overlay.clear();
  // Read once per rebuild rather than held in a material: these are rebuilt on
  // every edit anyway, so a theme change is picked up by the next redraw with
  // nothing to invalidate.
  const pal = palette();
  for (const r of SPEC.markers || []) {
    const m = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.5, 4),
      new THREE.MeshBasicMaterial({ color: pal.marker, transparent: true, opacity: 0.8 })
    );
    m.rotation.x = Math.PI;
    m.position.set(r.xy[0], r.xy[1], floorZ + 0.28);
    overlay.add(m);
  }

  routes.forEach((route, ri) => {
    const colour = routeColour(ri);
    const on = ri === activeRoute;
    if (route.waypoints.length > 1) {
      for (const z of [floorZ + 0.03, floorZ + 1.2]) {
        const pts = route.waypoints.map(([x, y]) => new THREE.Vector3(x, y, z));
        overlay.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({
            color: colour, transparent: true, opacity: on ? (z > floorZ + 1 ? 0.5 : 1) : 0.25,
          })
        ));
      }
    }
    route.waypoints.forEach(([x, y], i) => {
      // A standing column, not a dot: a line on the floor is hard to judge
      // against the furniture whoever walks it has to get around.
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.09, 1.71, 16),
        new THREE.MeshBasicMaterial({
          color: i ? colour : 0x00ff88, transparent: true, opacity: on ? 0.3 : 0.12,
        })
      );
      m.rotation.x = Math.PI / 2;
      m.position.set(x, y, floorZ + 1.71 / 2);
      overlay.add(m);
    });
  });

  const showRefs = $('showrefs').checked;
  OBJ().forEach((o, i) => {
    const isCur = i === cur;
    if (focusCur && !isCur) return;
    const a = ann[o.object_id];
    if (o.reference_xy && showRefs) {
      const [gx, gy] = o.reference_xy;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(o.radius_m, isCur ? 0.012 : 0.006, 8, 64),
        new THREE.MeshBasicMaterial({
          color: pal.bad, transparent: true, opacity: isCur ? 1 : 0.35,
        })
      );
      ring.position.set(gx, gy, floorZ + 0.012);
      overlay.add(ring);
      if (isCur) {
        overlay.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(gx, gy, floorZ), new THREE.Vector3(gx, gy, floorZ + 1.2),
          ]),
          new THREE.LineBasicMaterial({ color: pal.bad })
        ));
      }
    }
    if (a && a.xy) {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(a.w, a.d, a.h || 0.9)),
        new THREE.LineBasicMaterial({
          color: pal.est, transparent: true, opacity: isCur ? 1 : 0.3,
        })
      );
      edges.position.set(a.xy[0], a.xy[1], floorZ + (a.h || 0.9) / 2);
      edges.rotation.z = ((a.yaw || 0) * Math.PI) / 180;
      overlay.add(edges);
    }
  });

  buildHandles();
}

/* ------------------------------------------------------------ 3D handles
 *
 * The box under the pointer is edited where it is, rather than by typing numbers
 * into the panel and looking up to see what happened. Four kinds of grip, one
 * per thing a box has: where it is, how big it is, which way it faces, how tall
 * it is.
 *
 * They are drawn as sprites with depth testing off. A handle is a promise that a
 * click there does something, and a handle hidden inside the very object it is
 * attached to -- which is where a correctly placed box puts all of them -- is a
 * promise the scan quietly breaks.
 */

let handles = [];
let drag3d = null;

/* Rounded where the number is written, not where it is shown. A drag otherwise
   writes 0.7300000000000001 into the export, and the panel, rounded for display,
   agrees with none of it. Millimetres for the floor plan, centimetres for height:
   a height read off a ray at arm's length does not carry a millimetre. */
const mm = (v) => Math.round(v * 1000) / 1000;
const cm = (v) => Math.round(v * 100) / 100;

function handleTexture(colour, path, hole = 0) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.translate(32, 32);
  path(g);
  // Outline first and wider, so it reads as a rim rather than covering the fill.
  // Without it a white dot on a white wall is invisible in exactly the scans
  // where placing a box is already hardest.
  //
  // The one colour on the page that does not follow the theme, and deliberately:
  // a grip is drawn over the mesh, never over the page, and what it has to stand
  // out against is whatever the scan happens to be -- which is not lighter in a
  // light theme.
  g.lineWidth = 7;
  g.strokeStyle = '#0d0f12';
  g.stroke();
  g.fillStyle = colour;
  g.fill();
  if (hole) {
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.arc(0, 0, hole, 0, 7);
    g.fill();
  }
  return new THREE.CanvasTexture(c);
}

const handleMaterial = (colour, path, hole) => new THREE.SpriteMaterial({
  map: handleTexture(colour, path, hole),
  depthTest: false, depthWrite: false, transparent: true,
});

const HANDLE_MATERIALS = {
  move: handleMaterial('#ffffff', (g) => { g.beginPath(); g.arc(0, 0, 19, 0, 7); }),
  corner: handleMaterial('#ffc83d', (g) => { g.beginPath(); g.rect(-17, -17, 34, 34); }),
  rot: handleMaterial('#35d0ff', (g) => { g.beginPath(); g.arc(0, 0, 20, 0, 7); }, 9),
  height: handleMaterial('#3ddc84', (g) => {
    g.beginPath();
    g.moveTo(0, -22); g.lineTo(22, 0); g.lineTo(0, 22); g.lineTo(-22, 0);
    g.closePath();
  }),
};

const RAIL_MATERIAL = new THREE.LineDashedMaterial({
  color: 0x3ddc84, dashSize: 0.05, gapSize: 0.04, transparent: true, opacity: 0.7,
  depthTest: false,
});

/** Where each handle sits in the world, for one annotation. */
function handlePoints(a) {
  const z = floorZ + G.HANDLE.LIFT_M;
  const [cx, cy] = a.xy;
  const out = [{ kind: 'move', at: [cx, cy, z] }];
  G.corners(a).forEach((p, i) => out.push({ kind: 'corner', i, at: [p[0], p[1], z] }));
  // Outside the box, along the direction yaw actually names, so which way the
  // grip travels and which way the box turns are the same question.
  const r = ((a.yaw || 0) * Math.PI) / 180;
  const reach = a.w / 2 + G.HANDLE.ROTATE_OUT_M;
  out.push({ kind: 'rot', at: [cx + reach * Math.cos(r), cy + reach * Math.sin(r), z] });
  out.push({ kind: 'height', at: [cx, cy, floorZ + (a.h || 0.9)] });
  return out;
}

function buildHandles() {
  handles = [];
  const a = A();
  if (!a || !a.xy) return;

  // The rail is not decoration. A height drag moves the pointer across the
  // screen and the box grows upward, and without a line saying which axis the
  // drag runs along, that reads as the tool doing something else entirely.
  const rail = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(a.xy[0], a.xy[1], floorZ),
      new THREE.Vector3(a.xy[0], a.xy[1], floorZ + (a.h || 0.9)),
    ]),
    RAIL_MATERIAL
  );
  rail.computeLineDistances();   // a dashed line without this draws solid
  rail.renderOrder = 19;
  overlay.add(rail);

  for (const p of handlePoints(a)) {
    const sprite = new THREE.Sprite(HANDLE_MATERIALS[p.kind]);
    sprite.position.set(p.at[0], p.at[1], p.at[2]);
    sprite.renderOrder = 20;
    overlay.add(sprite);
    handles.push({ ...p, sprite });
  }
}

/* Handles are sized in pixels, per frame, rather than in metres once.
 *
 * A sprite given a fixed world size is a fixed target only at one distance: back
 * off to see a whole room and the grips shrink below the radius that grabs them,
 * so the drag stops working at exactly the zoom level where someone is looking
 * for the object to drag. */
function sizeHandles() {
  if (!handles.length) return;
  const px = renderer.domElement.clientHeight || 1;
  const perPixel = (2 * Math.tan((camera.fov * Math.PI) / 360)) / px;
  for (const h of handles) {
    const s = G.HANDLE.DRAW_PX * perPixel * camera.position.distanceTo(h.sprite.position);
    h.sprite.scale.set(s, s, 1);
  }
}

function frame() {
  const o = current();
  if (!o) return;
  const a = A();
  const [x, y] = (a && a.xy) ? a.xy : (o.reference_xy || topDown.centre);
  let dx = x - topDown.centre[0], dy = y - topDown.centre[1];
  let n = Math.hypot(dx, dy);
  // A target in the middle of the room has no meaningful "towards the centre"
  // direction; back off along -Y rather than divide by ~zero.
  if (n < 0.5) { dx = 0; dy = -1; n = 1; }
  dx /= n; dy /= n;

  const look = new THREE.Vector3(x, y, floorZ + 0.45);
  const dir = new THREE.Vector3(dx, dy, 1.0).normalize();
  let dist = Math.min(3.0, topDown.span / 2);
  // Backing off blindly parks the camera inside whatever stands between the
  // target and the middle of the room. The ray starts outside the target's own
  // footprint, or the first thing it hits is the object we want to look at.
  const own = a && a.xy ? Math.hypot(a.w, a.d) / 2 : (o.radius_m || 0.3);
  const hit = new THREE.Raycaster(look, dir, own + 0.25, dist)
    .intersectObjects(roomMeshes, true)
    .find((h) => h.point.z <= clipPlane.constant);
  if (hit) dist = Math.max(1.2, hit.distance - 0.25);

  camera.position.copy(look).addScaledVector(dir, dist);
  controls.target.copy(look);
  controls.update();
}

function resize3d() {
  const w = view.clientWidth, h = view.clientHeight;
  // A container with no size yet gives aspect = 0/0 = NaN, which poisons the
  // projection matrix and leaves a blank view even after a later resize.
  if (!w || !h) return;
  // updateStyle left on, deliberately. With it off, setSize writes only the
  // drawing-buffer size -- which setPixelRatio has already multiplied by the
  // display's device pixel ratio -- and the canvas element then lays out at
  // that size in CSS pixels. On a 2x display that is a canvas twice as wide and
  // twice as tall as the box holding it, and since #view hides its overflow,
  // the visible 3D view is the top-left QUARTER of the render. It looks like a
  // badly framed camera, not like a bug, which is how it survives review.
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

(function loop() {
  requestAnimationFrame(loop);
  controls.update();
  sizeHandles();
  renderer.render(scene, camera);
})();

/** The ray through a pointer event, as plain arrays for geometry.js. */
function rayThrough(e) {
  const r = renderer.domElement.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1
  ), camera);
  const { origin, direction } = ray.ray;
  return { ray, origin: [origin.x, origin.y, origin.z], dir: [direction.x, direction.y, direction.z] };
}

/* Every placed box, indexed like the object list, for the picker. Focus mode
   hands it one box: hit-testing boxes nobody can see moves the selection to
   something off-screen, and the click that did it looks like a miss. */
const pickTargets = () => OBJ().map((o, i) => {
  if (focusCur && i !== cur) return null;
  const a = ann[o.object_id];
  return a && a.xy ? boxOf(a) : null;
});

/* click on the mesh places the object; an orbit drag must not */
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || e.button !== 0) { down = null; return; }
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 4) return;
  const { ray, origin, dir } = rayThrough(e);

  /* In add and route mode a click means "make something here", so it is answered
     before anything is picked -- otherwise a room that already has boxes in it
     eats the clicks meant to add the next one. */
  if (!addMode && !pathMode) {
    const hit = G.pickBox(pickTargets(), origin, dir, floorZ);
    if (hit >= 0) {
      // No frame() on purpose: the object is under the pointer already, and a
      // camera that jumps on selection loses the view someone just orbited to.
      // The top-down view does follow, or the panel edits an object it is not
      // showing.
      cur = hit;
      planFocus();
      redraw();
      return;
    }
  }

  const hits = ray.intersectObjects(roomMeshes, true)
    // Geometry the cut hides is not visible, so it must not be clickable.
    .filter((h) => h.point.z <= clipPlane.constant);
  if (!hits.length) return;

  /* A click on bare mesh places an object that has nowhere to be. It used to
     place one that already did, which meant a single stray click on the far wall
     silently teleported a box someone had spent a minute fitting -- and the
     status stayed "corrected", so the record looked deliberate. Moving a placed
     box is now something you have to grab it to do. */
  const a = A();
  if (!addMode && !pathMode && a && a.xy) return;
  place(hits[0].point.x, hits[0].point.y);
});

/* ------------------------------------------------------------- 3D dragging */

/** The handle under a screen point, or null. Projected now, not when drawn. */
function handleAt(clientX, clientY) {
  const r = renderer.domElement.getBoundingClientRect();
  const v = new THREE.Vector3();
  let best = null, closest = G.HANDLE.GRAB_PX;
  for (const h of handles) {
    v.set(h.at[0], h.at[1], h.at[2]).project(camera);
    // Behind the camera, where the projection mirrors the point into view.
    if (v.z > 1) continue;
    const d = Math.hypot(
      r.left + (v.x * 0.5 + 0.5) * r.width - clientX,
      r.top + (0.5 - v.y * 0.5) * r.height - clientY
    );
    if (d < closest) { closest = d; best = h; }
  }
  return best;
}

function dragHandle(e) {
  const a = A();
  if (!a || !a.xy) return;
  const { origin, dir } = rayThrough(e);

  if (drag3d.kind === 'height') {
    // The one drag that does not go through the floor plane: it rides the box's
    // own vertical axis, so it keeps working with the pointer above the horizon,
    // where the floor is behind the viewer and there is no floor point at all.
    const t = G.axisHeight(origin, dir, a.xy[0], a.xy[1], floorZ);
    if (t === null) return;
    a.h = Math.min(G.HANDLE.HEIGHT_MAX_M, Math.max(G.HANDLE.HEIGHT_MIN_M, cm(t)));
    // Where a height came from is exported, and a dragged one is neither the
    // class default nor a typed measurement.
    a.hDragged = true;
  } else {
    const p = G.rayPlaneZ(origin, dir, floorZ);
    if (!p) return;
    if (drag3d.kind === 'move') {
      a.xy = [mm(p[0]), mm(p[1])];
    } else if (drag3d.kind === 'rot') {
      a.yaw = +G.normYaw180((Math.atan2(p[1] - a.xy[1], p[0] - a.xy[0]) * 180) / Math.PI).toFixed(1);
    } else if (drag3d.kind === 'corner') {
      Object.assign(a, G.resizeFromCorner(a, drag3d.pin, p[0], p[1], G.HANDLE.MIN_SIDE_M));
      a.w = mm(a.w); a.d = mm(a.d);
      a.xy = [mm(a.xy[0]), mm(a.xy[1])];
    }
  }
  touch();
  redraw();
}

/* The capture phase, and stopImmediatePropagation, are both load-bearing:
   OrbitControls listens for pointerdown on this same canvas, and a drag that
   edits the box and orbits the camera at once is unusable. Disabling the
   controls alone is not enough -- they have already taken the press. */
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const a = A();
  if (!a || !a.xy) return;
  const grabbed = handleAt(e.clientX, e.clientY);
  if (!grabbed) return;

  pushUndo();
  drag3d = {
    kind: grabbed.kind,
    // Captured once, here, as a world point. See geometry.resizeFromCorner for
    // what re-deriving "the opposite corner" every frame does to a drag that
    // crosses it.
    pin: grabbed.kind === 'corner' ? G.corners(a)[(grabbed.i + 2) % 4] : null,
  };
  controls.enabled = false;
  renderer.domElement.setPointerCapture(e.pointerId);
  e.stopImmediatePropagation();
  e.preventDefault();
}, true);

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag3d) return;
  dragHandle(e);
  e.stopImmediatePropagation();
}, true);

for (const kind of ['pointerup', 'pointercancel']) {
  renderer.domElement.addEventListener(kind, (e) => {
    if (!drag3d) return;
    drag3d = null;
    controls.enabled = true;
    // The press that began the drag never reached the click path; make sure the
    // release does not either, or letting go of a handle also places the object.
    down = null;
    e.stopImmediatePropagation();
  }, true);
}

/* ---------------------------------------------------------------- undo
 *
 * One stack for the whole session, holding whole annotations rather than deltas:
 * an edit here is a handful of numbers, and a snapshot cannot disagree with what
 * it is undoing. Routes are not in it -- they have their own undo button, and a
 * single Ctrl+Z that sometimes means "put the waypoint back" and sometimes means
 * "put the box back" is worse than either.
 */
const UNDO_LIMIT = 60;
const undoStack = [];

function pushUndo() {
  const o = current();
  if (!o) return;
  const a = ann[o.object_id];
  undoStack.push({ id: o.object_id, ann: a ? structuredClone(a) : null });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function undo() {
  while (undoStack.length) {
    const step = undoStack.pop();
    // An added box that was relabelled is re-minted under a new object_id, so an
    // entry from before the rename names nothing on the list. Restoring it would
    // write a key no view ever reads; skip to the next entry instead.
    const at = OBJ().findIndex((o) => o.object_id === step.id);
    if (at < 0) continue;
    if (step.ann) ann[step.id] = step.ann; else delete ann[step.id];
    // Undo selects what it just restored. A verdict advances the pass by itself,
    // so the object being undone is almost never the one on screen: leaving the
    // selection alone put the change on one object and the panel on another, and
    // read as the undo having done nothing. Selecting outside the current filter
    // is deliberate, and matches what picking a box in the 3D view already does.
    cur = at;
    touch();
    frame();
    planFocus();
    redraw();
    return;
  }
}

/* ------------------------------------------------------------------- topDown */

const pc = $('topdown');
const pctx = pc.getContext('2d');
let pv = { s: 1, ox: 0, oy: 0 };

const toScreen = (x, y) => {
  const [px, py] = topDown.toPx(x, y);
  return [px * pv.s + pv.ox, py * pv.s + pv.oy];
};
const screenToWorld = (sx, sy) => topDown.toWorld((sx - pv.ox) / pv.s, (sy - pv.oy) / pv.s);

function resizePlan() {
  if (!topDown || !pc.clientWidth) return;
  pc.width = pc.height = Math.max(180, pc.clientWidth);
  planFocus();
}
function planFocus() {
  const o = current();
  const a = A();
  const [x, y] = (a && a.xy) ? a.xy : (o?.reference_xy || topDown.centre);
  // Open at roughly two metres across, which is close enough to judge a box
  // against the object under it without hunting for the target first.
  pv.s = pc.width / (2.0 / topDown.metresPerPixel);
  const [px, py] = topDown.toPx(x, y);
  pv.ox = pc.width / 2 - px * pv.s;
  pv.oy = pc.height / 2 - py * pv.s;
  drawPlan();
}

function drawPlan() {
  const pal = palette();
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.fillStyle = pal.floor;
  pctx.fillRect(0, 0, pc.width, pc.height);
  pctx.imageSmoothingEnabled = pv.s < 1;
  pctx.drawImage(topDown.canvas, pv.ox, pv.oy, topDown.pixels * pv.s, topDown.pixels * pv.s);

  const showRefs = $('showrefs').checked;
  OBJ().forEach((o, i) => {
    const isCur = i === cur;
    if (focusCur && !isCur) return;
    const a = ann[o.object_id];
    let gx = null, gy = null;
    if (o.reference_xy && showRefs) {
      [gx, gy] = toScreen(...o.reference_xy);
      pctx.beginPath();
      pctx.arc(gx, gy, (o.radius_m / topDown.metresPerPixel) * pv.s, 0, 7);
      pctx.strokeStyle = isCur ? pal.bad : fade(pal.bad, 0.28);
      pctx.lineWidth = isCur ? 2 : 1;
      pctx.setLineDash(isCur ? [7, 5] : [3, 4]);
      pctx.stroke();
      pctx.setLineDash([]);
    }
    if (a && a.status === 'absent' && gx !== null) {
      pctx.strokeStyle = isCur ? pal.muted : fade(pal.muted, 0.4);
      pctx.lineWidth = 2;
      const k = 9;
      pctx.beginPath();
      pctx.moveTo(gx - k, gy - k); pctx.lineTo(gx + k, gy + k);
      pctx.moveTo(gx + k, gy - k); pctx.lineTo(gx - k, gy + k);
      pctx.stroke();
    } else if (a && a.xy) {
      const pts = G.corners(a).map(([x, y]) => toScreen(x, y));
      pctx.beginPath();
      pts.forEach((p, k) => (k ? pctx.lineTo(...p) : pctx.moveTo(...p)));
      pctx.closePath();
      pctx.strokeStyle = isCur ? pal.est : fade(pal.est, 0.35);
      pctx.lineWidth = isCur ? 2 : 1;
      pctx.stroke();
      if (isCur) {
        pctx.fillStyle = pal.est;
        for (const p of pts) { pctx.beginPath(); pctx.arc(p[0], p[1], 4.5, 0, 7); pctx.fill(); }
        if (gx !== null) {
          const [cx, cy] = toScreen(...a.xy);
          pctx.beginPath();
          pctx.moveTo(gx, gy); pctx.lineTo(cx, cy);
          pctx.strokeStyle = fade(pal.est, 0.53);
          pctx.setLineDash([4, 4]);
          pctx.lineWidth = 1;
          pctx.stroke();
          pctx.setLineDash([]);
        }
      }
    }
  });

  for (const r of SPEC.markers || []) {
    const [sx, sy] = toScreen(...r.xy);
    pctx.beginPath();
    pctx.arc(sx, sy, 6, 0, 7);
    pctx.fillStyle = pal.marker;
    pctx.fill();
    pctx.font = '11px system-ui';
    pctx.fillText(r.name, sx + 9, sy + 4);
  }

  routes.forEach((route, ri) => {
    if (!route.waypoints.length) return;
    const colour = `#${routeColour(ri).toString(16).padStart(6, '0')}`;
    const on = ri === activeRoute;
    pctx.globalAlpha = on ? 1 : 0.35;
    pctx.beginPath();
    route.waypoints.forEach(([x, y], i) => {
      const [sx, sy] = toScreen(x, y);
      i ? pctx.lineTo(sx, sy) : pctx.moveTo(sx, sy);
    });
    pctx.strokeStyle = colour;
    pctx.lineWidth = on ? 3 : 2;
    pctx.stroke();
    route.waypoints.forEach(([x, y], i) => {
      const [sx, sy] = toScreen(x, y);
      pctx.beginPath();
      pctx.arc(sx, sy, on ? 5 : 3.5, 0, 7);
      pctx.fillStyle = i ? colour : '#00ff88';
      pctx.fill();
    });
    pctx.globalAlpha = 1;
  });

  const staleBy = Math.abs(clipPlane.constant - floorZ - topDownCutHeight);
  $('scale').innerHTML =
    t('topdown.scale', { mm: ((topDown.metresPerPixel / pv.s) * 1000).toFixed(2) })
    + (staleBy > 1e-6
      ? ` <span class="stale">· ${t('topdown.stale', { h: topDownCutHeight.toFixed(2) })}</span>`
      : '');
}

let pdrag = null;
pc.addEventListener('mousedown', (e) => {
  const [wx, wy] = screenToWorld(e.offsetX, e.offsetY);
  const a = A();
  if (a && a.xy) {
    const hit = G.corners(a).findIndex(([x, y]) => {
      const [sx, sy] = toScreen(x, y);
      return Math.hypot(sx - e.offsetX, sy - e.offsetY) < 8;
    });
    // The pinned corner is captured here, once, as a world point -- see
    // geometry.resizeFromCorner for why looking it up per frame is wrong.
    if (hit >= 0) { pdrag = { mode: 'resize', pin: G.corners(a)[(hit + 2) % 4] }; return; }
    const [lu, lv] = G.toLocal(a, wx, wy);
    if (Math.abs(lu) <= a.w / 2 && Math.abs(lv) <= a.d / 2) {
      pdrag = { mode: 'move', gx: wx - a.xy[0], gy: wy - a.xy[1] };
      return;
    }
  }
  pdrag = { mode: 'pan', x: e.offsetX, y: e.offsetY, ox: pv.ox, oy: pv.oy, moved: 0 };
});
addEventListener('mousemove', (e) => {
  if (!pdrag) return;
  const r = pc.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const [wx, wy] = screenToWorld(mx, my);
  const a = A();
  if (pdrag.mode === 'pan') {
    pdrag.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    pv.ox = pdrag.ox + (mx - pdrag.x);
    pv.oy = pdrag.oy + (my - pdrag.y);
  } else if (pdrag.mode === 'move' && a) {
    a.xy = [wx - pdrag.gx, wy - pdrag.gy];
    touch();
  } else if (pdrag.mode === 'resize' && a) {
    Object.assign(a, G.resizeFromCorner(a, pdrag.pin, wx, wy));
    touch();
  }
  redraw();
});
addEventListener('mouseup', (e) => {
  if (pdrag && pdrag.mode === 'pan' && pdrag.moved < 4) {
    const r = pc.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      place(...screenToWorld(e.clientX - r.left, e.clientY - r.top));
    }
  }
  pdrag = null;
});
pc.addEventListener('wheel', (e) => {
  e.preventDefault();
  const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const s2 = Math.max(0.02, Math.min(80, pv.s * k));
  pv.ox = e.offsetX - (e.offsetX - pv.ox) * (s2 / pv.s);
  pv.oy = e.offsetY - (e.offsetY - pv.oy) * (s2 / pv.s);
  pv.s = s2;
  drawPlan();
}, { passive: false });

/* ------------------------------------------------------------------ edits */

function place(x, y) {
  if (pathMode) {
    if (!routes.length) newRoute(false);
    routes[activeRoute].waypoints.push([+x.toFixed(3), +y.toFixed(3)]);
    touch(); redraw();
    return;
  }
  if (addMode) { addObject(x, y); return; }
  const o = current();
  if (!o) return;
  pushUndo();
  const a = ann[o.object_id] || {};
  if (!a.xy) {
    const [w, d, h] = clsSize(classOf(o));
    a.w = a.w || (o.radius_m ? o.radius_m * 2 : w);
    a.d = a.d || (o.radius_m ? o.radius_m * 2 : d);
    a.h = a.h || h;
    a.yaw = a.yaw || 0;
  }
  a.xy = [x, y];
  a.status = o.reference_xy
    ? (Math.hypot(x - o.reference_xy[0], y - o.reference_xy[1]) < 0.02 ? 'confirmed' : 'corrected')
    : 'added';
  ann[o.object_id] = a;
  touch(); redraw();
}

function mintId(clsId, ignore) {
  const base = `${SPEC.scene}_${clsId}`;
  const taken = new Set(OBJ().map((o) => o.object_id).filter((x) => x !== ignore));
  let n = 1, id;
  do { id = `${base}_${String(n++).padStart(3, '0')}`; } while (taken.has(id));
  return id;
}

function addObject(x, y) {
  const clsId = $('cls').value;
  const [w, d, h] = clsSize(clsId);
  const id = mintId(clsId);
  extra.push({
    object_id: id, cls: clsId, kind: 'added',
    reference_xy: null, radius_m: +(Math.max(w, d) / 2).toFixed(3), extra: {},
  });
  ann[id] = { xy: [x, y], w, d, h, yaw: 0, status: 'added', note: '' };
  cur = OBJ().length - 1;
  touch(); redraw();
}

function removeObject(i) {
  const o = OBJ()[i];
  if (!o || o.kind !== 'added') return;
  delete ann[o.object_id];
  extra = extra.filter((x) => x.object_id !== o.object_id);
  cur = Math.min(cur, OBJ().length - 1);
  const vis = visible();
  if (vis.length && !vis.includes(cur)) cur = vis[vis.length - 1];
  touch(); redraw();
}

/* An object's class is a judgement about what it *is*, separate from where it
   is. Notes saying "this is actually a different kind of thing" are not
   something a downstream catalogue can act on; a class change is. */
function setClass(clsId) {
  const o = current();
  if (!o) return;
  pushUndo();
  const a = (ann[o.object_id] = ann[o.object_id] || {});
  if (clsId === o.cls) delete a.cls; else a.cls = clsId;

  if (o.kind === 'added') {
    const oldSize = clsSize(o.cls);
    const newSize = clsSize(clsId);
    // A box created as one class and relabelled kept both the old id and the old
    // default size: seven "monitors" came back named ..._trash_can_00N at
    // 0.4 x 0.4 x 0.8. An identifier that lies about what it names survives into
    // every downstream file.
    if (a.xy && Math.abs(a.w - oldSize[0]) < 1e-6 && Math.abs(a.d - oldSize[1]) < 1e-6
        && Math.abs((a.h || 0) - oldSize[2]) < 1e-6) {
      [a.w, a.d, a.h] = newSize;
    }
    const id = mintId(clsId, o.object_id);
    if (id !== o.object_id) {
      ann[id] = a;
      delete ann[o.object_id];
      o.object_id = id;
      o.cls = clsId;
      delete a.cls;
      o.radius_m = +(Math.max(a.w || 0.3, a.d || 0.3) / 2).toFixed(3);
    }
  }
  touch(); redraw();
}

function setStatus(s) {
  const o = current();
  if (!o) return;
  // Confirming an object that has no reference is not a verdict anyone can act
  // on, so this call does nothing at all -- and doing nothing must leave no
  // trace: no empty annotation record, and above all no undo entry, which would
  // otherwise make the next Ctrl+Z appear to be ignored.
  if (s === 'confirmed' && !o.reference_xy) return;
  pushUndo();
  const a = (ann[o.object_id] = ann[o.object_id] || {});
  if (s === 'confirmed') {
    // "The reference was right" has to mean the reference's own coordinates.
    // Leaving a dragged position under a confirmed status produced a record that
    // contradicted itself and needed a human to adjudicate.
    a.xy = o.reference_xy.slice();
    const [w, d, h] = clsSize(classOf(o));
    a.w = a.w || (o.radius_m ? o.radius_m * 2 : w);
    a.d = a.d || (o.radius_m ? o.radius_m * 2 : d);
    a.h = a.h || h;
    a.yaw = a.yaw || 0;
  }
  if (s === 'absent') delete a.xy;
  a.status = s;
  touch();
  // A verdict is the end of one object's turn, so the pass moves on by itself.
  // Reaching for "next" after every single judgement is the whole cost of a
  // hundred-object round, and it is paid one click at a time.
  if (s === 'confirmed' || s === 'absent') stepUntouched();
  redraw();
}

function step(n) {
  const vis = visible();
  if (!vis.length) return;
  const at = vis.indexOf(cur);
  cur = vis[((at < 0 ? 0 : at + n) + vis.length) % vis.length];
  frame(); planFocus(); redraw();
}

/* The next object in this view that nobody has ruled on yet, wrapping once.
   Stays put when there is none: at the end of a pass, being dropped back at the
   first object reads as the tool having lost the work. */
function stepUntouched() {
  const objs = OBJ();
  const vis = visible();
  if (!vis.length) return;
  const at = Math.max(0, vis.indexOf(cur));
  for (let k = 1; k <= vis.length; k++) {
    const i = vis[(at + k) % vis.length];
    if (!(ann[objs[i].object_id] || {}).status) {
      cur = i;
      frame(); planFocus();
      return;
    }
  }
}

function setFilter(f) {
  filter = f;
  const vis = visible();
  // Selecting something the list no longer shows leaves the right-hand panel
  // editing an object the person cannot see.
  if (vis.length && !vis.includes(cur)) { cur = vis[0]; frame(); planFocus(); }
  redraw();
}

/* ------------------------------------------------------------------ routes */

function newRoute(focus = true) {
  const n = routes.length + 1;
  routes.push({ id: `route_${n}`, name: `${t('routes.title')} ${n}`, waypoints: [] });
  activeRoute = routes.length - 1;
  if (focus && !pathMode) togglePath();
  touch(); redraw();
}
function deleteRoute() {
  const r = routes[activeRoute];
  if (!r) return;
  if (r.waypoints.length
      && !confirm(t('routes.confirmDelete', { name: r.name, n: r.waypoints.length }))) return;
  routes.splice(activeRoute, 1);
  activeRoute = Math.max(0, Math.min(activeRoute, routes.length - 1));
  touch(); redraw();
}
function renameRoute() {
  const r = routes[activeRoute];
  if (!r) return;
  const name = prompt(t('routes.namePrompt'), r.name);
  if (name) { r.name = name; touch(); redraw(); }
}
function undoWaypoint() {
  routes[activeRoute]?.waypoints.pop();
  touch(); redraw();
}
function togglePath() {
  pathMode = !pathMode;
  if (pathMode && addMode) toggleAdd();       // one click, one meaning
  if (pathMode && !routes.length) newRoute(false);
  redraw();
}
function toggleAdd() {
  addMode = !addMode;
  if (addMode && pathMode) togglePath();
  setFilter(addMode ? 'added' : 'all');
}

/* ------------------------------------------------------------- persistence */

function touch() {
  store.saveSession(localStorage, keys, { ann, extra, routes });
}

function resetAll() {
  if (!confirm(t('io.confirmReset'))) return;
  ann = {}; extra = []; routes = []; activeRoute = 0; cur = 0;
  for (const k of store.sceneKeys(localStorage, SPEC.scene)) localStorage.removeItem(k);
  touch(); redraw();
}

/* ------------------------------------------------------------------ render */

function redraw() {
  rebuildOverlay();
  drawPlan();
  renderList();
  renderRight();
  renderRoutes();
  $('addbtn').textContent = t(addMode ? 'add.mode.on' : 'add.mode.off');
  $('addbtn').className = addMode ? 'primary' : '';
  $('pathbtn').textContent = t(pathMode ? 'routes.mode.on' : 'routes.mode.off');
  $('pathbtn').className = pathMode ? 'primary' : '';
  $('refinfo').innerHTML = (SPEC.markers || []).length ? t('markers.legend') : '';
  // What this page is a pass over, in one breath: which scene, against which
  // baseline. An export is only readable next to both.
  $('baseline').textContent = `${SPEC.scene} · ` + (SPEC.targets.length
    ? t('view.baseline', { baseline: SPEC.baseline })
    : t('view.noTargets'));
}

function renderRoutes() {
  const sel = $('routesel');
  sel.innerHTML = routes.map((r, i) =>
    `<option value="${i}"${i === activeRoute ? ' selected' : ''}>${escapeHtml(r.name)} (${r.waypoints.length})</option>`
  ).join('');
  sel.disabled = !routes.length;
  $('routedel').disabled = !routes.length;
  $('routerename').disabled = !routes.length;
  $('undobtn').disabled = !routes[activeRoute]?.waypoints.length;
  const r = routes[activeRoute];
  $('pathinfo').innerHTML = r && r.waypoints.length
    ? t('routes.info', { n: r.waypoints.length, len: G.pathLength(r.waypoints).toFixed(2) })
      + (routeState.recoveredFrom
        ? t('routes.recovered', { key: escapeHtml(routeState.recoveredFrom) })
        : '')
    : t('routes.hint');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* One glyph per verdict.
 *
 * These were coloured dots, and a dot cannot say more than "something happened
 * here": confirmed and corrected -- the two the pass exists to tell apart --
 * were the same green, and absent was a grey nobody read as a decision. The
 * glyph is the same in the row and in the counter above it, so the heading is
 * legible without a legend. */
const STATUS_ICON = { confirmed: '✅', corrected: '✏️', absent: '🗑', added: '➕' };

function renderList() {
  const objs = OBJ();
  const vis = visible();
  for (const b of document.querySelectorAll('.tabs button')) {
    b.className = b.dataset.f === filter ? 'on' : '';
  }
  $('list').innerHTML = vis.length ? vis.map((i) => {
    const o = objs[i];
    const a = ann[o.object_id] || {};
    const changed = classOf(o) !== o.cls;
    const del = o.kind === 'added'
      ? `<span class="del" data-del="${i}" title="Del">&times;</span>` : '';
    // Ruled absent strikes the row through but leaves it live: this is the only
    // way back from that verdict.
    return `<div class="item ${i === cur ? 'sel' : ''} ${a.status === 'absent' ? 'absent' : ''}" data-i="${i}">
      <span class="icon">${STATUS_ICON[a.status] || '○'}</span>
      <span class="nm">${escapeHtml(o.object_id)}<br><small>${escapeHtml(clsLabel(classOf(o)))}${
        changed ? ` <i style="color:var(--est)">(${escapeHtml(t('obj.original', { label: clsLabel(o.cls) }))})</i>` : ''
      }</small></span>${del}</div>`;
  }).join('') : `<small>${t('list.empty')}</small>`;

  for (const el of document.querySelectorAll('.item')) {
    el.onclick = () => { cur = +el.dataset.i; frame(); planFocus(); redraw(); };
  }
  for (const el of document.querySelectorAll('.del')) {
    el.onclick = (e) => { e.stopPropagation(); removeObject(+el.dataset.del); };
  }
  // Counted by verdict, not just "done": a pass that ruled twenty objects absent
  // and confirmed two is not the same pass as the other way round, and a single
  // fraction said neither. Zero counts are left out rather than shown as zero.
  const tally = {};
  for (const o of targets) {
    const s = (ann[o.object_id] || {}).status;
    if (s) tally[s] = (tally[s] || 0) + 1;
  }
  const icons = ['confirmed', 'corrected', 'absent']
    .filter((s) => tally[s]).map((s) => `${STATUS_ICON[s]}${tally[s]}`).join(' ');
  $('progress').textContent =
    (targets.length ? t('list.progress', { icons: icons || '—', total: targets.length }) : '')
    + (extra.length ? t('list.progressAdded', { n: extra.length }) : '');
}

function fillClassSelect() {
  const keep = $('cls').value;
  $('cls').innerHTML = CLASSES.map((c) => {
    const [w, d, h] = c.size_m;
    return `<option value="${c.id}">${escapeHtml(clsLabel(c.id))} (${w}×${d}×${h} m)</option>`;
  }).join('');
  if (keep) $('cls').value = keep;
}

function renderRight() {
  const o = current();
  // Where this object sits in the pass. Without it the two arrows are a step in
  // the dark: "3/14" is the difference between working through a list and
  // wandering around one.
  const vis = visible();
  const at = vis.indexOf(cur);
  $('navpos').textContent = vis.length ? `${at < 0 ? '—' : at + 1}/${vis.length}` : '';
  if (!o) { $('title').textContent = ''; return; }
  const a = A() || {};
  $('title').textContent = o.object_id;
  $('lbl').innerHTML = `<small>${
    o.radius_m ? escapeHtml(t('obj.declared', { r: o.radius_m })) : ''
  }${o.extra?.dynamic ? ' · dynamic' : ''}</small>`;

  const sel = $('relabel');
  sel.innerHTML = CLASSES.map((c) =>
    `<option value="${c.id}"${c.id === classOf(o) ? ' selected' : ''}>${escapeHtml(clsLabel(c.id))}</option>`
  ).join('');
  $('lblnote').textContent = classOf(o) === o.cls
    ? t('obj.classLabel')
    : t('obj.classChanged', { from: clsLabel(o.cls), to: clsLabel(classOf(o)) });

  $('yaw').value = a.yaw || 0;
  $('yawv').textContent = `${a.yaw || 0}°`;
  $('note').value = a.note || '';
  // Cleared rather than left stale: numbers from the previously selected object
  // read as this one's measurements, which is how a wrong size gets exported.
  $('w').value = a.xy ? a.w.toFixed(2) : '';
  $('d').value = a.xy ? a.d.toFixed(2) : '';
  $('h').value = a.xy ? (a.h || 0.9).toFixed(2) : '';
  for (const [id, axis] of [['cx', 0], ['cy', 1]]) {
    const el = $(id);
    // Left alone while it is being typed into AND still agrees with the object:
    // this runs on every input event, and re-rounding the value under the caret
    // turns "1.5" into "1.500" and puts the cursor at the end of it. The moment
    // the two disagree it is written anyway -- an undo landing while the field
    // still has focus would otherwise leave a number on the screen that the
    // object does not have, which is the one thing these fields cannot do.
    const agrees = Math.abs(parseFloat(el.value) - (a.xy ? a.xy[axis] : NaN)) < 1e-3;
    if (document.activeElement === el && agrees) continue;
    el.value = a.xy ? a.xy[axis].toFixed(3) : '';
  }

  const st = t(`status.${a.status || 'pending'}`);
  const off = (a.xy && o.reference_xy)
    ? Math.hypot(a.xy[0] - o.reference_xy[0], a.xy[1] - o.reference_xy[1]) : null;
  $('readout').innerHTML =
    `<b>${t('read.status')}</b><span class="tag">${st}</span>`
    + (o.reference_xy
      ? `<b>${t('read.reference')}</b><span>${o.reference_xy[0].toFixed(3)}, ${o.reference_xy[1].toFixed(3)}</span>` : '')
    + (a.xy ? `<b>${t('read.annotated')}</b><span>${a.xy[0].toFixed(3)}, ${a.xy[1].toFixed(3)}</span>` : '')
    + (off !== null ? `<b>${t('read.offset')}</b><span>${off.toFixed(3)} m</span>` : '')
    + `<b>${t('read.floor')}</b><span>${floorZ.toFixed(3)} m</span>`;
  $('hud').textContent =
    `${cur + 1}/${OBJ().length}  ${o.object_id}\n${st}`
    + (off !== null ? `  ${t('read.offset')} ${off.toFixed(3)} m` : '')
    + (addMode ? `\n${t('add.mode.on')}` : '')
    + (pathMode ? `\n${t('routes.mode.on')}` : '');
}

/* ------------------------------------------------------------- import/export */

function buildExport() {
  return {
    format: 'meshmark/annotations',
    version: 1,
    scene: SPEC.scene,
    source: {
      mesh: SPEC.mesh.file,
      mesh_source: SPEC.mesh.source,
      floor_z_m: +floorZ.toFixed(4),
      floor_source: SPEC.floor_z_m === null ? 'measured from the mesh' : 'given with --floor',
      top_down: {
        pixels: topDown.pixels,
        metres_per_pixel: topDown.metresPerPixel,
        centre_xy: topDown.centre,
      },
      classes_preset: SPEC.classes.name,
      baseline: SPEC.baseline,
    },
    objects: OBJ().map((o) => {
      const a = ann[o.object_id] || {};
      const clsId = classOf(o);
      const c = byId.get(clsId) || {};
      const out = {
        object_id: o.object_id,
        class_id: clsId,
        label: c.en || clsId,
        label_zh: c.zh || clsId,
        kind: o.kind,
        status: a.status || 'pending',
        note: a.note || '',
      };
      if (clsId !== o.cls) out.original_class_id = o.cls;
      if (o.reference_xy) out.reference_xy = o.reference_xy;
      if (o.radius_m != null) out.footprint_radius_m = o.radius_m;
      if (a.xy) {
        out.world_xy = a.xy.map((v) => +v.toFixed(4));
        const nominal = clsSize(clsId)[2];
        out.box = {
          width_m: +a.w.toFixed(3),
          depth_m: +a.d.toFixed(3),
          height_m: +(a.h || nominal).toFixed(3),
          yaw_deg: a.yaw || 0,
          // Three ways a height gets its number, and they are not equally good.
          // Dragged against the mesh on the vertical rail is a measurement of
          // the object; typed is a measurement of something, made elsewhere;
          // the class default is a guess that has never been looked at. Saying
          // which is the difference between a figure and a figure that gets
          // cited as one.
          height_source: a.hDragged
            ? 'dragged in 3D'
            : (Math.abs((a.h || nominal) - nominal) < 1e-6 ? 'class default' : 'entered by hand'),
        };
        if (o.reference_xy) {
          out.offset_m = +Math.hypot(
            a.xy[0] - o.reference_xy[0], a.xy[1] - o.reference_xy[1]
          ).toFixed(4);
        }
      }
      // Whatever the reference file carried that this tool does not model is
      // handed back untouched, so a round trip through here loses nothing.
      if (o.extra && Object.keys(o.extra).length) out.source_fields = o.extra;
      return out;
    }),
    routes: routes.map((r) => ({
      id: r.id,
      name: r.name,
      waypoints: r.waypoints,
      length_m: +G.pathLength(r.waypoints).toFixed(3),
    })),
  };
}

function exportJson() {
  const blob = new Blob([JSON.stringify(buildExport(), null, 1)], { type: 'application/json' });
  const el = document.createElement('a');
  el.href = URL.createObjectURL(blob);
  el.download = `meshmark_${SPEC.scene}.json`;
  el.click();
  URL.revokeObjectURL(el.href);
}

function applyRound(d) {
  ann = {};
  extra = [];
  const known = new Set(targets.map((o) => o.object_id));
  for (const o of d.objects || []) {
    const clsId = o.class_id && byId.has(o.class_id)
      ? o.class_id
      : (classFor(o.label || o.class_id || '') || adoptClass(o.label || o.class_id || 'other'));
    if (!known.has(o.object_id)) {
      // Anything the reference file does not name was added by hand; restore it
      // as an object rather than dropping it on the floor.
      extra.push({
        object_id: o.object_id, cls: clsId, kind: 'added', reference_xy: null,
        radius_m: (o.box || o.footprint)
          ? +(Math.max((o.box || o.footprint).width_m, (o.box || o.footprint).depth_m) / 2).toFixed(3)
          : (o.footprint_radius_m || 0.3),
        extra: o.source_fields || {},
      });
    }
    if (o.status === 'pending' && !o.world_xy && !o.note && !o.original_class_id) continue;
    const a = { status: o.status, note: o.note || '' };
    const base = known.has(o.object_id)
      ? targets.find((x) => x.object_id === o.object_id).cls : clsId;
    if (clsId !== base) a.cls = clsId;
    if (o.world_xy) {
      a.xy = o.world_xy;
      const b = o.box || o.footprint || {};
      a.w = b.width_m ?? 0.5;
      a.d = b.depth_m ?? 0.5;
      a.h = b.height_m ?? 0.9;
      a.yaw = b.yaw_deg ?? 0;
      // Carried back in, or a round trip through a file turns a height somebody
      // measured against the mesh into one the export calls typed.
      if (b.height_source === 'dragged in 3D') a.hDragged = true;
    }
    ann[o.object_id] = a;
  }
  const loaded = store.normaliseRoutes(d.routes || d.human_path?.waypoints || []);
  if (loaded.length) { routes = loaded; activeRoute = 0; }
  cur = 0;
  fillClassSelect();
  touch();
  redraw();
}

function importJson(ev) {
  const f = ev.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    let d;
    try { d = JSON.parse(rd.result); }
    catch (e) { alert(t('io.badJson', { err: e.message })); return; }
    const n = (d.objects || []).filter((o) => o.world_xy).length;
    if (!n && !(d.routes || []).length) {
      // Silence here reads as "load is broken". It usually means the wrong file.
      alert(t('io.noCoords', { total: (d.objects || []).length }));
      return;
    }
    applyRound(d);
    alert(t('io.loaded', { n }));
  };
  rd.readAsText(f);
  ev.target.value = '';
}

/* ------------------------------------------------------------------- wiring */

$('langbtn').onclick = () => setLanguage(lang === 'zh' ? 'en' : 'zh');

/* The full reference is a card you open, not a column standing permanently
   under the panel. It is read closely twice on the first day and never again,
   and for the rest of the time the pill along the bottom is the whole of what
   anybody needs on the screen. */
const setHelp = (on) => $('helpcard').classList.toggle('show', on);
$('helpbtn').onclick = () => setHelp(!$('helpcard').classList.contains('show'));
$('helpclose').onclick = () => setHelp(false);
$('addbtn').onclick = () => { toggleAdd(); redraw(); };
$('pathbtn').onclick = () => { togglePath(); redraw(); };
$('undobtn').onclick = undoWaypoint;
$('routenew').onclick = () => newRoute();
$('routedel').onclick = deleteRoute;
$('routerename').onclick = renameRoute;
$('routesel').onchange = (e) => { activeRoute = +e.target.value; redraw(); };
$('showrefs').onchange = redraw;
$('focuscur').checked = focusCur;
$('focuscur').onchange = () => {
  focusCur = $('focuscur').checked;
  localStorage.setItem(keys.focus, focusCur ? '1' : '0');
  redraw();
};
$('exportbtn').onclick = exportJson;
$('importbtn').onclick = () => $('imp').click();
$('imp').onchange = importJson;
$('resetbtn').onclick = resetAll;
$('framebtn').onclick = () => { frame(); planFocus(); };
$('relabel').onchange = (e) => setClass(e.target.value);
$('confirmbtn').onclick = () => setStatus('confirmed');
$('absentbtn').onclick = () => setStatus('absent');
$('clearbtn').onclick = () => {
  const o = current();
  if (o) { delete ann[o.object_id]; touch(); redraw(); }
};
$('prevbtn').onclick = () => step(-1);
$('nextbtn').onclick = () => step(1);
$('note').oninput = (e) => {
  const o = current();
  if (o) { (ann[o.object_id] = ann[o.object_id] || {}).note = e.target.value; touch(); }
};
/* One undo entry per gesture, not per keystroke.
 *
 * Typing 1.25 into a width field fires four input events, and a stack that took
 * all four spends four Ctrl+Z getting back to where the object was before the
 * number was typed -- by which point the person pressing it has no idea how many
 * more are left. A gesture starts at the first edit after the field is focused
 * and ends when focus leaves. */
let editGesture = null;
function beginEdit(el) {
  if (editGesture === el) return;
  editGesture = el;
  pushUndo();
}
for (const id of ['w', 'd', 'h', 'yaw', 'cx', 'cy']) {
  $(id).addEventListener('focus', () => { editGesture = null; });
  $(id).addEventListener('blur', () => { editGesture = null; });
}

/* A typed position, on the same terms as a dragged one: the same gesture undo,
   the same millimetre rounding, the same redraw. Some positions are read off a
   floor plan rather than found by eye, and until now the only way to enter one
   was to drag until the readout agreed.
 *
 * Parsed rather than coerced. `+""` and `+"-"` are 0 and NaN, and a field that
 * is empty or half-typed names no position at all -- coercing either would put
 * the object on the origin between two keystrokes. */
for (const id of ['cx', 'cy']) {
  $(id).oninput = () => {
    const a = A();
    if (!a || !a.xy) return;
    const x = parseFloat($('cx').value), y = parseFloat($('cy').value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    beginEdit($(id));
    a.xy = [mm(x), mm(y)];
    touch(); redraw();
  };
  // The render pass skips a focused field, so whatever was left half-typed in
  // it is put right when the caret leaves rather than staying on the screen as
  // a number the object does not have.
  $(id).addEventListener('blur', renderRight);
}

$('yaw').oninput = (e) => {
  const a = A();
  if (a && a.xy) { beginEdit($('yaw')); a.yaw = +e.target.value; touch(); redraw(); }
};
for (const id of ['w', 'd', 'h']) {
  $(id).oninput = () => {
    const a = A();
    if (!a || !a.xy) return;
    beginEdit($(id));
    a.w = Math.max(G.BOX.MIN_SIDE_M, +$('w').value || a.w);
    a.d = Math.max(G.BOX.MIN_SIDE_M, +$('d').value || a.d);
    a.h = Math.max(G.BOX.MIN_SIDE_M, +$('h').value || a.h || 0.9);
    // A typed height is a different claim from a dragged one, and the export
    // says which: retyping the number has to take the mark off.
    if (id === 'h') delete a.hDragged;
    touch(); redraw();
  };
}
for (const b of document.querySelectorAll('.tabs button')) {
  b.onclick = () => setFilter(b.dataset.f);
}

$('cut').addEventListener('input', () => {
  clipPlane.constant = floorZ + +$('cut').value;
  $('cutval').textContent = (+$('cut').value).toFixed(2);
  drawPlan();
});
// Re-render the top-down view on release, not on every input event: a 2048px readback
// is tens of milliseconds and dragging the slider would stutter.
$('cut').addEventListener('change', () => { buildTopDown(); redraw(); });

addEventListener('keydown', (e) => {
  if (['TEXTAREA', 'INPUT', 'SELECT'].includes(e.target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    undo();
    return;
  }
  const a = A();
  const big = e.shiftKey ? 0.1 : 0.01;
  const n = { ArrowLeft: [-big, 0], ArrowRight: [big, 0], ArrowUp: [0, big], ArrowDown: [0, -big] }[e.key];
  if (n && a && a.xy) {
    e.preventDefault();
    a.xy = [a.xy[0] + n[0], a.xy[1] + n[1]];
    touch(); redraw();
  } else if (e.key === 'Enter') step(1);
  else if (e.key === 'Escape') setHelp(false);
  else if (e.key === 'f' || e.key === 'F') { frame(); planFocus(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    // Bulk passes mis-click; undoing one has to be as cheap as making one.
    e.preventDefault();
    removeObject(cur);
  }
});

/* Sized from the elements themselves, not from window resize events.
 *
 * A window event never arrives if the page boots while its container has no
 * width -- a hidden tab, a panel that lays out late, an iframe sized after
 * load -- and both canvases then sit at their 300x150 default until the user
 * happens to resize the window. Measured in a browser reporting innerWidth 0:
 * the view canvas stayed at 0 through a full reload and only came right when a
 * resize event was dispatched by hand. A ResizeObserver fires when the element
 * actually gets a size, which is the condition that matters.
 */
const sizeWatcher = new ResizeObserver(() => { resize3d(); resizePlan(); });
// The two canvases' own containers, not the panel around them. The right panel
// scrolls, so a change in its content can add or remove a scrollbar, change its
// content width, and re-enter this callback -- the classic ResizeObserver loop.
// Setting a canvas's width attribute does not change its CSS box, so watching
// the canvas itself cannot feed back.
sizeWatcher.observe(view);
sizeWatcher.observe(pc);

/* The theme can change while the page is open -- the machine switches at
   sunset, halfway through a pass. The stylesheet follows on its own; the two
   canvases are painted in JavaScript and would otherwise hold last night's
   colours until something else happened to redraw them. */
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  scene.background = new THREE.Color(palette().floor);
  // The top-down view is a readback of a render, so the scene's background is
  // baked into the image rather than painted under it. Repainting the canvas
  // alone would leave last night's backdrop showing through every part of the
  // room that is floor -- which is most of it. The whole readback is tens of
  // milliseconds and this happens about twice a day.
  buildTopDown();
  redraw();
});

/* -------------------------------------------------------------------- boot */

applyStaticStrings();
fillClassSelect();
resize3d();
resizePlan();
frame();
// Preloaded work is applied only into an empty slate, so re-opening the page
// never discards a round in progress.
if (session.fresh && SPEC.preload) applyRound(SPEC.preload);
redraw();

// A flipped axis produces annotations that look entirely reasonable and are
// mirrored, and that is not a bug anyone catches by looking at a screenshot.
const probe = [
  topDown.centre[0] - topDown.span * 0.31,
  topDown.centre[1] + topDown.span * 0.19,
];
const mapping = verifyMapping(renderer, topDown, probe, floorZ + 0.5);
if (!mapping.ok) {
  console.error('meshmark: the top-down mapping does not match a probe', mapping);
} else {
  console.info(`meshmark: top-down mapping verified to ${mapping.errorPx.toFixed(2)} px `
    + `(${(mapping.errorM * 1000).toFixed(1)} mm)`);
}

window.__meshmark = {
  THREE, scene, camera, controls, clipPlane, SPEC, renderer,
  get topDown() { return topDown; },
  get floorZ() { return floorZ; },
  get ann() { return ann; },
  get extra() { return extra; },
  get routes() { return routes; },
  get cur() { return cur; },
  get lang() { return lang; },
  get focusCur() { return focusCur; },
  // The colours the canvases are actually painting with, resolved from the
  // stylesheet: what a theme check has to compare, and the only way to make one
  // from outside the page.
  get palette() { return { ...palette() }; },
  // The handles as the picker sees them, not as they are drawn: a click test
  // run from outside the page is the only way to check the grab radius without
  // a hand on a mouse.
  get handles() { return handles.map(({ kind, i, at }) => ({ kind, i, at })); },
  mapping,
  place, step, setStatus, setClass, setLanguage, buildExport, applyRound, redraw, undo,
  // What the ResizeObserver calls. Exposed because the observer is delivered on
  // the event loop's rendering steps, which a hidden page does not run -- so in
  // a headless or background tab the sizing path cannot be triggered from
  // outside any other way, and an untriggerable path is an unverifiable one.
  resize() { resize3d(); resizePlan(); },
  // Pose the view from outside the page. Setting camera.position alone does
  // nothing lasting -- OrbitControls re-derives it from its target every frame.
  look(cx, cy, cz, tx, ty, tz) {
    camera.position.set(cx, cy, cz);
    controls.target.set(tx, ty, tz);
    controls.update();
  },
};
