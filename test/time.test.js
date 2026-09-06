// Plan §9. Not comprehensive — these are the cases that would silently corrupt
// data rather than throw, which is the only kind of bug worth a test here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derive, bucketFor, localWeekday, isValidTimeZone, localParts, fromLocal,
  assertTimeZoneSupport, streakDays, DAY_MS,
} from '../worker/lib/time.js';

const LA = 'America/Los_Angeles';
const IST = 'Asia/Kolkata';
const NY = 'America/New_York';

// A local wall-clock time in a zone, as epoch ms. Written the long way (search
// the instant that formats to the wanted local time) so the fixtures below are
// not built on the same offset assumptions they are meant to test.
function atLocal(tz, y, mo, d, h, mi = 0) {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess)).reduce((a, x) => (x.type !== 'literal' && (a[x.type] = +x.value), a), {});
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const want = Date.UTC(y, mo - 1, d, h, mi);
    if (got === want) return guess;
    guess -= got - want;
  }
  return guess;
}

test('runtime has full ICU', () => {
  assert.doesNotThrow(assertTimeZoneSupport);
});

test('an event at 01:30 local lands on the previous logical day', () => {
  const t = atLocal(IST, 2026, 6, 15, 1, 30);
  const d = derive(t, IST);
  assert.equal(d.logical_day, '2026-06-14');
  assert.equal(d.local_hour, 1);
  assert.equal(d.bucket, 'late');
});

test('04:00 local is the first moment of the new logical day', () => {
  assert.equal(derive(atLocal(IST, 2026, 6, 15, 3, 59), IST).logical_day, '2026-06-14');
  assert.equal(derive(atLocal(IST, 2026, 6, 15, 4, 0), IST).logical_day, '2026-06-15');
});

test('logical day borrows across a month and a year boundary', () => {
  assert.equal(derive(atLocal(IST, 2026, 3, 1, 2, 0), IST).logical_day, '2026-02-28');
  assert.equal(derive(atLocal(IST, 2028, 3, 1, 2, 0), IST).logical_day, '2028-02-29'); // leap
  assert.equal(derive(atLocal(IST, 2026, 1, 1, 2, 0), IST).logical_day, '2025-12-31');
});

// DST spring-forward: 2026-03-08, America/Los_Angeles, 02:00 PST → 03:00 PDT.
// This is the case that rules out shifting the instant instead of the wall clock:
// four elapsed hours before 04:30 PDT is 23:30 PST on the 7th, which would file a
// plainly-after-the-boundary event under the previous day.
test('DST spring-forward: the 04:00–05:00 window stays on the new logical day', () => {
  for (const [h, mi] of [[4, 0], [4, 30], [4, 59], [5, 0]]) {
    const d = derive(atLocal(LA, 2026, 3, 8, h, mi), LA);
    assert.equal(d.logical_day, '2026-03-08', `${h}:${mi} should be 03-08`);
    assert.equal(d.local_hour, h);
  }
  // ...and 01:30 PST, before the skipped hour, is still the previous day.
  assert.equal(derive(atLocal(LA, 2026, 3, 8, 1, 30), LA).logical_day, '2026-03-07');
});

// DST fall-back: 2026-11-01, 02:00 PDT → 01:00 PST. 01:30 local happens twice;
// both instants are before the boundary, so both belong to the previous day.
test('DST fall-back: both 01:30s land on the previous logical day', () => {
  const firstUtc = Date.UTC(2026, 10, 1, 8, 30);   // 01:30 PDT (UTC-7)
  const secondUtc = Date.UTC(2026, 10, 1, 9, 30);  // 01:30 PST (UTC-8)
  for (const t of [firstUtc, secondUtc]) {
    const d = derive(t, LA);
    assert.equal(d.local_hour, 1);
    assert.equal(d.logical_day, '2026-10-31');
  }
});

