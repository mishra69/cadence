import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/d1.js';
import { normalizeEvent, insertEvent, listEvents, ValidationError } from '../worker/lib/events.js';
import {
  DEFAULT_SETTINGS, ACTIVITY_FIELDS, getSettings, updateSettings,
} from '../worker/lib/settings.js';
import { DAY_MS } from '../worker/lib/time.js';

const U = 'user-1';
const IST = 'Asia/Kolkata';
const NOW = Date.UTC(2026, 5, 15, 12, 0);   // 17:30 IST
const S = { ...DEFAULT_SETTINGS };

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const urge = (over = {}) => ({
  id: uuid(), kind: 'urge', ts_utc: NOW, tz: IST, intensity: 3,
  context: ['alone', 'phone'], ...over,
});

test('a valid urge normalises with derived time fields', () => {
  const ev = normalizeEvent(urge(), S, NOW);
  assert.equal(ev.logical_day, '2026-06-15');
  assert.equal(ev.local_hour, 17);
  assert.equal(ev.bucket, 'evening');
  assert.equal(ev.context, '["alone","phone"]');   // canonical: sorted, deduped
  assert.equal(ev.recalled, 0);
  assert.equal(ev.created_at, NOW);
});

test('context tags are deduped and sorted so identical sets compare equal', () => {
  const a = normalizeEvent(urge({ context: ['phone', 'alone', 'phone'] }), S, NOW);
  const b = normalizeEvent(urge({ context: ['alone', 'phone'] }), S, NOW);
  assert.equal(a.context, b.context);
});

test('relapse events take the same context and note fields as an urge', () => {
  // The symmetry is what makes the phase 4 distribution contrast possible.
  const ev = normalizeEvent({
    id: uuid(), kind: 'relapse', ts_utc: NOW, tz: IST,
    context: ['tired', 'alone'], note: 'late night',
  }, S, NOW);
  assert.equal(ev.kind, 'relapse');
  assert.equal(ev.context, '["alone","tired"]');
  assert.equal(ev.note, 'late night');
});

test('satisfaction is recorded on a relapse and round-trips', async () => {
  const db = makeDb();
  const ev = normalizeEvent({
    id: uuid(), kind: 'relapse', ts_utc: NOW, tz: IST,
    satisfaction: 2, context: ['tired'],
  }, S, NOW);
  assert.equal(ev.satisfaction, 2);
  await insertEvent(db, U, ev);
  const [row] = await listEvents(db, U, {});
  assert.equal(row.satisfaction, 2);
});

test('satisfaction 0 is a real answer, not a missing one', () => {
  // The whole point of the field is that a relapse can be worth nothing, so 0
  // must survive every falsy check between the sheet and the row.
  const ev = normalizeEvent(
    { id: uuid(), kind: 'relapse', ts_utc: NOW, tz: IST, satisfaction: 0 }, S, NOW);
  assert.equal(ev.satisfaction, 0);
});

test('satisfaction is rejected on anything but a relapse', () => {
  for (const kind of ['urge', 'daily', 'note']) {
    assert.throws(
      () => normalizeEvent({ id: uuid(), kind, ts_utc: NOW, tz: IST, satisfaction: 3 }, S, NOW),
      ValidationError, kind
    );
  }
});

test('satisfaction is bounded 0–5 and integral', () => {
  const bad = v => assert.throws(
    () => normalizeEvent({ id: uuid(), kind: 'relapse', ts_utc: NOW, tz: IST, satisfaction: v }, S, NOW),
    ValidationError, String(v));
  bad(6); bad(-1); bad(2.5); bad('lots');
});

test('an omitted satisfaction stays null rather than defaulting', () => {
  // A relapse logged in two taps must not invent a rating; phase 3 has to be
  // able to tell "not answered" from "answered zero".
  const ev = normalizeEvent({ id: uuid(), kind: 'relapse', ts_utc: NOW, tz: IST }, S, NOW);
  assert.equal(ev.satisfaction, null);
});

