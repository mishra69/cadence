import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollingRelapses, dayRibbon, relapseGaps, morningBySinceRelapse, MIN_PER_GROUP } from '../worker/lib/series.js';
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
  // Day -20 through yesterday is 20 days of history; the first 6 are withheld.
  // (Today is unsettled — no slip on it — so it has no point at all.)
  assert.equal(drawn.length, 14);
  assert.ok(s.slice(0, s.length - 14).every(p => p.per_week_7d === null));
});

test('the smoothed series appears later than the 7-day one', () => {
  const events = [ev(60, 'daily'), ...Array.from({ length: 10 }, (_, i) => ev(i * 6, 'relapse'))];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 60 });
  const first7 = s.findIndex(p => p.per_week_7d != null);
  const first28 = s.findIndex(p => p.per_week_28d != null);
  assert.ok(first7 >= 0 && first28 > first7, `7d at ${first7}, 28d at ${first28}`);
});

// The other half of the same hazard: a week you did not log produces a genuine
test('a past day is blue for any engagement at all, and grey only when forgotten', () => {
  // One question per colour: did you use the app that day? A morning check-in
  // alone is engagement — the day is over, nothing was slipped, it is blue.
  const cell = (events, day = '2026-09-01') =>
    dayRibbon({ events: [ev(20, 'daily'), ...events], tz: IST, settings: S, now: NOW, days: 14 })
      .find(c => c.day === day);

  for (const kind of ['morning_check', 'urge', 'note', 'daily']) {
    assert.equal(cell([ev(2, kind, 10)]).state, 'clean', kind);
  }
  assert.equal(cell([]).state, 'unknown', 'nothing that day: forgotten');
  assert.equal(cell([ev(2, 'morning_check', 9), ev(2, 'relapse', 22)]).state, 'relapse');
});

test('today is never blue — not after a check-in, not even after the review', () => {
  // It is not over. A morning check-in at 09:00 says nothing about 23:00, and
  // the review is just another interaction until 04:00 closes the day.
  const today = events =>
    dayRibbon({ events: [ev(20, 'daily'), ...events], tz: IST, settings: S, now: NOW, days: 14 })
      .find(c => c.day === '2026-09-03');

  const morning = today([ev(0, 'morning_check', 9)]);
  assert.equal(morning.state, 'unknown');
  assert.equal(morning.in_progress, true, 'outlined: touched, not finished');

  const reviewed = today([ev(0, 'morning_check', 9), ev(0, 'daily', 11)]);
  assert.equal(reviewed.state, 'unknown', 'the review does not close the day');
  assert.equal(reviewed.in_progress, true);

  const untouched = today([]);
  assert.equal(untouched.state, 'unknown');
  assert.equal(untouched.in_progress, false, 'no outline until something is recorded');

  const slip = today([ev(0, 'morning_check', 9), ev(0, 'relapse', 11)]);
  assert.equal(slip.state, 'relapse', 'a slip needs no waiting');
  assert.equal(slip.in_progress, false);
});

test('once 04:00 passes, yesterday turns blue with no further action', () => {
  // Same events, clock moved past the boundary: the day that was in progress
  // is now closed, and it was used without a slip.
  const events = [ev(20, 'daily'), ev(0, 'morning_check', 9)];
  const before = dayRibbon({ events, tz: IST, settings: S, now: NOW, days: 14 })
    .find(c => c.day === '2026-09-03');
  const after = dayRibbon({ events, tz: IST, settings: S, now: NOW + DAY_MS, days: 14 })
    .find(c => c.day === '2026-09-03');
  assert.equal(before.state, 'unknown');
  assert.equal(after.state, 'clean');
  assert.equal(after.in_progress, false);
});

test('the outline lands on at most one cell, today', () => {
  const events = [];
  for (let d = 0; d < 20; d++) {
    if (d % 4 === 1) events.push(ev(d, 'relapse'));   // never today
    if (d % 2 === 0) events.push(ev(d, 'urge'));
    events.push(ev(d, 'morning_check', 9));
  }
  events.push(ev(0, 'note', 11));
  const r = dayRibbon({ events, tz: IST, settings: S, now: NOW, days: 21 });
  const outlined = r.filter(c => c.in_progress);
  assert.equal(outlined.length, 1);
  assert.equal(outlined[0].day, '2026-09-03');
});

test('days before the first entry are absent, not forgotten', () => {
  // Grey means "you forgot the app that day". Before the first entry there was
  // no app to forget, so those days must not wear that grey.
  const r = dayRibbon({ events: [ev(10, 'urge')], tz: IST, settings: S, now: NOW, days: 30 });
  const first = '2026-08-24';
  assert.ok(r.filter(c => c.day < first).every(c => c.state === 'pad' && c.before_record));
  assert.equal(r.find(c => c.day === first).state, 'clean');
  assert.ok(r.filter(c => c.day > first && c.day < '2026-09-03').every(c => c.state === 'unknown'),
    'inside the record, an empty day is a forgotten day');
});

