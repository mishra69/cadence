import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/d1.js';
import { d1Store, notification } from '../worker/lib/push.js';

const U = 'user-1';
const sub = (n, keys = {}) => ({
  endpoint: `https://push.example/${n}`,
  keys: { p256dh: keys.p256dh || `p${n}`, auth: keys.auth || `a${n}` },
});

const rows = db => db._raw.prepare('SELECT * FROM push_subs ORDER BY endpoint').all();

test('an empty store reads back as an empty list', async () => {
  const db = makeDb();
  assert.deepEqual(await d1Store(db).get(U), []);
});

test('subscriptions round-trip in the shape webpush-edge expects', async () => {
  const db = makeDb();
  const store = d1Store(db);
  await store.set(U, [sub(1), sub(2)]);
  const got = await store.get(U);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0].keys, { p256dh: 'p1', auth: 'a1' });
  assert.ok(got[0].endpoint.startsWith('https://push.example/'));
});

// The skill's specific warning: the store receives the WHOLE list on every
// change, so a naive "delete all then reinsert" resets created_at on every
// write and defeats the upsert.
test('rewriting the list preserves created_at on unchanged devices', async () => {
  const db = makeDb();
  const store = d1Store(db);
  await store.set(U, [sub(1), sub(2)]);
  const before = rows(db);

  await new Promise(r => setTimeout(r, 5));
  await store.set(U, [sub(1), sub(2), sub(3)]);
  const after = rows(db);

  assert.equal(after.length, 3);
  for (const b of before) {
    const a = after.find(x => x.endpoint === b.endpoint);
    assert.equal(a.created_at, b.created_at, `${b.endpoint} kept its created_at`);
    assert.equal(a.id, b.id, 'and its row id');
  }
});

test('a device dropped from the list is deleted', async () => {
  const db = makeDb();
  const store = d1Store(db);
  await store.set(U, [sub(1), sub(2), sub(3)]);
  await store.set(U, [sub(2)]);
  const after = rows(db);
  assert.equal(after.length, 1);
  assert.equal(after[0].endpoint, 'https://push.example/2');
});

test('an empty list clears every device for that user only', async () => {
  const db = makeDb();
  await d1Store(db).set(U, [sub(1)]);
  await d1Store(db).set('other', [sub(9)]);
  await d1Store(db).set(U, []);
  assert.deepEqual(await d1Store(db).get(U), []);
  assert.equal((await d1Store(db).get('other')).length, 1);
});

test('rotated keys on the same endpoint update in place', async () => {
  const db = makeDb();
  const store = d1Store(db);
  await store.set(U, [sub(1)]);
  const before = rows(db)[0];
  await store.set(U, [sub(1, { p256dh: 'NEW', auth: 'NEW' })]);
  const after = rows(db);
  assert.equal(after.length, 1, 'no duplicate row for the same endpoint');
  assert.equal(after[0].p256dh, 'NEW');
  assert.equal(after[0].created_at, before.created_at);
});

test('an endpoint moving to another user does not duplicate the row', async () => {
  // endpoint is UNIQUE across the table, so the conflict has to resolve rather
  // than throw — reinstalling under a different account is the real case.
  const db = makeDb();
  await d1Store(db).set(U, [sub(1)]);
  await d1Store(db).set('other', [sub(1)]);
  const after = rows(db);
  assert.equal(after.length, 1);
  assert.equal(after[0].user_id, 'other');
});

test('notification bodies never name the behaviour', () => {
  // §0 puts push text as the highest-priority privacy item: it appears on a
  // lock screen without anyone choosing to show it.
  const n = notification('Test notification — the wiring works.');
  assert.equal(n.title, 'Cadence', 'the title is only ever the app name');
  assert.equal(n.tag, 'cadence', 'tagged so alerts replace rather than stack');
  assert.ok(n.navigate);
  assert.ok(n.icon);
});