test('satisfaction can be paired with the gap it ended', async () => {
  // This is the correlation the field exists for, so the data has to support it:
  // each relapse's satisfaction against the elapsed days since the previous one.
  const db = makeDb();
  const day = n => NOW - n * DAY_MS;
  for (const [ago, sat] of [[40, 4], [25, 3], [5, 1]]) {
    await insertEvent(db, U, normalizeEvent(
      { id: uuid(), kind: 'relapse', ts_utc: day(ago), tz: IST, satisfaction: sat, recalled: true },
      S, NOW));
  }
  const relapses = (await listEvents(db, U, {}))
    .filter(e => e.kind === 'relapse')
    .sort((a, b) => a.ts_utc - b.ts_utc);

  const pairs = relapses.slice(1).map((r, i) => ({
    gap_days: Math.round((r.ts_utc - relapses[i].ts_utc) / DAY_MS),
    satisfaction: r.satisfaction,
  }));
  assert.deepEqual(pairs, [
    { gap_days: 15, satisfaction: 3 },
    { gap_days: 20, satisfaction: 1 },
  ]);
});

test('rejects the things that would quietly corrupt the table', () => {
  const bad = (over, why) => assert.throws(
    () => normalizeEvent(urge(over), S, NOW), ValidationError, why);

  bad({ id: 'not-a-uuid' }, 'id');
  bad({ kind: 'nap' }, 'kind');
  bad({ ts_utc: 'yesterday' }, 'ts_utc');
  bad({ tz: '+05:30' }, 'an offset is not a zone');
  bad({ tz: 'UTC' }, 'UTC means the zone was lost');
  bad({ intensity: 6 }, 'intensity range');
  bad({ intensity: 2.5 }, 'intensity must be integer');
  bad({ context: ['doomscrolling'] }, 'unknown tag');
  bad({ context: 'alone' }, 'context must be an array');
  bad({ ts_utc: NOW + 60 * 60 * 1000 }, 'future');
});

test('intensity is rejected on a non-urge', () => {
  assert.throws(
    () => normalizeEvent({ id: uuid(), kind: 'daily', ts_utc: NOW, tz: IST, intensity: 3 }, S, NOW),
    ValidationError
  );
});

test('a few minutes of phone clock skew is tolerated', () => {
  assert.doesNotThrow(() => normalizeEvent(urge({ ts_utc: NOW + 2 * 60 * 1000 }), S, NOW));
});

test('backfill outside the window is rejected unless recalled', () => {
  const old = NOW - 10 * DAY_MS;
  assert.throws(() => normalizeEvent(urge({ ts_utc: old }), S, NOW), ValidationError);
  const ev = normalizeEvent(urge({ ts_utc: old, recalled: true }), S, NOW);
  assert.equal(ev.recalled, 1);
  // created_at is the server receive time and diverges from ts_utc on a recall —
  // that gap is how phase 4 tells live logs from remembered ones.
  assert.equal(ev.created_at, NOW);
  assert.equal(ev.ts_utc, old);
});

test('inside the backfill window needs no recalled flag', () => {
  assert.doesNotThrow(() => normalizeEvent(urge({ ts_utc: NOW - 2 * DAY_MS }), S, NOW));
});

test('a duplicate id inserts once', async () => {
  const db = makeDb();
  const ev = normalizeEvent(urge(), S, NOW);
  assert.deepEqual(await insertEvent(db, U, ev), { stored: true });
  assert.deepEqual(await insertEvent(db, U, ev), { stored: false });
  const rows = await listEvents(db, U, {});
  assert.equal(rows.length, 1);
});

test('a retried offline flush is safe even after the row was edited elsewhere', async () => {
  const db = makeDb();
  await insertEvent(db, U, normalizeEvent(urge({ id: '00000000-0000-4000-8000-00000000dead' }), S, NOW));
  // Same id, different payload: last-writer-wins would silently rewrite history.
  await insertEvent(db, U, normalizeEvent(
    urge({ id: '00000000-0000-4000-8000-00000000dead', intensity: 5 }), S, NOW));
  const [row] = await listEvents(db, U, {});
  assert.equal(row.intensity, 3, 'the first write stands');
});

test('listEvents filters by logical day and by range, newest first', async () => {
  const db = makeDb();
  const t = h => Date.UTC(2026, 5, 15, h, 0);
  const later = t(22);                          // all four are in the past by now
  for (const h of [2, 8, 14, 20]) {
    await insertEvent(db, U, normalizeEvent(urge({ ts_utc: t(h) }), S, later));
  }
  const all = await listEvents(db, U, {});
  assert.equal(all.length, 4);
  assert.ok(all[0].ts_utc > all[3].ts_utc, 'newest first');

  // 02:00 UTC is 07:30 IST on the 15th; 20:00 UTC is 01:30 IST on the 16th,
  // which is still logical day the 15th.
  const day = await listEvents(db, U, { day: '2026-06-15' });
  assert.equal(day.length, 4);

  const ranged = await listEvents(db, U, { from: t(8), to: t(14) });
  assert.equal(ranged.length, 2);
});