test('coverage counts a morning check-in as the day being used', () => {
  // Same rule as the ribbon, so the faded line and the grey cells agree.
  const mornings = rollingRelapses({
    // The seven days ending yesterday: today has no point while it is unsettled.
    events: [ev(30, 'daily'), ...[1, 2, 3, 4, 5, 6, 7].map(d => ev(d, 'morning_check', 9))],
    tz: IST, settings: S, now: NOW, days: 30,
  });
  assert.equal(mornings[mornings.length - 1].coverage_7d, 1);
});

test('coverage reports how much of the window was actually logged', () => {
  const events = [
    ev(30, 'daily'),
    ...[1, 2, 3, 4, 5, 6, 7].map(d => ev(d, 'daily')),   // every day of the last settled week
  ];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 30 });
  assert.equal(s[s.length - 1].coverage_7d, 1, 'a fully logged week');

  const sparse = rollingRelapses({
    events: [ev(30, 'daily'), ev(1, 'daily')],
    tz: IST, settings: S, now: NOW, days: 30,
  });
  const lastSparse = sparse[sparse.length - 1];
  assert.equal(lastSparse.per_week_7d, 0, 'zero slips counted');
  assert.ok(lastSparse.coverage_7d < 0.2,
    'but almost nothing was logged, so that zero is a floor not a measurement');
});

test('an empty history draws nothing at all', () => {
  const s = rollingRelapses({ events: [], tz: IST, settings: S, now: NOW, days: 14 });
  assert.equal(s.length, 13, 'today, with no slip, has no point');
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
  const r = dayRibbon({ events: [ev(10, 'daily'), ev(1, 'daily')], tz: IST, settings: S, now: NOW, days: 14 });
  const day = d => r.find(c => c.day === d);
  assert.equal(day('2026-09-02').state, 'clean');
  assert.equal(day('2026-08-28').state, 'unknown', 'between the two entries: forgotten');
});

test('the review is tracked separately from the colour', () => {
  // Blue no longer implies it, so the tooltip reports it on its own.
  const r = dayRibbon({ events: [ev(10, 'urge'), ev(2, 'urge'), ev(1, 'daily')], tz: IST, settings: S, now: NOW, days: 14 });
  const day = d => r.find(c => c.day === d);
  assert.equal(day('2026-09-01').state, 'clean');
  assert.equal(day('2026-09-01').confirmed, false);
  assert.equal(day('2026-09-02').confirmed, true);
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

// ── Today on the rate chart ─────────────────────────────────────────────────

test('today has no point on the rate chart while it is still grey', () => {
  // Matches the ribbon: a day still happening is not plotted as if final.
  const events = [ev(40, 'daily'), ev(5, 'relapse'), ev(0, 'morning_check', 9)];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 30 });
  assert.equal(s.at(-1).day, '2026-09-02', 'the line ends on the last settled day');
  assert.ok(!s.some(p => p.day === '2026-09-03'));
  assert.equal(s.length, 29, 'dropped, not nulled into a gap');
});

test('today joins the chart the moment it has a slip', () => {
  const events = [ev(40, 'daily'), ev(5, 'relapse'), ev(0, 'relapse', 11)];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 30 });
  assert.equal(s.at(-1).day, '2026-09-03');
  assert.equal(s.at(-1).relapses, 1);
});

test('once 04:00 passes, the day it was joins the chart on its own', () => {
  const events = [ev(40, 'daily'), ev(5, 'relapse'), ev(0, 'morning_check', 9)];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW + DAY_MS, days: 30 });
  assert.ok(s.some(p => p.day === '2026-09-03'), 'yesterday now, and settled');
  assert.ok(!s.some(p => p.day === '2026-09-04'), 'the new today waits its turn');
});

test('paging back is unaffected: every day in a past window is plotted', () => {
  const events = [ev(90, 'daily'), ev(45, 'relapse')];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 30, endDay: '2026-08-04' });
  assert.equal(s.length, 30);
});

// ── Releases on the charts ──────────────────────────────────────────────────

test('releases sit inside the gap they fell in, without ending it', () => {
  const t = NOW - 10 * DAY_MS;
  const events = [rAt(t), { kind: 'release', ts_utc: t + 30 * H }, { kind: 'release', ts_utc: t + 50 * H }, rAt(t + 96 * H)];
  const { gaps } = relapseGaps({ events, tz: IST, settings: S, now: NOW });
  const g = gaps.find(x => !x.in_progress);
  assert.equal(g.ms, 96 * H, 'still one 96h gap — a release is not a relapse');
  assert.deepEqual([...g.releases].map(o => o / H), [30, 50], 'offsets from the gap start');
});

