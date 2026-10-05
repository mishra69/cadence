// Chart series for the Progress screen (plan §6).
//
// Computed server-side and shipped as plain arrays, so the client renders and
// never derives. Same reasoning as stats.js: one implementation of every
// definition, and the client cannot drift from it.
//
// The recurring hazard in every series here is that **absence looks like zero**.
// A day with nothing logged is not a day nothing happened, and a window with no
// history is not a window with no relapses. Both would draw as a confident line
// along the floor — the most flattering possible reading of missing data. Every
// function below returns null rather than 0 where the answer is unknown, and
// reports coverage so the client can show how much to trust a point.
import { derive, DAY_MS } from './time.js';

/** Every logical day from `from` to `to` inclusive, as 'YYYY-MM-DD'. */
function dayRange(from, to) {
  const out = [];
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  for (let t = parse(from); t <= parse(to); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const parseDay = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };

/**
 * Relapses in a trailing window, per day, expressed **per week** in both cases.
 *
 * The two windows share a unit on purpose. A 7-day count and a 28-day count are
 * the same measure at different magnitudes, and plotting them against two
 * y-scales is the single most common charting mistake. Dividing the long window
 * by 4 puts both on one axis, where they can honestly be compared: one is the
 * noisy read, the other the smoothed one.
 *
 * The smoothed window is 28 days, not 30, because 28 is **exactly four weeks**.
 * A 30-day window spans 4.29 weeks, so it holds some weekdays five times and
 * others four — and which ones rotates as the window slides. Any weekly rhythm
 * in the behaviour is then re-emitted as a 7-day ripple in the line whose whole
 * job is to be the steady one. On a synthetic signal with a dead-constant rate
 * of 2.0/week concentrated on Mondays, the 30-day window oscillated 1.9↔2.3 — a
 * 20% swing invented out of a rate that never moved. The 28-day window sat flat.
 *
 * It also lines up with what is drawn directly below it: the ribbon is one
 * column per week, so four weeks is the last four columns rather than a period
 * with no visible counterpart.
 *
 * Both series are null until their window is fully inside recorded history. A
 * partial window slopes purely because it is filling, and before tracking began
 * a count of zero is not a low rate — it is no data, and drawing it as a flat
 * line along zero states something untrue with great confidence.
 *
 * `coverage_7d` is the share of the trailing week that has any event at all. A
 * week you did not log produces a genuine zero count, which is indistinguishable
 * from a good week unless coverage travels alongside it.
 */
export function rollingRelapses({ events, tz, settings, now = Date.now(), days = 60, endDay = null }) {
  const boundary = settings.day_boundary_hour;
  const last = endDay || derive(now, tz, boundary).logical_day;
  const start = new Date(parseDay(last) - (days - 1) * DAY_MS).toISOString().slice(0, 10);

  const relapses = events.filter(e => e.kind === 'relapse');
  const firstEvent = events.length ? Math.min(...events.map(e => e.ts_utc)) : null;
  const trackingFrom = firstEvent == null ? null : derive(firstEvent, tz, boundary).logical_day;

  const relapsesByDay = new Map();
  const anyByDay = new Set();
  for (const e of events) {
    const d = e.logical_day || derive(e.ts_utc, tz, boundary).logical_day;
    anyByDay.add(d);
    if (e.kind === 'relapse') relapsesByDay.set(d, (relapsesByDay.get(d) || 0) + 1);
  }

  const all = dayRange(start, last);
  const windowBack = (endIdx, n, fn) => {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const day = new Date(parseDay(all[endIdx]) - i * DAY_MS).toISOString().slice(0, 10);
      sum += fn(day);
    }
    return sum;
  };

  // Days of real history behind a point, so a window still filling is withheld.
  const historyDays = day =>
    trackingFrom == null ? 0 : Math.round((parseDay(day) - parseDay(trackingFrom)) / DAY_MS) + 1;

  const todayDay = derive(now, tz, boundary).logical_day;

  const points = all.map((day, i) => {
    const hist = historyDays(day);
    return {
      day,
      per_week_7d: hist >= 7 ? windowBack(i, 7, d => relapsesByDay.get(d) || 0) : null,
      // /4 exactly, because 28 days is four whole weeks. The old /30*7 was an
      // inexact conversion hidden behind the rounding.
      per_week_28d: hist >= 28
        ? Math.round((windowBack(i, 28, d => relapsesByDay.get(d) || 0) / 4) * 10) / 10
        : null,
      // 0–1. Low coverage means the count above is a floor, not a measurement.
      coverage_7d: hist >= 7
        ? Math.round((windowBack(i, 7, d => (anyByDay.has(d) ? 1 : 0)) / 7) * 100) / 100
        : null,
      relapses: relapsesByDay.get(day) || 0,
    };
  });

  // Today is plotted only once it is settled, which, before 04:00 closes it,
  // means only once it has a slip. Until then it is the grey cell in the
  // ribbon below, and a point here would be a rate computed from a day that
  // is still happening — one that can only rise, drawn as if it were final.
  // Dropped rather than nulled: a null draws as a gap, which on this chart
  // means "no data", and the axis would still run to a day with no point on it.
  return points.filter(p => !(p.day === todayDay && p.relapses === 0));
}

/**
 * One cell per logical day.
 *
 * `count` carries how many slips fell on the day, so two in a day are not drawn
 * the same as one. "No data" stays its own state rather than folding into clean.
 *
 * Padded to whole weeks and aligned so every column is the same weekday: full
 * rows by construction, and a weekday pattern becomes visible for free. Padding
 * days outside the requested range are marked so they can be drawn as absent
 * rather than as data.
 */