test('another user cannot see my events', async () => {
  const db = makeDb();
  await insertEvent(db, U, normalizeEvent(urge(), S, NOW));
  assert.equal((await listEvents(db, 'someone-else', {})).length, 0);
});

test('context round-trips to an array', async () => {
  const db = makeDb();
  await insertEvent(db, U, normalizeEvent(urge({ context: ['bored'] }), S, NOW));
  await insertEvent(db, U, normalizeEvent(urge({ context: [] }), S, NOW));
  const rows = await listEvents(db, U, {});
  assert.deepEqual(rows.find(r => r.context.length).context, ['bored']);
  assert.deepEqual(rows.find(r => !r.context.length).context, []);
});

test('settings default cleanly and survive a partial patch', async () => {
  const db = makeDb();
  assert.deepEqual(await getSettings(db, U),
                   { user_id: U, ...DEFAULT_SETTINGS, ...ACTIVITY_FIELDS });

  await updateSettings(db, U, { day_boundary_hour: 3 });
  let s = await getSettings(db, U);
  assert.equal(s.day_boundary_hour, 3);
  assert.equal(s.backfill_window_days, DEFAULT_SETTINGS.backfill_window_days);

  await updateSettings(db, U, { backfill_window_days: 7, bogus_column: 1 });
  s = await getSettings(db, U);
  // Activity state is recorded, never patched: a client must not be able to
  // clear its own gap by PATCHing settings.
  await updateSettings(db, U, { pending_gap_start: null, last_seen_at: Date.now() });
  assert.equal((await getSettings(db, U)).last_seen_at, null);
  assert.equal(s.day_boundary_hour, 3, 'the earlier patch is not clobbered');
  assert.equal(s.backfill_window_days, 7);
  assert.equal(s.bogus_column, undefined);
});

test('the day boundary setting reaches the write path', () => {
  const at3am = Date.UTC(2026, 5, 15, 21, 30);   // 03:00 IST on the 16th
  assert.equal(normalizeEvent(urge({ ts_utc: at3am }), { ...S, day_boundary_hour: 4 }, NOW + DAY_MS).logical_day, '2026-06-15');
  assert.equal(normalizeEvent(urge({ ts_utc: at3am }), { ...S, day_boundary_hour: 3 }, NOW + DAY_MS).logical_day, '2026-06-16');
});

test('morning_wood is recorded on a morning check-in', () => {
  const ev = normalizeEvent(
    { id: uuid(), kind: 'morning_check', ts_utc: NOW, tz: IST, morning_wood: 0 }, S, NOW);
  assert.equal(ev.morning_wood, 0, '0 is a real answer, not a missing one');

  // Still accepted on `daily`, which is where every reading written before the
  // two kinds were split lives. Rejecting it would also turn a stale cached
  // client into a 400 for no gain — nothing reads by kind any more.
  assert.equal(
    normalizeEvent({ id: uuid(), kind: 'daily', ts_utc: NOW, tz: IST, morning_wood: 3 }, S, NOW).morning_wood,
    3);

  for (const kind of ['urge', 'relapse', 'note']) {
    assert.throws(
      () => normalizeEvent({ id: uuid(), kind, ts_utc: NOW, tz: IST, morning_wood: 1 }, S, NOW),
      ValidationError, kind);
  }
});

test('a morning check-in is not a confirmation of the day', () => {
  // The whole point of the split. Answering one question at 08:00 used to write
  // `daily`, which is what coverage counts — so a day was marked reviewed
  // before it had happened. Both are still real events; only one confirms.
  const morning = normalizeEvent(
    { id: uuid(), kind: 'morning_check', ts_utc: NOW, tz: IST, morning_wood: 3 }, S, NOW);
  assert.equal(morning.kind, 'morning_check');
  assert.notEqual(morning.kind, 'daily');

  // And it carries `recalled` like any other event, which is how a reading
  // supplied at the nightly sweep stays distinguishable from one given at 8am.
  const late = normalizeEvent(
    { id: uuid(), kind: 'morning_check', ts_utc: NOW, tz: IST, morning_wood: 2, recalled: true },
    S, NOW);
  assert.equal(late.recalled, 1);
});