test('a release in the running attempt is shown too', () => {
  const t = NOW - 40 * H;
  const { gaps } = relapseGaps({ events: [rAt(t), { kind: 'release', ts_utc: NOW - 5 * H }], tz: IST, settings: S, now: NOW });
  const live = gaps.at(-1);
  assert.equal(live.in_progress, true);
  assert.deepEqual([...live.releases].map(o => o / H), [35]);
});

test('a release marks the ribbon cell without changing its colour', () => {
  const r = dayRibbon({
    events: [ev(10, 'daily'), ev(3, 'release', 22), ev(2, 'relapse', 9), ev(2, 'release', 23)],
    tz: IST, settings: S, now: NOW, days: 14,
  });
  const day = d => r.find(c => c.day === d);
  assert.equal(day('2026-08-31').state, 'clean', 'used the app, no slip: blue');
  assert.equal(day('2026-08-31').releases, 1);
  assert.equal(day('2026-09-01').state, 'relapse', 'a slip is still a slip');
  assert.equal(day('2026-09-01').releases, 1);
  assert.equal(day('2026-09-02').releases, 0);
});

test('a release is not a slip on the rate chart', () => {
  const events = [ev(40, 'daily'), ...[1, 2, 3].map(d => ev(d, 'release'))];
  const s = rollingRelapses({ events, tz: IST, settings: S, now: NOW, days: 30 });
  assert.equal(s.at(-1).per_week_7d, 0);
});

// ── Morning readings by time since relapse ──────────────────────────────────

const mw = (ts, v, over = {}) => ({ kind: 'morning_check', ts_utc: ts, morning_wood: v, ...over });
const group = (out, id) => out.groups.find(g => g.id === id);

test('each reading is grouped by hours since the relapse before it', () => {
  const r = NOW - 10 * DAY_MS;
  const out = morningBySinceRelapse({ events: [
    rAt(r), mw(r + 10 * H, 0), mw(r + 23.9 * H, 2), mw(r + 24 * H, 3), mw(r + 47 * H, 0), mw(r + 60 * H, 2),
  ] });
  const lt = group(out, 'lt24');
  assert.deepEqual([lt.none, lt.mild, lt.strong, lt.n], [1, 1, 0, 2]);
  assert.equal(group(out, '24to48').n, 2, '24h exactly is the second group, not the first');
  assert.equal(group(out, '24to48').strong, 1);
  assert.equal(group(out, 'gte48').mild, 1);
});

test('only a relapse that came before the reading counts', () => {
  // A relapse later the same day must not make that morning "under 24h".
  const r = NOW - 10 * DAY_MS;
  const out = morningBySinceRelapse({ events: [rAt(r), mw(r + 50 * H, 3), rAt(r + 52 * H)] });
  assert.equal(group(out, 'gte48').strong, 1);
  assert.equal(group(out, 'lt24').n, 0);
});

test('ungraded and late readings are excluded, and counted as excluded', () => {
  // "Don't recall" is about memory; the legacy "yes" predates strength; a
  // reading given at the evening review carries an evening timestamp.
  const r = NOW - 10 * DAY_MS;
  const out = morningBySinceRelapse({ events: [
    mw(r - 5 * H, 0),                        // before any relapse
    rAt(r), mw(r + 5 * H, 4), mw(r + 6 * H, 1), mw(r + 7 * H, 2, { recalled: true }), mw(r + 8 * H, 3),
  ] });
  assert.deepEqual({ ...out.excluded }, { dont_recall: 1, legacy_yes: 1, recalled: 1, no_prior_relapse: 1 });
  assert.equal(out.groups.reduce((a, g) => a + g.n, 0), 1, 'only the one graded live reading');
});

test('a group too small to trust says so', () => {
  const r = NOW - 30 * DAY_MS;
  const events = [rAt(r)];
  for (let k = 0; k < MIN_PER_GROUP; k++) events.push(mw(r + (1 + k) * H, 0));
  events.push(mw(r + 30 * H, 2));
  const out = morningBySinceRelapse({ events });
  assert.equal(group(out, 'lt24').enough, true, `${MIN_PER_GROUP} readings is enough`);
  assert.equal(group(out, '24to48').enough, false, 'one is not');
});

test('a release does not reset the clock for this grouping', () => {
  // Relapses only, for now: releases started being logged on 2026-10-05.
  const r = NOW - 10 * DAY_MS;
  const out = morningBySinceRelapse({ events: [rAt(r), { kind: 'release', ts_utc: r + 40 * H }, mw(r + 50 * H, 0)] });
  assert.equal(group(out, 'gte48').n, 1);
});
