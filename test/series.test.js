import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollingRelapses, dayRibbon, relapseGaps } from '../worker/lib/series.js';
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
  // A 7-day count against a 28-day count is two scales on one chart — the
  // canonical charting mistake. Expressing the long window *per week* puts
  // them on the same axis, where the comparison is honest.
  const events = [ev(80, 'daily'), ...Array.from({ length: 12 }, (_, i) => ev(i * 5, 'relapse'))];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 70 });
  const withBoth = s.filter(p => p.per_week_28d != null);
  assert.ok(withBoth.length > 0);
  for (const p of withBoth) assert.ok(p.per_week_28d >= 0 && p.per_week_28d <= 7, `${p.day}`);
});

test('the smoothed window is whole weeks, so a weekly rhythm cannot ripple it', () => {
  // This is the reason the window is 28 and not 30, and it is the assertion
  // that should fail if anyone changes it back.
  //
  // 30 days spans 4.29 weeks, so it holds some weekdays five times and others
  // four, and which ones rotates as it slides. Fed a signal whose true rate
  // never changes, a 30-day window still wobbles — on this exact input it ran
  // 1.9 to 2.3, a 20% swing invented from nothing. Four whole weeks cannot:
  // every weekday is inside it exactly four times, always.
  const weeks = 14;
  const events = [ev(weeks * 7, 'daily')];
  // Two relapses every Monday and none otherwise: a hard weekly shape on a
  // dead-constant 2.0/week rate. The rhythm has to start on the very first day
  // of history — begin it a week late and the earliest windows are short by one
  // Monday, which looks exactly like the ripple this test is hunting for.
  for (let d = weeks * 7; d >= 0; d -= 7) events.push(ev(d, 'relapse'), ev(d, 'relapse', 13));

  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: weeks * 7 });
  const smoothed = s.filter(p => p.per_week_28d != null).map(p => p.per_week_28d);

  assert.ok(smoothed.length > 14, 'enough points to see a ripple if there were one');
  assert.deepEqual([...new Set(smoothed)], [2],
    `a constant rate must draw a constant line; got ${[...new Set(smoothed)].join(', ')}`);
});

test('the smoothed value is the count divided by four, exactly', () => {
  // 28 days is four weeks, so the conversion to "per week" is a clean divide
  // rather than the old x7/30, which was inexact and hidden by the rounding.
  const events = [ev(60, 'daily'), ...Array.from({ length: 6 }, (_, i) => ev(i * 4, 'relapse'))];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 60 });
  const last = s[s.length - 1];
  // All six fall inside the trailing 28 days.
  assert.equal(last.per_week_28d, 6 / 4);
});

// The bug this pins: before tracking began, a count of zero is not a low rate.
// Drawing it as a flat line along zero states something untrue, confidently, for
// as far back as the chart reaches.
test('neither series draws before its window fits inside real history', () => {
  const events = [ev(5, 'daily'), ev(2, 'relapse')];   // history begins 5 days ago
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 60 });

  assert.ok(s.every(p => p.per_week_7d === null),
    'a 7-day window needs 7 days of history behind it');
  assert.ok(s.every(p => p.per_week_28d === null));
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

test('the smoothed series appears later than the 7-day one', () => {
  const events = [ev(60, 'daily'), ...Array.from({ length: 10 }, (_, i) => ev(i * 6, 'relapse'))];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 60 });
  const first7 = s.findIndex(p => p.per_week_7d != null);
  const first28 = s.findIndex(p => p.per_week_28d != null);
  assert.ok(first7 >= 0 && first28 > first7, `7d at ${first7}, 28d at ${first28}`);
});

// The other half of the same hazard: a week you did not log produces a genuine
test('blue means reviewed: nothing short of the evening review declares no slip', () => {
  // A morning check-in at 09:00 used to turn the day blue before it had
  // happened. So would an urge at 15:00. Each shows presence, not how the day
  // ended — only the review says that.
  const cell = events => dayRibbon({ events, tz: IST, settings: S, now: NOW, days: 14 })
    .find(c => c.day === '2026-09-03');

  for (const kind of ['morning_check', 'urge', 'note']) {
    const c = cell([ev(0, kind, kind === 'morning_check' ? 9 : 15)]);
    assert.equal(c.state, 'unknown', `${kind}: grey, not blue`);
    assert.equal(c.logged, true, `${kind}: but outlined — something was recorded`);
  }

  const reviewed = cell([ev(0, 'morning_check', 9), ev(0, 'daily', 21)]);
  assert.equal(reviewed.state, 'clean');
  assert.equal(reviewed.logged, false, 'blue already says more than the outline would');

  const slip = cell([ev(0, 'morning_check', 9), ev(0, 'relapse', 15)]);
  assert.equal(slip.state, 'relapse', 'a slip is a slip, reviewed or not');
  assert.equal(slip.logged, false);

  const empty = cell([ev(5, 'daily')]);
  assert.equal(empty.state, 'unknown');
  assert.equal(empty.logged, false, 'nothing recorded, no outline');
});

test('the outline only ever lands on grey', () => {
  // If it could appear on a coloured cell it would be redundant there — every
  // coloured day has something recorded — and stop carrying information.
  const events = [];
  for (let d = 0; d < 20; d++) {
    if (d % 4 === 0) events.push(ev(d, 'relapse'));
    if (d % 3 === 0) events.push(ev(d, 'daily'));
    if (d % 2 === 0) events.push(ev(d, 'urge'));
    events.push(ev(d, 'morning_check', 9));
  }
  const r = dayRibbon({ events, tz: IST, settings: S, now: NOW, days: 21 });
  assert.ok(r.some(c => c.logged), 'the case is exercised');
  assert.ok(r.filter(c => c.logged).every(c => c.state === 'unknown'));
});

