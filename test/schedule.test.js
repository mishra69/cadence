import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  drawTarget, drawMorningTarget, isSaneHour, sendDecision, isMissed, recallBuckets,
  EARLIEST_HOUR, SANE_START_HOUR,
} from '../worker/lib/schedule.js';
import { derive, localParts, fromLocal, DAY_MS } from '../worker/lib/time.js';
import { DEFAULT_SETTINGS } from '../worker/lib/settings.js';

const IST = 'Asia/Kolkata';
const LA = 'America/Los_Angeles';
const S = { ...DEFAULT_SETTINGS };

/** Deterministic RNG so a failure is reproducible. */
function seeded(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

// ── Drawing the target ──────────────────────────────────────────────────────

test('the target lands near the configured hour, in local time', () => {
  const ts = drawTarget('2026-06-15', IST, S, () => 0.5);   // 0.5 → zero jitter
  const p = localParts(ts, IST);
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [2026, 6, 15, 21, 0]);
});

// This is the test §9 asks for by name: it is what catches a scheduler that
// computes the offset at fire time, which can only ever delay and would show up
// here as a one-sided distribution.
test('jitter spans the full ±25 minutes and is not skewed positive', () => {
  const rng = seeded(7);
  const offsets = [];
  for (let i = 0; i < 400; i++) {
    const ts = drawTarget('2026-06-15', IST, S, rng);
    const p = localParts(ts, IST);
    offsets.push((p.hour - S.daily_checkin_hour) * 60 + p.minute);
  }
  const min = Math.min(...offsets);
  const max = Math.max(...offsets);
  const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;

  assert.ok(min <= -20, `should reach well below the hour, got ${min}`);
  assert.ok(max >= 20, `should reach well above the hour, got ${max}`);
  assert.ok(min >= -25 && max <= 25, `must stay inside ±25, got ${min}..${max}`);
  assert.ok(Math.abs(mean) < 4, `must not be one-sided, mean offset ${mean.toFixed(1)}`);

  // And never bunched on a tick boundary — the other half of the same bug.
  const onTick = offsets.filter(o => o === 0 || o === 30 || o === -30).length;
  assert.ok(onTick / offsets.length < 0.15, `clustered on tick boundaries: ${onTick}`);
});

test('the target never crosses the 04:00 logical-day boundary', () => {
  const rng = seeded(3);
  // A deliberately hostile setting: late hour, huge jitter.
  const hostile = { ...S, daily_checkin_hour: 23, daily_jitter_minutes: 90 };
  for (let i = 0; i < 200; i++) {
    for (const day of ['2026-06-15', '2026-03-08', '2026-11-01']) {
      for (const tz of [IST, LA]) {
        const ts = drawTarget(day, tz, hostile, rng);
        assert.equal(derive(ts, tz, hostile.day_boundary_hour).logical_day, day,
          `${day} ${tz} drifted out of its logical day`);
      }
    }
  }
});

test('the target is never earlier than the floor', () => {
  const rng = seeded(11);
  const early = { ...S, daily_checkin_hour: 9, daily_jitter_minutes: 25 };
  for (let i = 0; i < 100; i++) {
    const ts = drawTarget('2026-06-15', IST, early, rng);
    assert.ok(localParts(ts, IST).hour >= EARLIEST_HOUR,
      `landed at ${localParts(ts, IST).hour}, before the ${EARLIEST_HOUR}:00 floor`);
  }
});

test('drawing is deterministic for a given rng, so a persisted target is stable', () => {
  // The planner persists scheduled_for precisely so safety-net ticks don't
  // re-draw it; this pins the property the persistence protects.
  assert.equal(drawTarget('2026-06-15', IST, S, () => 0.31),
               drawTarget('2026-06-15', IST, S, () => 0.31));
});

test('a target drawn across DST spring-forward is still a real local time', () => {
  const ts = drawTarget('2026-03-08', LA, S, () => 0.5);
  const p = localParts(ts, LA);
  assert.equal(p.day, 8);
  assert.equal(p.hour, 21);
});

// ── Sane hours ──────────────────────────────────────────────────────────────