test('morning_wood is none / mild / strong / don\'t recall, and omitted stays null', () => {
  // Not a count: by check-in time "twice" and "three times" are not reliably
  // distinguishable, so that resolution was noise. Strength is not — it is a
  // property of the one event, not a tally of repeats. 4 means "don't recall",
  // which is an answer and must stay distinct from NULL (never asked).
  //
  // 1 is accepted but never offered: it is the legacy binary "yes" from before
  // strength was asked, kept so the rows carrying it are not relabelled.
  for (const v of [0, 1, 2, 3, 4]) {
    assert.equal(
      normalizeEvent({ id: uuid(), kind: 'daily', ts_utc: NOW, tz: IST, morning_wood: v }, S, NOW).morning_wood,
      v);
  }
  const bad = v => assert.throws(
    () => normalizeEvent({ id: uuid(), kind: 'daily', ts_utc: NOW, tz: IST, morning_wood: v }, S, NOW),
    ValidationError, String(v));
  bad(5); bad(-1); bad(1.5);
  assert.equal(
    normalizeEvent({ id: uuid(), kind: 'daily', ts_utc: NOW, tz: IST }, S, NOW).morning_wood,
    null);
});

test('morning_wood round-trips through the real schema', async () => {
  const db = makeDb();
  await insertEvent(db, U, normalizeEvent(
    { id: uuid(), kind: 'daily', ts_utc: NOW, tz: IST, morning_wood: 1 }, S, NOW));
  const [row] = await listEvents(db, U, {});
  assert.equal(row.morning_wood, 1);
});

test('mode tags are accepted on urges and relapses, rejected on the rest', () => {
  // Urges too: an episode can go down the path without finishing it, and that
  // is also what makes these legitimate inputs to the urge/relapse contrast
  // rather than a tag that only ever appears on one side.
  for (const kind of ['urge', 'relapse']) {
    const ev = normalizeEvent(
      { id: uuid(), kind, ts_utc: NOW, tz: IST, context: ['porn', 'alone'] }, S, NOW);
    assert.equal(ev.context, '["alone","porn"]', kind);
  }

  for (const kind of ['daily', 'note']) {
    assert.throws(
      () => normalizeEvent({ id: uuid(), kind, ts_utc: NOW, tz: IST, context: ['porn'] }, S, NOW),
      ValidationError, kind);
  }
});

test('porn and imagination are independent, not exclusive', () => {
  // Both means both were involved; neither means not answered, which is not the
  // same as "no porn" — the NULL-vs-zero distinction the schema respects.
  const both = normalizeEvent(
    { id: uuid(), kind: 'relapse', ts_utc: NOW, tz: IST, context: ['porn', 'imagination'] }, S, NOW);
  assert.equal(both.context, '["imagination","porn"]');

  const neither = normalizeEvent(
    { id: uuid(), kind: 'relapse', ts_utc: NOW, tz: IST, context: ['alone'] }, S, NOW);
  assert.ok(!neither.context.includes('porn') && !neither.context.includes('imagination'));
});

test('lock intent is a settable preference with no default', async () => {
  const db = makeDb();
  // NULL means never asked, which must stay distinct from having declined.
  assert.equal((await getSettings(db, U)).lock_intent, null);

  await updateSettings(db, U, { lock_intent: 'wanted' });
  assert.equal((await getSettings(db, U)).lock_intent, 'wanted');

  await updateSettings(db, U, { lock_intent: 'declined' });
  assert.equal((await getSettings(db, U)).lock_intent, 'declined');
});

test('lock intent survives an unrelated settings patch', async () => {
  // It is the one piece of lock state a device wipe cannot reach, so it must
  // not be collateral damage from changing something else.
  const db = makeDb();
  await updateSettings(db, U, { lock_intent: 'wanted' });
  await updateSettings(db, U, { day_boundary_hour: 3 });
  const s = await getSettings(db, U);
  assert.equal(s.lock_intent, 'wanted');
  assert.equal(s.day_boundary_hour, 3);
});