export function dayRibbon({ events, tz, settings, now = Date.now(), days = 63, endDay = null, weekStart = 1 }) {
  const boundary = settings.day_boundary_hour;
  const last = endDay || derive(now, tz, boundary).logical_day;
  const start = new Date(parseDay(last) - (days - 1) * DAY_MS).toISOString().slice(0, 10);

  const byDay = new Map();
  let firstDay = null;
  for (const e of events) {
    const d = e.logical_day || derive(e.ts_utc, tz, boundary).logical_day;
    if (firstDay == null || d < firstDay) firstDay = d;
    if (!byDay.has(d)) byDay.set(d, { count: 0, confirmed: false, events: 0, releases: 0 });
    const rec = byDay.get(d);
    rec.events++;
    if (e.kind === 'relapse') rec.count++;
    if (e.kind === 'release') rec.releases++;
    if (e.kind === 'daily') rec.confirmed = true;
  }

  // Extend backwards to the start of that week and forwards to the end of the
  // last, so the grid is rectangular.
  const weekdayOf = day => new Date(parseDay(day)).getUTCDay();
  const backPad = (weekdayOf(start) - weekStart + 7) % 7;
  const fwdPad = 6 - ((weekdayOf(last) - weekStart + 7) % 7);
  const gridStart = new Date(parseDay(start) - backPad * DAY_MS).toISOString().slice(0, 10);
  const gridEnd = new Date(parseDay(last) + fwdPad * DAY_MS).toISOString().slice(0, 10);

  const todayDay = derive(now, tz, boundary).logical_day;

  return dayRange(gridStart, gridEnd).map(day => {
    const rec = byDay.get(day);
    // Outside the *requested* window, which is not the same as absent. The days
    // the week alignment pulls in are ordinary past days with the same events
    // behind them as any other — the route loads the whole history, not the
    // window — so they are drawn as data.
    const outside = day < start || day > last;
    // Absent: the day has not happened yet, or it came before the record
    // began. Before the first entry is not a day the app was forgotten — it is
    // a day the app did not exist — so it must not take forgotten-day grey.
    // (The week-alignment days *inside* the record are real days and are drawn
    // as data; treating them as absent is what once left the grid ragged.)
    const future = day > todayDay;
    const beforeRecord = firstDay != null && day < firstDay;
    const isToday = day === todayDay;
    return {
      day,
      outside,
      future,
      before_record: beforeRecord,
      // One question per colour: did you engage with the app that day?
      //   grey   — no. You forgot it.
      //   blue   — yes, and no slip.
      //   orange — a slip (which also means yes).
      // Today is the exception, because it is not over: a morning check-in at
      // 09:00 says nothing about 23:00. It stays grey until 04:00 closes it,
      // even after the evening review, and is outlined once anything has been
      // recorded. A slip is orange at once — that needs no waiting.
      state: future || beforeRecord ? 'pad'
        : !rec ? 'unknown'
        : rec.count > 0 ? 'relapse'
        : isToday ? 'unknown'
        : 'clean',
      in_progress: isToday && !!rec && rec.count === 0,
      count: rec?.count || 0,
      // A mark on the cell, never a colour: the colour answers "used the app,
      // and did I slip", and a release is neither a slip nor more than use.
      releases: rec?.releases || 0,
      confirmed: !!rec?.confirmed,
      events: rec?.events || 0,
    };
  });
}

/**
 * The gap between each relapse and the next, to the millisecond.
 *
 * Each attempt is placed by the logical day it *ended*, and only those ending
 * inside the window are returned, so this pages with the rate chart and the
 * ribbon rather than on its own clock. The attempt still running is included
 * when the window reaches today, marked `in_progress` — it is a lower bound
 * that is still growing, and drawing it like a finished gap would understate
 * it in a way that looks final.
 *
 * `typical_ms` is the median over *all* completed attempts, not the window's:
 * it is drawn as the reference line, and it has to be the same number the
 * stats row calls "typical" directly above, or the two will disagree on screen.
 */
export function relapseGaps({ events, tz, settings, now = Date.now(), days = 63, endDay = null }) {
  const boundary = settings.day_boundary_hour;
  const last = endDay || derive(now, tz, boundary).logical_day;
  const start = new Date(parseDay(last) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const today = derive(now, tz, boundary).logical_day;
  const dayOf = ts => derive(ts, tz, boundary).logical_day;

  const rs = events.filter(e => e.kind === 'relapse').map(e => e.ts_utc).sort((a, b) => a - b);
  const rels = events.filter(e => e.kind === 'release').map(e => e.ts_utc).sort((a, b) => a - b);

  // The releases that fell inside a gap, as offsets from its start. A release
  // never ends a gap — the streak measures the habit — but a long gap with
  // releases in it was not all willpower, and the chart marks them so it is
  // not read that way.
  const within = (from, to) => rels.filter(t => t > from && t < to).map(t => t - from);

  const all = [];
  for (let i = 1; i < rs.length; i++) {
    all.push({ from_ts: rs[i - 1], to_ts: rs[i], ms: rs[i] - rs[i - 1], releases: within(rs[i - 1], rs[i]) });
  }

  const sorted = all.map(g => g.ms).sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  const typical_ms = !sorted.length ? null
    : sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;

  const gaps = all
    .filter(g => { const d = dayOf(g.to_ts); return d >= start && d <= last; })
    .map(g => ({ ...g, in_progress: false }));

  if (rs.length && last >= today) {
    const from = rs[rs.length - 1];
    gaps.push({
      from_ts: from, to_ts: null, ms: Math.max(0, now - from), in_progress: true,
      releases: within(from, now + 1),
    });
  }

  return { gaps, typical_ms };
}
