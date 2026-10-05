import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/d1.js';
import { getStats, attemptStats } from '../worker/lib/stats.js';
import { normalizeEvent, insertEvent } from '../worker/lib/events.js';
import { DEFAULT_SETTINGS } from '../worker/lib/settings.js';
import { DAY_MS } from '../worker/lib/time.js';

const U = 'user-1';
const IST = 'Asia/Kolkata';
const NOW = Date.UTC(2026, 5, 15, 12, 0);
const S = { ...DEFAULT_SETTINGS };

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

async function add(db, kind, tsUtc, over = {}) {
  const ev = normalizeEvent(
    { id: uuid(), kind, ts_utc: tsUtc, tz: IST, recalled: tsUtc < NOW - 3 * DAY_MS, ...over },
    S, NOW
  );
  await insertEvent(db, U, ev);
  return ev;
}

test('empty database returns sane values, not nulls that crash the UI', async () => {
  const db = makeDb();
  const s = await getStats(db, U, IST, S, NOW);
  assert.equal(s.has_data, false);
  assert.equal(s.streak_days, null);
  assert.equal(s.days_tracked, 0);
  assert.equal(s.confirmed_days, 0);
  assert.equal(s.attempt_count, 0);
  assert.equal(s.median_attempt_days, null);
  assert.equal(s.best_days, null);
  assert.equal(s.relapses_30d, 0);
  assert.equal(s.urges_7d, 0);
  assert.equal(s.resist.per_100, null);
  assert.equal(s.resist.gated_until, 50);
  assert.equal(s.today, '2026-06-15');
});

test('a single urge and no relapse: no streak, but days_tracked is honest', async () => {
  const db = makeDb();
  await add(db, 'urge', NOW - 2 * DAY_MS, { intensity: 2 });
  const s = await getStats(db, U, IST, S, NOW);
  assert.equal(s.has_data, true);
  // Never a relapse on record means there is no streak to report — reporting
  // days_tracked as a streak would invent a number.
  assert.equal(s.streak_days, null);
  assert.equal(s.days_tracked, 2);
  assert.equal(s.attempt_count, 0);
  assert.equal(s.urges_7d, 1);
  assert.equal(s.urges_30d, 1);
});

test('streak is elapsed days since the last relapse', async () => {
  const db = makeDb();
  await add(db, 'relapse', NOW - 42 * DAY_MS - 3600_000);
  await add(db, 'relapse', NOW - 100 * DAY_MS);
  const s = await getStats(db, U, IST, S, NOW);
  assert.equal(s.streak_days, 42);
  assert.equal(s.last_relapse_ts, NOW - 42 * DAY_MS - 3600_000);
});

test('confirmed days counts distinct daily check-ins inside the streak window', async () => {
  const db = makeDb();
  await add(db, 'relapse', NOW - 5 * DAY_MS);
  for (let d = 4; d >= 1; d--) await add(db, 'daily', NOW - d * DAY_MS);
  // Two check-ins on the same logical day count once.
  await add(db, 'daily', NOW - 1 * DAY_MS + 3600_000);
  // A check-in from before the relapse is outside the window.
  await add(db, 'daily', NOW - 9 * DAY_MS);

  const s = await getStats(db, U, IST, S, NOW);
  assert.equal(s.streak_days, 5);
  assert.equal(s.confirmed_days, 4);
  // A 5-day streak touches 6 logical days — the relapse day and today are both
  // partial. Coverage must never read as more confirmed days than days.
  assert.equal(s.coverage_days, 6);
  assert.ok(s.confirmed_days <= s.coverage_days);
});

test('a morning check-in does not confirm the day', async () => {
  // The bug the two kinds were split to fix: answering one question at 08:00
  // wrote `daily` and so marked the whole day reviewed before it had happened.
  // A coverage number that overstates is worse than none — it reads as
  // trustworthy.
  const db = makeDb();
  await add(db, 'relapse', NOW - 5 * DAY_MS);
  for (let d = 4; d >= 1; d--) await add(db, 'morning_check', NOW - d * DAY_MS, { morning_wood: 3 });

  const s = await getStats(db, U, IST, S, NOW);
  assert.equal(s.confirmed_days, 0, 'four mornings answered, no day reviewed');

  // Reviewing two of those days is what moves the number.
  await add(db, 'daily', NOW - 4 * DAY_MS);
  await add(db, 'daily', NOW - 3 * DAY_MS);
  assert.equal((await getStats(db, U, IST, S, NOW)).confirmed_days, 2);
});

