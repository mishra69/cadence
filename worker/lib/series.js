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
 * The two windows share a unit on purpose. A 7-day count and a 30-day count are
 * the same measure at different magnitudes, and plotting them against two
 * y-scales is the single most common charting mistake. Dividing the 30-day
 * window by 30 and multiplying by 7 puts both on one axis, where they can
 * honestly be compared: one is the noisy read, the other the smoothed one.
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

  return all.map((day, i) => {
    const hist = historyDays(day);
    return {
      day,
      per_week_7d: hist >= 7 ? windowBack(i, 7, d => relapsesByDay.get(d) || 0) : null,
      per_week_30d: hist >= 30
        ? Math.round((windowBack(i, 30, d => relapsesByDay.get(d) || 0) / 30) * 7 * 10) / 10
        : null,
      // 0–1. Low coverage means the count above is a floor, not a measurement.
      coverage_7d: hist >= 7
        ? Math.round((windowBack(i, 7, d => (anyByDay.has(d) ? 1 : 0)) / 7) * 100) / 100
        : null,
      relapses: relapsesByDay.get(day) || 0,
    };
  });
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
  for (const e of events) {
    const d = e.logical_day || derive(e.ts_utc, tz, boundary).logical_day;
    if (!byDay.has(d)) byDay.set(d, { count: 0, confirmed: false, events: 0 });
    const rec = byDay.get(d);
    rec.events++;
    if (e.kind === 'relapse') rec.count++;
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
    const outside = day < start || day > last || day > todayDay;
    return {
      day,
      outside,
      state: outside ? 'pad' : !rec ? 'unknown' : rec.count > 0 ? 'relapse' : 'clean',
      count: rec?.count || 0,
      confirmed: !!rec?.confirmed,
      events: rec?.events || 0,
    };
  });
}