test('coverage does not count a morning check-in as the day being logged', () => {
  // Same question as the ribbon, asked of the 7-day count: how far can the app
  // vouch for a zero? A week of breakfast taps says nothing about the week, so
  // the line should fade exactly as it would for a week not logged at all.
  const mornings = rollingRelapses({
    events: [ev(30, 'daily'), ...[0, 1, 2, 3, 4, 5, 6].map(d => ev(d, 'morning_check', 9))],
    tz: IST, settings: S, now: NOW, days: 30,
  });
  assert.equal(mornings[mornings.length - 1].coverage_7d, 0);

  const reviewed = rollingRelapses({
    events: [ev(30, 'daily'), ...[0, 1, 2, 3, 4, 5, 6].map(d => ev(d, 'daily'))],
    tz: IST, settings: S, now: NOW, days: 30,
  });
  assert.equal(reviewed[reviewed.length - 1].coverage_7d, 1);
});

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
  assert.ok(s.every(p => p.per_week_7d === null && p.per_week_28d === null));
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

test('only days that have not happened yet are drawn as absent', () => {
  const r = dayRibbon({ events: [], tz: IST, settings: S, now: NOW, days: 30 });
  const today = '2026-09-03';   // NOW's logical day
  const pads = r.filter(d => d.state === 'pad');
  assert.ok(pads.length > 0, 'the test clock sits mid-week, so the week has a tail');
  assert.ok(pads.every(d => d.day > today), 'a past day is never absent');
  // The days the week alignment pulls in are real days, and drawing them as
  // absent is what left the grid ragged down its left edge.
  assert.ok(r.filter(d => d.outside && d.day <= today).every(d => d.state !== 'pad'));
});

test('the grid has no holes before today', () => {
  const r = dayRibbon({ events: [], tz: IST, settings: S, now: NOW, days: 63 });
  const upToToday = r.filter(d => !d.future);
  // Every cell from the grid's first day through today carries a real state,
  // so every column left of the current week is full top to bottom.
  assert.ok(upToToday.every(d => ['unknown', 'clean', 'relapse'].includes(d.state)));
  assert.equal(upToToday[0].day, r[0].day, 'the grid starts on a real day, not a pad');
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
  assert.notEqual(today.state, 'relapse', 'an urge is not a slip');
  assert.equal(today.state, 'unknown', 'nor, unreviewed, a declared clean day');
  assert.equal(today.confirmed, false);
  assert.equal(today.logged, true);
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

// ── Gaps between relapses ───────────────────────────────────────────────────

const H = 3_600_000;
const rAt = ts => ({ kind: 'relapse', ts_utc: ts });

test('each gap is measured to the millisecond, not floored to days', () => {
  const t = NOW - 5 * DAY_MS;
  const events = [rAt(t), rAt(t + 28 * H), rAt(t + 28 * H + 47 * H)];
  const { gaps } = relapseGaps({ events, tz: IST, settings: S, now: NOW });
  const done = gaps.filter(g => !g.in_progress);
  assert.deepEqual(done.map(g => g.ms / H), [28, 47], 'two cadences that both used to read "1d"');
});

test('the attempt still running is included, and marked as such', () => {
  // A lower bound that is still growing. Drawn like a finished gap it would
  // understate the attempt in a way that looks final.
  const t = NOW - 10 * H;
  const { gaps } = relapseGaps({ events: [rAt(t - 30 * H), rAt(t)], tz: IST, settings: S, now: NOW });
  const live = gaps.at(-1);
  assert.equal(live.in_progress, true);
  assert.equal(live.to_ts, null);
  assert.equal(live.ms, 10 * H);
});

test('paging back leaves out the running attempt', () => {
  const t = NOW - 2 * DAY_MS;
  const { gaps } = relapseGaps({
    events: [rAt(t - 30 * H), rAt(t)], tz: IST, settings: S, now: NOW, endDay: '2026-08-20',
  });
  assert.ok(gaps.every(g => !g.in_progress));
});

test('gaps are placed by the day they ended, so they page with the other charts', () => {
  const events = [rAt(NOW - 80 * DAY_MS), rAt(NOW - 70 * DAY_MS), rAt(NOW - 3 * DAY_MS)];
  const { gaps } = relapseGaps({ events, tz: IST, settings: S, now: NOW, days: 30 });
  // The 10-day gap ended 70 days ago, outside a 30-day window. The 67-day one
  // ended 3 days ago, inside it — even though it began long before.
  const done = gaps.filter(g => !g.in_progress);
  assert.equal(done.length, 1);
  assert.equal(done[0].ms, 67 * DAY_MS);
});

test('the reference line is the same number the stats row calls typical', async () => {
  // Drawn directly under "typical", so it has to be the all-time median —
  // not the window's — or the screen contradicts itself.
  const { attemptStats } = await import('../worker/lib/stats.js');
  const t = NOW - 90 * DAY_MS;
  const ts = [0, 20, 48, 75, 400, 430, 2000].map(h => t + h * H);
  const { typical_ms } = relapseGaps({ events: ts.map(rAt), tz: IST, settings: S, now: NOW, days: 14 });
  assert.equal(typical_ms, attemptStats(ts, NOW).median_attempt_ms);
});

test('no relapses, or one, has no completed gap and no typical', () => {
  assert.deepEqual(relapseGaps({ events: [], tz: IST, settings: S, now: NOW }),
    { gaps: [], typical_ms: null });
  const one = relapseGaps({ events: [rAt(NOW - 5 * H)], tz: IST, settings: S, now: NOW });
  assert.equal(one.typical_ms, null);
  assert.equal(one.gaps.filter(g => !g.in_progress).length, 0);
});