test('confirmed days never exceeds the days it is reported against', async () => {
  const db = makeDb();
  await add(db, 'relapse', NOW - 5 * DAY_MS);
  // A check-in on every logical day the window touches, including both partials.
  for (let d = 5; d >= 0; d--) await add(db, 'daily', NOW - d * DAY_MS);
  const s = await getStats(db, U, IST, S, NOW);
  assert.equal(s.confirmed_days, s.coverage_days);
  assert.ok(s.confirmed_days <= s.coverage_days, `${s.confirmed_days} of ${s.coverage_days}`);
});

test('relapses_30d is trailing, so old slips fall out', async () => {
  const db = makeDb();
  await add(db, 'relapse', NOW - 5 * DAY_MS);
  await add(db, 'relapse', NOW - 20 * DAY_MS);
  await add(db, 'relapse', NOW - 40 * DAY_MS);
  const s = await getStats(db, U, IST, S, NOW);
  assert.equal(s.relapses_30d, 2);
});

test('the resist ratio stays hidden until the window has 50 urges', async () => {
  const db = makeDb();
  await add(db, 'relapse', NOW - 10 * DAY_MS);
  for (let i = 0; i < 49; i++) await add(db, 'urge', NOW - (i % 80) * DAY_MS - 1000);
  let s = await getStats(db, U, IST, S, NOW);
  assert.equal(s.resist.per_100, null);
  assert.equal(s.resist.gated_until, 1);

  await add(db, 'urge', NOW - 1000);
  s = await getStats(db, U, IST, S, NOW);
  assert.equal(s.resist.gated_until, 0);
  assert.equal(typeof s.resist.per_100, 'number');
  assert.equal(s.resist.per_100, Math.round((1 / 50) * 1000) / 10);
});

test('urges older than the 90-day window do not count toward the gate', async () => {
  const db = makeDb();
  for (let i = 0; i < 60; i++) await add(db, 'urge', NOW - 100 * DAY_MS - i * 1000);
  const s = await getStats(db, U, IST, S, NOW);
  assert.equal(s.resist.urges_90d, 0);
  assert.equal(s.resist.per_100, null);
});

// ── Attempt spans ───────────────────────────────────────────────────────────

test('attempt lengths are kept exact, and the day fields still floor', () => {
  // The sub-day cadence this exists for: relapses 47 hours apart used to leave
  // this function as "1 day" and nothing could recover the other 23 hours.
  const HOUR = 3_600_000;
  const now = Date.UTC(2026, 5, 15);
  const a = attemptStats([now - 94 * HOUR, now - 47 * HOUR], now);

  assert.equal(a.best_ms, 47 * HOUR, 'exact, to the millisecond');
  assert.equal(a.median_attempt_ms, 47 * HOUR);
  // And the floored fields are unchanged, because the notification's "Day N"
  // framing reads them and wants a whole number of days.
  assert.equal(a.best_days, 1);
  assert.equal(a.median_attempt_days, 1);
});

test('two cadences that floor to the same day count stay distinguishable', () => {
  // 28h and 47h both report "1d". Before the exact fields existed, that made a
  // cycle that had nearly doubled invisible in every number the app showed.
  const HOUR = 3_600_000;
  const now = Date.UTC(2026, 5, 15);
  const tight = attemptStats([now - 56 * HOUR, now - 28 * HOUR], now);
  const loose = attemptStats([now - 94 * HOUR, now - 47 * HOUR], now);

  assert.equal(tight.best_days, loose.best_days, 'identical in days — the old problem');
  assert.notEqual(tight.best_ms, loose.best_ms, 'and separable in ms — the fix');
  assert.equal(tight.best_ms / HOUR, 28);
  assert.equal(loose.best_ms / HOUR, 47);
});

test('getStats carries the streak undivided alongside the day count', async () => {
  const HOUR = 3_600_000;
  const db = makeDb();
  await add(db, 'relapse', NOW - 47 * HOUR);
  const s = await getStats(db, U, IST, S, NOW);
  assert.equal(s.streak_days, 1);
  assert.equal(s.streak_ms, 47 * HOUR);
});

