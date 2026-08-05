/* Saved work: what is written where, and what survives a rebuild.
 *
 * This module exists because of a specific failure. In the version this tool
 * grew out of, loading saved work was two lines in the middle of the
 * application, and a commit about something else deleted them. The page went on
 * claiming "saved automatically, a refresh does not lose it" while every object
 * annotation was discarded on load, for days, unnoticed.
 *
 * The lines are now a function with a test that seeds a store and asserts the
 * work comes back. Nothing in here touches the DOM or three.js, so that test
 * runs in node.
 *
 * Two scopes, on purpose:
 *
 *   objects  keyed by scene AND baseline. When the reference positions change,
 *            boxes from an earlier round would be drawn over rings that have
 *            since moved, and every offset in the panel would be measured
 *            against a reference that is no longer there.
 *
 *   routes   keyed by scene ALONE. A route is about the floor of the room;
 *            rebuilding because the object list changed has nothing to do with
 *            it. Keying routes by baseline nearly cost a day's work: two
 *            rebuilds landed while a route was being drawn, and each moved the
 *            key out from under it, with no error and an empty panel.
 */

export const PREFIX = 'meshmark';

export function keysFor(scene, baseline) {
  const base = `${PREFIX}:${scene}`;
  return {
    objects: `${base}:${baseline}:objects`,
    added: `${base}:${baseline}:added`,
    routes: `${base}:routes`,
    lang: `${PREFIX}:lang`,
    routePrefix: base,
  };
}

function readJSON(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null ? fallback : parsed;
  } catch (e) {
    // A corrupt entry must not stop the page from opening; it is one scene's
    // work, and the alternative is a blank screen with a console error.
    console.warn(`meshmark: ignoring unreadable ${key}:`, e);
    return fallback;
  }
}

/**
 * Restore annotations and added objects for one scene and baseline.
 * `fresh` is true only when there is nothing at all -- it gates preloading, so
 * that opening the page again never discards a round in progress.
 */
export function loadSession(storage, keys) {
  const annotations = readJSON(storage, keys.objects, {});
  const added = readJSON(storage, keys.added, []);
  const ann = annotations && typeof annotations === 'object' && !Array.isArray(annotations)
    ? annotations : {};
  const extra = Array.isArray(added) ? added : [];
  return { ann: ann, extra: extra, fresh: !Object.keys(ann).length && !extra.length };
}

export function saveSession(storage, keys, { ann, extra, routes }) {
  storage.setItem(keys.objects, JSON.stringify(ann));
  storage.setItem(keys.added, JSON.stringify(extra));
  storage.setItem(keys.routes, JSON.stringify(routes));
}

const ROUTE_SUFFIX = ':routes';

/**
 * Restore routes, recovering any orphaned under an older key scheme.
 *
 * Takes the richest orphan found, by total waypoints -- not the first. A run of
 * rebuilds can leave several keys behind, and iteration order could otherwise
 * hand back an abandoned two-point stub while the real work sat in the next key
 * along. Recovery is reported rather than silent: on the exact screen where
 * someone is checking whether their work survived, a silent recovery and a loss
 * look identical.
 */
export function loadRoutes(storage, keys) {
  const current = readJSON(storage, keys.routes, []);
  if (Array.isArray(current) && current.length) return { routes: current, recoveredFrom: null };

  let best = [], bestKey = null, bestPoints = 0;
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (!k || k === keys.routes) continue;
    if (!k.startsWith(`${keys.routePrefix}:`) || !k.endsWith(ROUTE_SUFFIX)) continue;
    const found = normaliseRoutes(readJSON(storage, k, []));
    const points = found.reduce((n, r) => n + r.waypoints.length, 0);
    if (points > bestPoints) { best = found; bestKey = k; bestPoints = points; }
  }
  if (!bestPoints) return { routes: [], recoveredFrom: null };
  // Re-home immediately, so the next rebuild cannot orphan the same work twice.
  storage.setItem(keys.routes, JSON.stringify(best));
  return { routes: best, recoveredFrom: bestKey };
}

/** Accept both the current shape and a bare list of waypoints from older files. */
export function normaliseRoutes(value) {
  if (!Array.isArray(value) || !value.length) return [];
  if (Array.isArray(value[0]) && value[0].length === 2 && typeof value[0][0] === 'number') {
    return [{ id: 'route_1', name: 'Route 1', waypoints: value }];
  }
  return value
    .filter((r) => r && Array.isArray(r.waypoints))
    .map((r, i) => ({
      id: r.id || `route_${i + 1}`,
      name: r.name || `Route ${i + 1}`,
      waypoints: r.waypoints.filter(
        (w) => Array.isArray(w) && w.length >= 2 && Number.isFinite(w[0]) && Number.isFinite(w[1])
      ).map((w) => [w[0], w[1]]),
    }));
}

/** Every meshmark key for one scene, for a clear-all that leaves other scenes alone. */
export function sceneKeys(storage, scene) {
  const out = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(`${PREFIX}:${scene}:`)) out.push(k);
  }
  return out;
}
