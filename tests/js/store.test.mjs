/* The regression this project was started by.
 *
 * In the tool meshmark grew out of, restoring saved work was two lines in the
 * middle of a 900-line application that lived inside a Python string. A commit
 * about routes deleted them. The page went on saying "saved automatically, a
 * refresh does not lose it" while discarding every object annotation on load,
 * and the const those lines defined was still read further down, so each page
 * load also threw a ReferenceError that silently killed the rest of the module.
 *
 * The first test below fails if that happens again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  keysFor, loadSession, saveSession, loadRoutes, normaliseRoutes, sceneKeys, PREFIX,
} from '../../src/meshmark/web/store.js';

/** The parts of the Storage interface this module uses, and no more. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _dump: () => Object.fromEntries(map),
  };
}

test('saved annotations come back on the next load', () => {
  const keys = keysFor('room', 'abc123');
  const storage = fakeStorage();
  const ann = { room_cart_001: { xy: [1.5, -2.25], w: 0.7, d: 0.5, h: 0.95, yaw: 30, status: 'corrected' } };
  const extra = [{ object_id: 'room_cart_001', cls: 'cart', kind: 'added' }];

  saveSession(storage, keys, { ann, extra, routes: [] });
  const back = loadSession(storage, keys);

  assert.deepEqual(back.ann, ann, 'annotations must survive a reload');
  assert.deepEqual(back.extra, extra, 'added objects must survive a reload');
  assert.equal(back.fresh, false, 'a session with saved work is not fresh');
});

test('an empty store is fresh, which is what gates preloading', () => {
  const back = loadSession(fakeStorage(), keysFor('room', 'abc123'));
  assert.deepEqual(back.ann, {});
  assert.deepEqual(back.extra, []);
  assert.equal(back.fresh, true);
});

test('a corrupt entry is ignored, not fatal', () => {
  const keys = keysFor('room', 'abc123');
  const storage = fakeStorage({ [keys.objects]: '{not json', [keys.added]: 'null' });
  const back = loadSession(storage, keys);
  assert.deepEqual(back.ann, {});
  assert.equal(back.fresh, true);
});

test('a stored value of the wrong type does not become the state', () => {
  const keys = keysFor('room', 'abc123');
  const storage = fakeStorage({ [keys.objects]: '[1,2,3]', [keys.added]: '{"a":1}' });
  const back = loadSession(storage, keys);
  assert.deepEqual(back.ann, {}, 'an array must not be used as the annotation map');
  assert.deepEqual(back.extra, [], 'an object must not be used as the added list');
});

test('objects are scoped to the baseline, routes are not', () => {
  const a = keysFor('room', 'aaaaaaaa');
  const b = keysFor('room', 'bbbbbbbb');
  assert.notEqual(a.objects, b.objects, 'moved references must give a clean slate');
  assert.equal(a.routes, b.routes, 'a route is about the floor, not the object list');
});

test('routes orphaned under an older key are recovered, richest first', () => {
  const keys = keysFor('room', 'new');
  // The shape of the real incident: two rebuilds left two stale keys behind, one
  // holding an abandoned stub and one holding the actual work.
  const storage = fakeStorage({
    [`${PREFIX}:room:routes-old-stub:routes`]: JSON.stringify([
      { id: 'route_1', name: 'stub', waypoints: [[0, 0], [1, 0]] },
    ]),
    [`${PREFIX}:room:routes-old-real:routes`]: JSON.stringify([
      { id: 'route_1', name: 'real', waypoints: [[0, 0], [1, 0], [2, 1], [3, 3], [4, 4], [5, 4]] },
    ]),
  });

  const { routes, recoveredFrom } = loadRoutes(storage, keys);

  assert.equal(routes.length, 1);
  assert.equal(routes[0].name, 'real', 'the longest orphan wins, not the first found');
  assert.equal(routes[0].waypoints.length, 6);
  assert.equal(recoveredFrom, `${PREFIX}:room:routes-old-real:routes`,
    'recovery is reported: silent recovery and loss look identical on screen');
  assert.equal(
    storage.getItem(keys.routes),
    JSON.stringify(routes),
    're-homed immediately, so the next rebuild cannot orphan the same work twice'
  );
});

test('a current route is used as-is and nothing is scavenged', () => {
  const keys = keysFor('room', 'new');
  const mine = [{ id: 'route_1', name: 'mine', waypoints: [[0, 0], [1, 1]] }];
  const storage = fakeStorage({
    [keys.routes]: JSON.stringify(mine),
    [`${PREFIX}:room:old:routes`]: JSON.stringify([
      { id: 'route_1', name: 'longer', waypoints: [[0, 0], [1, 0], [2, 0], [3, 0]] },
    ]),
  });
  const { routes, recoveredFrom } = loadRoutes(storage, keys);
  assert.deepEqual(routes, mine);
  assert.equal(recoveredFrom, null);
});

test('a bare waypoint list from an older export becomes one route', () => {
  const routes = normaliseRoutes([[0, 0], [1, 2], [3, 4]]);
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0].waypoints, [[0, 0], [1, 2], [3, 4]]);
});

test('waypoints that are not finite pairs are dropped, not carried', () => {
  const routes = normaliseRoutes([
    { name: 'r', waypoints: [[0, 0], [NaN, 1], ['a', 'b'], [2, 2], null] },
  ]);
  assert.deepEqual(routes[0].waypoints, [[0, 0], [2, 2]]);
});

test('clearing one scene leaves another scene alone', () => {
  const storage = fakeStorage({
    [`${PREFIX}:room:abc:objects`]: '{}',
    [`${PREFIX}:room:routes`]: '[]',
    [`${PREFIX}:other:abc:objects`]: '{}',
    [`${PREFIX}:lang`]: 'zh',
  });
  const mine = sceneKeys(storage, 'room');
  assert.deepEqual(mine.sort(), [`${PREFIX}:room:abc:objects`, `${PREFIX}:room:routes`].sort());
});