test('no relapse on record leaves every exact field null, not zero', async () => {
  // Zero would render as "0h", which asserts a streak that just ended. Null is
  // the client's signal to show length-of-record instead.
  const db = makeDb();
  const s = await getStats(db, U, IST, S, NOW);
  assert.equal(s.streak_ms, null);
  assert.equal(s.best_ms, null);
  assert.equal(s.median_attempt_ms, null);
});

test('attemptStats excludes both censored spans from the median', () => {
  const now = Date.UTC(2026, 5, 15);
  const d = n => now - n * DAY_MS;
  // Relapses 100, 60, 20 days ago → completed spans of 40 and 40 days.
  const a = attemptStats([d(100), d(60), d(20)], now);
  assert.equal(a.completed_attempts, 2);
  assert.equal(a.median_attempt_days, 40);
  assert.equal(a.attempt_count, 4, '3 relapses closed 3 attempts, 1 is in progress');
  assert.equal(a.best_days, 40);
});

test('the current streak counts as the personal best when it is the longest', () => {
  const now = Date.UTC(2026, 5, 15);
  const d = n => now - n * DAY_MS;
  const a = attemptStats([d(100), d(90)], now);
  assert.equal(a.completed_attempts, 1);
  assert.equal(a.median_attempt_days, 10);
  assert.equal(a.best_days, 90, 'the in-progress span is already the longest');
});

test('one relapse gives an attempt count but no median', () => {
  const now = Date.UTC(2026, 5, 15);
  // The only span is left-censored (tracking began mid-attempt), so its length
  // is a fact about when the app was installed, not about the behaviour.
  const a = attemptStats([now - 7 * DAY_MS], now);
  assert.equal(a.attempt_count, 2);
  assert.equal(a.completed_attempts, 0);
  assert.equal(a.median_attempt_days, null);
  assert.equal(a.best_days, 7);
});

test('median of an even number of spans is the midpoint', () => {
  const now = Date.UTC(2026, 5, 15);
  const d = n => now - n * DAY_MS;
  //         spans:      10        30        20
  const a = attemptStats([d(100), d(90), d(60), d(40)], now);
  assert.deepEqual([a.completed_attempts, a.median_attempt_days], [3, 20]);
  const b = attemptStats([d(100), d(90), d(60)], now);
  assert.equal(b.completed_attempts, 2);
  assert.equal(b.median_attempt_days, 20, '(10 + 30) / 2');
});

test('relapse timestamps out of order still produce correct spans', () => {
  const now = Date.UTC(2026, 5, 15);
  const d = n => now - n * DAY_MS;
  assert.deepEqual(attemptStats([d(60), d(100), d(20)], now),
                   attemptStats([d(100), d(60), d(20)], now));
});

test('stats survive a missing tz header', async () => {
  const db = makeDb();
  await add(db, 'urge', NOW - 1000);
  const s = await getStats(db, U, null, S, NOW);
  assert.equal(s.today, null);
  assert.equal(s.has_data, true);
});

test('stats carries the lock intent, since the warning renders before settings load', async () => {
  const db = makeDb();
  await add(db, 'urge', NOW - 1000);
  assert.equal((await getStats(db, U, IST, S, NOW)).lock_intent, null);
  assert.equal(
    (await getStats(db, U, IST, { ...S, lock_intent: 'wanted' }, NOW)).lock_intent,
    'wanted');
});

test('a release never moves the streak or any attempt figure', async () => {
  // The streak measures the habit, and a release is not the habit.
  const H = 3_600_000;
  const db = makeDb();
  await add(db, 'relapse', NOW - 5 * DAY_MS);
  await add(db, 'relapse', NOW - 3 * DAY_MS);
  const before = await getStats(db, U, IST, S, NOW);

  await add(db, 'release', NOW - 4 * DAY_MS);
  await add(db, 'release', NOW - 1 * DAY_MS);
  await add(db, 'release', NOW - 2 * H);
  const after = await getStats(db, U, IST, S, NOW);

  for (const k of ['streak_days', 'streak_ms', 'best_days', 'best_ms', 'median_attempt_days',
                   'median_attempt_ms', 'attempt_count', 'relapses_30d', 'last_relapse_ts']) {
    assert.equal(after[k], before[k], k);
  }
  assert.equal(after.releases_30d, 3, 'but they are counted, separately');
  assert.equal(before.releases_30d, 0);
});