test('sane-hours guard drops the small hours and allows the evening', () => {
  // §9 wants this as a pure function with an injected clock and tz — no flight
  // simulation, which is the entire point of doing it this way.
  const at = (h, m = 0) => fromLocal(IST, 2026, 6, 15, h, m);
  assert.equal(isSaneHour(at(3), IST), false, '03:00 IST must be dropped');
  assert.equal(isSaneHour(at(6, 59), IST), false);
  assert.equal(isSaneHour(at(7), IST), true);
  assert.equal(isSaneHour(at(21), IST), true, '21:00 IST must send');
  assert.equal(isSaneHour(at(23, 59), IST), true);
  assert.equal(isSaneHour(at(0), IST), false);
});

test('the same instant is sane in one zone and not in another', () => {
  // This is the flight, without simulating one: an alarm armed for 21:00
  // Pacific fires at ~09:30 IST the next morning.
  const ts = fromLocal(LA, 2026, 6, 15, 21, 0);
  assert.equal(isSaneHour(ts, LA), true);
  const istHour = localParts(ts, IST).hour;
  assert.equal(isSaneHour(ts, IST), istHour >= 7 && istHour < 24);
});

test('an alarm armed for 21:00 Pacific is dropped if the phone is in IST', () => {
  // Depart after the alarm is armed; 21:00 PDT is 03:30 IST the following day.
  const armedFor = fromLocal(LA, 2026, 6, 15, 15, 0);   // 03:30 IST next day
  assert.equal(localParts(armedFor, IST).hour, 3);
  assert.equal(isSaneHour(armedFor, IST), false);
});

// ── Fire-time decision ──────────────────────────────────────────────────────

const now = fromLocal(IST, 2026, 6, 15, 21, 0);

test('a clean evening send goes out', () => {
  assert.deepEqual(
    sendDecision({ now, tz: IST, lastSentAt: null, sentToday: 0, settings: S }),
    { send: true });
});

test('min_push_gap_minutes suppresses a second push', () => {
  const recent = now - 30 * 60_000;   // 30 min ago, gap is 120
  assert.deepEqual(
    sendDecision({ now, tz: IST, lastSentAt: recent, sentToday: 1, settings: S }),
    { send: false, reason: 'gap' });

  const old = now - 3 * 60 * 60_000;  // 3h ago, clears the gap
  assert.deepEqual(
    sendDecision({ now, tz: IST, lastSentAt: old, sentToday: 1, settings: S }),
    { send: true });
});

test('the daily cap aborts at fire time', () => {
  assert.deepEqual(
    sendDecision({ now, tz: IST, lastSentAt: null, sentToday: S.max_pushes_per_day, settings: S }),
    { send: false, reason: 'cap' });
});

test('an unsane hour beats every other reason', () => {
  // Ordering matters: a 4am push is the one outcome worth preventing, so it is
  // checked before anything that might otherwise allow the send.
  const at4am = fromLocal(IST, 2026, 6, 16, 4, 0);
  assert.deepEqual(
    sendDecision({ now: at4am, tz: IST, lastSentAt: null, sentToday: 0, settings: S }),
    { send: false, reason: 'unsane_hour' });
});

// ── Missed alarms ───────────────────────────────────────────────────────────

const row = (over = {}) => ({
  logical_day: '2026-06-15', scheduled_for: now, sent_at: null, suppressed_reason: null, ...over,
});

test('a passed, unsent target is re-armed rather than skipped', () => {
  assert.equal(isMissed(row(), now + 5 * 60_000, IST, S), true);
});

test('an already-sent or already-suppressed target is left alone', () => {
  assert.equal(isMissed(row({ sent_at: now }), now + 60_000, IST, S), false);
  assert.equal(isMissed(row({ suppressed_reason: 'cap' }), now + 60_000, IST, S), false);
});

test('a target still in the future is not missed', () => {
  assert.equal(isMissed(row(), now - 60_000, IST, S), false);
});

test('a missed target is abandoned once its logical day has rolled over', () => {
  // A check-in delivered the next afternoon is worse than none.
  const tomorrow = fromLocal(IST, 2026, 6, 16, 14, 0);
  assert.equal(isMissed(row(), tomorrow, IST, S), false);
});

