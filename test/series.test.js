import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollingRelapses, dayRibbon } from '../worker/lib/series.js';
import { fromLocal, DAY_MS } from '../worker/lib/time.js';
import { DEFAULT_SETTINGS } from '../worker/lib/settings.js';

const IST = 'Asia/Kolkata';
const S = { ...DEFAULT_SETTINGS };
// Midday so nothing sits near the 04:00 boundary by accident.
const NOW = fromLocal(IST, 2026, 9, 3, 12, 0);
const at = (daysAgo, hour = 12) => NOW - daysAgo * DAY_MS + (hour - 12) * 3_600_000;
const ev = (daysAgo, kind, hour = 12) => ({ kind, ts_utc: at(daysAgo, hour) });

// ── Rolling relapses ────────────────────────────────────────────────────────

test('the 7-day series counts a trailing window, per day', () => {
  // 40 days of history so the window is fully inside it.
  const events = [ev(40, 'daily'), ev(0, 'relapse'), ev(1, 'relapse'), ev(3, 'relapse'), ev(20, 'relapse')];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 30 });
  const last = s[s.length - 1];
  assert.equal(last.day, '2026-09-03');
  assert.equal(last.per_week_7d, 3, 'three of the four fall inside the last 7 days');
  assert.equal(last.relapses, 1, 'and one of those was today');
});

test('both series share a unit so they can share an axis', () => {
  // A 7-day count against a 30-day count is two scales on one chart — the
  // canonical charting mistake. Expressing the 30-day window *per week* puts
  // them on the same axis, where the comparison is honest.
  const events = [ev(80, 'daily'), ...Array.from({ length: 12 }, (_, i) => ev(i * 5, 'relapse'))];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 70 });
  const withBoth = s.filter(p => p.per_week_30d != null);
  assert.ok(withBoth.length > 0);
  for (const p of withBoth) assert.ok(p.per_week_30d >= 0 && p.per_week_30d <= 7, `${p.day}`);
});

// The bug this pins: before tracking began, a count of zero is not a low rate.
// Drawing it as a flat line along zero states something untrue, confidently, for
// as far back as the chart reaches.
test('neither series draws before its window fits inside real history', () => {
  const events = [ev(5, 'daily'), ev(2, 'relapse')];   // history begins 5 days ago
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 60 });

  assert.ok(s.every(p => p.per_week_7d === null),
    'a 7-day window needs 7 days of history behind it');
  assert.ok(s.every(p => p.per_week_30d === null));
  assert.ok(s.every(p => p.coverage_7d === null));
});

test('the 7-day series begins exactly a week after tracking starts', () => {
  const events = [ev(20, 'daily'), ev(3, 'relapse')];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 40 });
  const drawn = s.filter(p => p.per_week_7d != null);
  // Day -20 through today is 21 days of history; the first 6 are withheld.
  assert.equal(drawn.length, 15);
  assert.ok(s.slice(0, s.length - 15).every(p => p.per_week_7d === null));
});

test('the 30-day series appears later than the 7-day one', () => {
  const events = [ev(60, 'daily'), ...Array.from({ length: 10 }, (_, i) => ev(i * 6, 'relapse'))];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 60 });
  const first7 = s.findIndex(p => p.per_week_7d != null);
  const first30 = s.findIndex(p => p.per_week_30d != null);
  assert.ok(first7 >= 0 && first30 > first7, `7d at ${first7}, 30d at ${first30}`);
});

// The other half of the same hazard: a week you did not log produces a genuine
// zero, indistinguishable from a good week unless coverage travels with it.
test('coverage reports how much of the window was actually logged', () => {
  const events = [
    ev(30, 'daily'),
    ...[0, 1, 2, 3, 4, 5, 6].map(d => ev(d, 'daily')),   // every day of the last week
  ];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 30 });
  assert.equal(s[s.length - 1].coverage_7d, 1, 'a fully logged week');

  const sparse = rollingRelapses({
    events: [ev(30, 'daily'), ev(0, 'daily')],
    tz: IST, settings: S, now: NOW, days: 30,
  });
  const lastSparse = sparse[sparse.length - 1];
  assert.equal(lastSparse.per_week_7d, 0, 'zero slips counted');
  assert.ok(lastSparse.coverage_7d < 0.2,
    'but almost nothing was logged, so that zero is a floor not a measurement');
});