test('half-hour offset with no DST (Asia/Kolkata) derives the right local hour', () => {
  // 18:15 UTC is 23:45 IST — same calendar day, and 'late' rather than 'evening'.
  const d = derive(Date.UTC(2026, 5, 15, 18, 15), IST);
  assert.equal(d.local_hour, 23);
  assert.equal(d.bucket, 'late');
  assert.equal(d.logical_day, '2026-06-15');
  // 20:00 UTC is 01:30 IST the next calendar day, but the previous logical day.
  const d2 = derive(Date.UTC(2026, 5, 15, 20, 0), IST);
  assert.equal(d2.local_hour, 1);
  assert.equal(d2.logical_day, '2026-06-15');
});

test('the same instant buckets identically in IST and EST — 23:00 is 23:00', () => {
  const ist = derive(atLocal(IST, 2026, 6, 15, 23, 0), IST);
  const ny = derive(atLocal(NY, 2026, 6, 15, 23, 0), NY);
  assert.equal(ist.local_hour, ny.local_hour);
  assert.equal(ist.bucket, ny.bucket);
  assert.equal(ist.bucket, 'late');
});

test('bucket boundaries', () => {
  const cases = [[0, 'late'], [3, 'late'], [4, 'morning'], [11, 'morning'],
                 [12, 'afternoon'], [16, 'afternoon'], [17, 'evening'],
                 [21, 'evening'], [22, 'late'], [23, 'late']];
  for (const [h, b] of cases) assert.equal(bucketFor(h), b, `hour ${h}`);
});

test('a non-default boundary hour only moves events in the vacated hour', () => {
  // §9: changing day_boundary_hour 4→3 must reassign exactly the 03:00–03:59 events.
  for (let h = 0; h < 24; h++) {
    const t = atLocal(IST, 2026, 6, 15, h, 30);
    const at4 = derive(t, IST, 4).logical_day;
    const at3 = derive(t, IST, 3).logical_day;
    if (h === 3) assert.notEqual(at3, at4, 'hour 3 must move');
    else assert.equal(at3, at4, `hour ${h} must not move`);
  }
});

test('localWeekday is the weekday in the event zone, not UTC', () => {
  // 2026-06-15 is a Monday. 20:00 UTC is already Tuesday in IST.
  assert.equal(localWeekday(Date.UTC(2026, 5, 15, 20, 0), IST), 2);
  assert.equal(localWeekday(Date.UTC(2026, 5, 15, 20, 0), LA), 1);
});

test('isValidTimeZone rejects offsets and nonsense', () => {
  assert.ok(isValidTimeZone(IST));
  assert.ok(isValidTimeZone(LA));
  assert.equal(isValidTimeZone('+05:30'), false);
  assert.equal(isValidTimeZone('UTC'), false);      // an app that stores 'UTC' has lost the zone
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(null), false);
});

// ── fromLocal: the inverse phase 2 arms alarms with ─────────────────────────

test('fromLocal round-trips through localParts in every zone', () => {
  for (const tz of [IST, LA, NY, 'Australia/Eucla', 'Pacific/Chatham']) {
    for (const [mo, d, h, mi] of [[1, 15, 0, 0], [6, 15, 21, 14], [11, 3, 23, 59], [3, 8, 12, 30]]) {
      const t = fromLocal(tz, 2026, mo, d, h, mi);
      const p = localParts(t, tz);
      assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [2026, mo, d, h, mi],
        `${tz} ${mo}/${d} ${h}:${mi}`);
    }
  }
});

test('fromLocal normalises out-of-range fields like Date.UTC does', () => {
  // Hour 25 is 01:00 the next day — the seed generator relies on this to place
  // a late-night urge that spills past midnight.
  assert.equal(fromLocal(IST, 2026, 6, 15, 25, 0), fromLocal(IST, 2026, 6, 16, 1, 0));
  assert.equal(fromLocal(IST, 2026, 12, 32, 9, 0), fromLocal(IST, 2027, 1, 1, 9, 0));
});

test('fromLocal on a DST fall-back hour lands on a real instant reading that time', () => {
  // 01:30 exists twice on 2026-11-01 in LA; either answer is correct, so long
  // as it is an instant that actually reads 01:30 there.
  const t = fromLocal(LA, 2026, 11, 1, 1, 30);
  const p = localParts(t, LA);
  assert.deepEqual([p.month, p.day, p.hour, p.minute], [11, 1, 1, 30]);
});