// ── Recall buckets ──────────────────────────────────────────────────────────

test('the sweep offers only buckets that have already happened', () => {
  const at21 = fromLocal(IST, 2026, 6, 15, 21, 0);
  const ids = recallBuckets('2026-06-15', IST, at21).map(b => b.id);
  // 'late' is 01:00 the following morning — still ahead at a 21:00 sweep, and
  // offering it would invite backfilling something that hasn't happened.
  assert.deepEqual(ids, ['morning', 'afternoon', 'evening']);
});

test('a sweep opened after midnight can still backfill late night', () => {
  const at2am = fromLocal(IST, 2026, 6, 16, 2, 0);
  const ids = recallBuckets('2026-06-15', IST, at2am).map(b => b.id);
  assert.deepEqual(ids, ['morning', 'afternoon', 'evening', 'late']);
});

test('a sweep opened in the morning offers only the morning', () => {
  const at9 = fromLocal(IST, 2026, 6, 15, 9, 0);
  assert.deepEqual(recallBuckets('2026-06-15', IST, at9).map(b => b.id), ['morning']);
});

test('every bucket midpoint derives back to the logical day it belongs to', () => {
  const at2am = fromLocal(IST, 2026, 6, 16, 2, 0);
  for (const b of recallBuckets('2026-06-15', IST, at2am)) {
    assert.equal(derive(b.ts, IST).logical_day, '2026-06-15', b.id);
  }
});

test('bucket midpoints are never in the future, so the write path accepts them', () => {
  for (const hour of [5, 9, 13, 18, 21, 23]) {
    const at = fromLocal(IST, 2026, 6, 15, hour, 0);
    for (const b of recallBuckets('2026-06-15', IST, at)) {
      assert.ok(b.ts <= at, `${b.id} is ahead of a ${hour}:00 sweep`);
    }
  }
});

// ── The morning marker ──────────────────────────────────────────────────────

test('the morning target lands near the configured hour', () => {
  const S10 = { ...S, morning_checkin_hour: 10 };
  const p = localParts(drawMorningTarget('2026-06-15', IST, S10, () => 0.5), IST);
  assert.deepEqual([p.day, p.hour, p.minute], [15, 10, 0]);
});

test('morning jitter is tighter than the evening window', () => {
  // "Did this happen this morning" gets ambiguous as the prompt drifts toward
  // noon, so the spread is deliberately narrower than the check-in's ±25.
  const rng = seeded(5);
  const S10 = { ...S, morning_checkin_hour: 10 };
  const offsets = [];
  for (let i = 0; i < 200; i++) {
    const p = localParts(drawMorningTarget('2026-06-15', IST, S10, rng), IST);
    offsets.push((p.hour - 10) * 60 + p.minute);
  }
  assert.ok(Math.min(...offsets) >= -15, `min ${Math.min(...offsets)}`);
  assert.ok(Math.max(...offsets) <= 15, `max ${Math.max(...offsets)}`);
  assert.ok(Math.abs(offsets.reduce((a, b) => a + b, 0) / offsets.length) < 3, 'not one-sided');
});

test('the morning target never lands before the sane-hours floor', () => {
  // A marker prompt at 06:00 is exactly what the guard exists to prevent, and
  // an early configured hour must not sneak under it.
  const early = { ...S, morning_checkin_hour: 5 };
  const rng = seeded(9);
  for (let i = 0; i < 50; i++) {
    const p = localParts(drawMorningTarget('2026-06-15', IST, early, rng), IST);
    assert.ok(p.hour >= SANE_START_HOUR, `landed at ${p.hour}`);
  }
});

test('morning and evening targets stay far enough apart for the push gap', () => {
  const both = { ...S, morning_checkin_hour: 10, daily_checkin_hour: 21 };
  const rng = seeded(2);
  for (let i = 0; i < 100; i++) {
    const gapMinutes =
      (drawTarget('2026-06-15', IST, both, rng) - drawMorningTarget('2026-06-15', IST, both, rng))
      / 60_000;
    assert.ok(gapMinutes > both.min_push_gap_minutes,
      `only ${Math.round(gapMinutes)} min apart, gap is ${both.min_push_gap_minutes}`);
  }
});