test('an empty history draws nothing at all', () => {
  const s = rollingRelapses({ events: [], tz: IST, settings: S, now: NOW, days: 14 });
  assert.equal(s.length, 14);
  assert.ok(s.every(p => p.per_week_7d === null && p.per_week_30d === null));
});

test('endDay pages the window backwards', () => {
  const events = [ev(90, 'daily'), ev(45, 'relapse')];
  const s = rollingRelapses({
    events, tz: IST, settings: S, now: NOW, days: 30, endDay: '2026-08-04',
  });
  assert.equal(s[s.length - 1].day, '2026-08-04');
  assert.equal(s[0].day, '2026-07-06');
});

// ── Day ribbon ──────────────────────────────────────────────────────────────

test('the grid is whole weeks, so every row is full', () => {
  for (const days of [30, 45, 60, 63]) {
    const r = dayRibbon({ events: [], tz: IST, settings: S, now: NOW, days });
    assert.equal(r.length % 7, 0, `${days} days produced ${r.length} cells`);
  }
});

test('every column is the same weekday', () => {
  const r = dayRibbon({ events: [], tz: IST, settings: S, now: NOW, days: 63 });
  for (let col = 0; col < 7; col++) {
    const weekdays = new Set();
    for (let i = col; i < r.length; i += 7) {
      weekdays.add(new Date(`${r[i].day}T00:00:00Z`).getUTCDay());
    }
    assert.equal(weekdays.size, 1, `column ${col} mixes weekdays`);
  }
});

test('padding days are marked so they are drawn as absent, not as data', () => {
  const r = dayRibbon({ events: [], tz: IST, settings: S, now: NOW, days: 30 });
  const pads = r.filter(d => d.outside);
  assert.ok(pads.length > 0, 'a 30-day window rarely lands on week boundaries');
  assert.ok(pads.every(d => d.state === 'pad'));
});

test('two slips in a day are not drawn the same as one', () => {
  const r = dayRibbon({
    events: [ev(1, 'relapse', 9), ev(1, 'relapse', 22)],
    tz: IST, settings: S, now: NOW, days: 14,
  });
  const d = r.find(x => x.count > 0);
  assert.equal(d.count, 2);
  assert.equal(d.state, 'relapse');
});

test('a day with no events is unknown, never clean', () => {
  // The most flattering possible lie: presenting a gap in the record as a run
  // of good days.
  const r = dayRibbon({ events: [ev(0, 'daily')], tz: IST, settings: S, now: NOW, days: 14 });
  const inRange = r.filter(d => !d.outside);
  assert.equal(inRange[inRange.length - 1].state, 'clean');
  assert.ok(inRange.slice(0, -1).every(d => d.state === 'unknown'));
});

test('confirmation is tracked separately from what happened', () => {
  const r = dayRibbon({ events: [ev(0, 'urge')], tz: IST, settings: S, now: NOW, days: 14 });
  const today = r.filter(d => !d.outside).pop();
  assert.equal(today.state, 'clean', 'an urge is not a slip');
  assert.equal(today.confirmed, false, 'but the day was never confirmed');
});

test('an event just after the 04:00 boundary lands on the right day', () => {
  // 01:00 belongs to the previous logical day, so the ribbon must not put it a
  // day later than the rest of the app does.
  const justAfterMidnight = { kind: 'relapse', ts_utc: fromLocal(IST, 2026, 9, 3, 1, 0) };
  const r = dayRibbon({ events: [justAfterMidnight], tz: IST, settings: S, now: NOW, days: 14 });
  assert.equal(r.find(d => d.state === 'relapse').day, '2026-09-02');
});

test('future days in the trailing week are padding, not unknown data', () => {
  // The grid runs to the end of the current week, and days that have not
  // happened must not be counted as days with nothing logged.
  const r = dayRibbon({ events: [ev(0, 'daily')], tz: IST, settings: S, now: NOW, days: 63 });
  const future = r.filter(d => d.day > '2026-09-03');
  assert.ok(future.every(d => d.state === 'pad'), 'tomorrow is not a missed day');
});