test('fromLocal on the skipped spring-forward hour resolves past the jump', () => {
  // 02:30 does not exist on 2026-03-08 in LA. The answer must still be the
  // instant at the transition, not something hours away.
  const t = fromLocal(LA, 2026, 3, 8, 2, 30);
  const p = localParts(t, LA);
  assert.equal(p.day, 8);
  assert.ok(p.hour === 3 || p.hour === 1, `landed at ${p.hour}:${p.minute}`);
  const jump = Date.UTC(2026, 2, 8, 10, 0);   // 02:00 PST → 03:00 PDT
  assert.ok(Math.abs(t - jump) <= 60 * 60 * 1000, 'within an hour of the transition');
});

test('a jittered 21:00 target never crosses the 04:00 logical-day boundary', () => {
  // The phase 2 constraint, as a property of fromLocal + derive rather than of
  // the scheduler that does not exist yet.
  for (let offset = -25; offset <= 25; offset++) {
    const t = fromLocal(IST, 2026, 6, 15, 21, offset);
    assert.equal(derive(t, IST).logical_day, '2026-06-15', `offset ${offset}`);
  }
});

// ── Streak: elapsed time, immune to date-line crossings (plan §3) ────────────

test('streak is elapsed time, not a count of calendar days', () => {
  const relapse = Date.UTC(2026, 5, 1, 12, 0);
  assert.equal(streakDays(relapse, relapse + 41.9 * DAY_MS), 41);
  assert.equal(streakDays(relapse, relapse + 42 * DAY_MS), 42);
  assert.equal(streakDays(null, Date.now()), null);
  assert.equal(streakDays(relapse, relapse - 1000), 0);   // clock skew never goes negative
});

test('streak is unaffected by an SFO→BLR flight that skips a calendar day', () => {
  // Depart 2026-06-01 ~13:00 PDT, land 2026-06-03 ~00:00 IST: ~24h in the air,
  // but the local calendar advances by two dates. Day-counting would read 2.
  const relapse = atLocal(LA, 2026, 6, 1, 12, 0);
  const landed = atLocal(IST, 2026, 6, 3, 0, 30);
  const elapsedHours = (landed - relapse) / 3_600_000;
  assert.ok(elapsedHours >= 24 && elapsedHours < 40, `sanity: ${elapsedHours}h`);
  assert.equal(streakDays(relapse, landed), Math.floor(elapsedHours / 24));
  // The local calendar advanced from Jun 1 to Jun 3 — two dates — over ~one
  // elapsed day. Counting distinct logical_day values would report 2 here.
  assert.equal(streakDays(relapse, landed), 1);
});

test('streak is unaffected by a BLR→SFO flight that crosses 04:00 twice', () => {
  // Depart 2026-06-01 02:00 IST, land 2026-06-01 ~08:00 PDT — the local date
  // does not advance at all, and 04:00 local passes in both zones.
  const relapse = atLocal(IST, 2026, 5, 25, 12, 0);
  const depart = atLocal(IST, 2026, 6, 1, 2, 0);
  const land = atLocal(LA, 2026, 6, 1, 8, 0);
  assert.ok(land > depart, 'sanity: landing is after departure in elapsed time');
  // Monotonic across the crossing: the streak can only go up.
  assert.ok(streakDays(relapse, land) >= streakDays(relapse, depart));
  assert.equal(streakDays(relapse, land), Math.floor((land - relapse) / DAY_MS));
});

test('derive is stable across a tz change for the same instant only in local terms', () => {
  // The same instant read in two zones is a different local hour — that is the
  // point of storing tz, and why charts must never group by UTC hour.
  const t = Date.UTC(2026, 5, 15, 18, 0);
  assert.equal(derive(t, IST).local_hour, 23);
  assert.equal(derive(t, LA).local_hour, 11);
  assert.equal(derive(t, IST).bucket, 'late');
  assert.equal(derive(t, LA).bucket, 'morning');
});
