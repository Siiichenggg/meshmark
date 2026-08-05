import test from 'node:test';
import assert from 'node:assert/strict';

import { STRINGS, LANGS, missingKeys, translate, translator } from '../../src/meshmark/web/i18n.js';

test('neither language has a gap', () => {
  // A missing key falls back to the other language and looks like a translation
  // nobody got to, which is indistinguishable from a bug. This is the check that
  // makes "bilingual" a fact rather than an intention.
  assert.deepEqual(missingKeys(), {}, 'keys present in one language and not the other');
});

test('both languages exist and neither is empty', () => {
  assert.deepEqual(LANGS.sort(), ['en', 'zh']);
  for (const l of LANGS) assert.ok(Object.keys(STRINGS[l]).length > 40);
});

test('no string was left untranslated by copy-paste', () => {
  // Identical text in both languages is almost always a forgotten translation.
  // The few that are legitimately identical are listed, so adding another is a
  // deliberate act rather than an oversight.
  const allowed = new Set(['view.mode3d']);
  const same = Object.keys(STRINGS.en)
    .filter((k) => STRINGS.en[k] === STRINGS.zh[k] && !allowed.has(k));
  assert.deepEqual(same, [], 'same text in both languages');
});

test('placeholders match between languages', () => {
  const names = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const k of Object.keys(STRINGS.en)) {
    assert.deepEqual(names(STRINGS.zh[k]), names(STRINGS.en[k]),
      `${k}: the two languages take different placeholders`);
  }
});

test('placeholders are filled', () => {
  assert.equal(
    translate('en', 'routes.info', { n: 3, len: '2.56' }),
    '3 waypoints, 2.56 m total (green = start)'
  );
  assert.ok(translate('zh', 'routes.info', { n: 3, len: '2.56' }).includes('2.56'));
});

test('an unknown placeholder is left visible rather than blanked', () => {
  assert.equal(translate('en', 'routes.info', { n: 3 }), '3 waypoints, {len} m total (green = start)');
});

test('an unknown key is loud, not blank', () => {
  // A silently empty string leaves an unlabelled button, which is harder to
  // notice than a marker in the UI.
  assert.equal(translate('en', 'no.such.key'), '⟨no.such.key⟩');
});

test('an unknown language falls back to English rather than throwing', () => {
  assert.equal(translate('fr', 'obj.clear'), STRINGS.en['obj.clear']);
});

test('a bound translator remembers its language', () => {
  const t = translator('zh');
  assert.equal(t.lang, 'zh');
  assert.equal(t('obj.clear'), STRINGS.zh['obj.clear']);
});
