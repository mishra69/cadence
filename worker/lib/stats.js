// The read path (plan §4). Everything here is derived at query time; no metric
// is ever stored, so a corrected event or a changed day boundary is reflected
// immediately and there is no cache to go stale.
import { derive, streakDays, DAY_MS } from './time.js';
import { lastActivityAt, streakConfidence } from './activity.js';

/**
 * Attempt lengths in days.
 *
 * An "attempt" is the span between two relapses. The first span (start of
 * tracking → first relapse) is left-censored — the attempt was already running
 * when logging began — and the current span is right-censored, since it hasn't
 * ended. Both are excluded from the median: including the truncated first one
 * drags the median down by an amount that depends only on when I installed the
 * app, which is not a fact about the behaviour.
 *
 * `best` does include the current streak, because a right-censored span that is
 * already the longest genuinely is the longest so far.
 */
export function attemptStats(relapseTimestamps, now = Date.now()) {
  // Milliseconds throughout, with days derived at the end rather than the
  // other way round. Attempts are not day-shaped: a 47-hour attempt is a real
  // 47 hours, and dividing by a day first meant the only value that ever left
  // this function had already lost up to 23:59 of it. Nothing stored changes —
  // ts_utc was always exact — this just stops discarding the remainder before
  // anyone gets to decide whether they want it.
  const rs = [...relapseTimestamps].sort((a, b) => a - b);
  const completed = [];
  for (let i = 1; i < rs.length; i++) completed.push(rs[i] - rs[i - 1]);

  const current = rs.length ? now - rs[rs.length - 1] : null;

  let median = null;
  if (completed.length) {
    const s = [...completed].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    median = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  const candidates = [...completed];
  if (current != null) candidates.push(current);
  const best = candidates.length ? Math.max(...candidates) : null;

  const inDays = ms => (ms == null ? null : Math.floor(ms / DAY_MS));

  return {
    // Each relapse closes an attempt; one more is in progress.
    attempt_count: rs.length ? rs.length + 1 : (current == null ? 0 : 1),
    completed_attempts: completed.length,
    // Whole days, kept because the notification's "Day 12" framing wants a day
    // count and nothing else. These floor, by definition.
    median_attempt_days: inDays(median),
    best_days: inDays(best),
    // Exact. What anything rendering sub-day precision should read.
    median_attempt_ms: median,
    best_ms: best,
  };
}

/**
 * Whole days between two 'YYYY-MM-DD' strings. Plain calendar arithmetic — no
 * zone is involved, because a logical day is already zone-resolved.
 */
export function daysBetweenLogicalDays(from, to) {
  const parse = s => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(to) - parse(from)) / DAY_MS);
}

/**
 * @param {D1Database} db
 * @param {string} userId
 * @param {string} tz  the client's current zone, for logical-day answers
 * @param {object} settings
 */
export async function getStats(db, userId, tz, settings, now = Date.now()) {
  const since = ms => now - ms;

  const [relapseRes, firstRes, countRes] = await db.batch([
    // Relapses are rare by construction (4–8/month), so fetching them all is
    // cheaper than three aggregate queries and gives the attempt spans for free.
    db.prepare("SELECT ts_utc FROM events WHERE user_id = ? AND kind = 'relapse' ORDER BY ts_utc")
      .bind(userId),
    db.prepare('SELECT MIN(ts_utc) AS first_ts, MAX(ts_utc) AS last_ts, COUNT(*) AS total FROM events WHERE user_id = ?')
      .bind(userId),
    db.prepare(
      `SELECT
         SUM(CASE WHEN kind = 'urge'    AND ts_utc >= ? THEN 1 ELSE 0 END) AS urges_7d,
         SUM(CASE WHEN kind = 'urge'    AND ts_utc >= ? THEN 1 ELSE 0 END) AS urges_30d,
         SUM(CASE WHEN kind = 'urge'    AND ts_utc >= ? THEN 1 ELSE 0 END) AS urges_90d,
         SUM(CASE WHEN kind = 'relapse' AND ts_utc >= ? THEN 1 ELSE 0 END) AS relapses_30d,
         SUM(CASE WHEN kind = 'relapse' AND ts_utc >= ? THEN 1 ELSE 0 END) AS relapses_90d
       FROM events WHERE user_id = ?`
    ).bind(since(7 * DAY_MS), since(30 * DAY_MS), since(90 * DAY_MS),
           since(30 * DAY_MS), since(90 * DAY_MS), userId),
  ]);

  const relapses = (relapseRes.results || []).map(r => r.ts_utc);
  const firstTs = firstRes.results?.[0]?.first_ts ?? null;
  const lastEventTs = firstRes.results?.[0]?.last_ts ?? null;
  const totalEvents = firstRes.results?.[0]?.total ?? 0;
  const c = countRes.results?.[0] || {};

  const lastRelapse = relapses.length ? relapses[relapses.length - 1] : null;
  const streak = streakDays(lastRelapse, now);

  // Coverage counts days, because a check-in is inherently per-day — unlike the
  // streak, where day-counting breaks across the date line (§3).
  //
  // Its denominator is the number of logical days the window *spans*, not the
  // elapsed-day streak. Those differ by one whenever the window has a partial
  // day at each end, which is almost always: a 6-day streak touches 7 logical
  // days, and reporting "7 of 6 confirmed" reads as a bug in the app rather
  // than as the arithmetic it is.
  const windowStart = lastRelapse ?? firstTs;
  let confirmedDays = 0;
  let coverageDays = 0;
  if (windowStart != null) {
    const row = await db.prepare(
      `SELECT COUNT(DISTINCT logical_day) AS n FROM events
       WHERE user_id = ? AND kind = 'daily' AND ts_utc >= ?`
    ).bind(userId, windowStart).first();
    confirmedDays = row?.n ?? 0;
    if (tz) {
      const from = derive(windowStart, tz, settings.day_boundary_hour).logical_day;
      const to = derive(now, tz, settings.day_boundary_hour).logical_day;
      coverageDays = daysBetweenLogicalDays(from, to) + 1;
    }
  }

  const urges90 = c.urges_90d || 0;
  const relapses90 = c.relapses_90d || 0;

  return {
    // Carried on the stats response because it is the read the client already
    // makes at boot, and the missing-lock warning has to render before anything
    // else fetches settings.
    lock_intent: settings.lock_intent ?? null,

    today: tz ? derive(now, tz, settings.day_boundary_hour).logical_day : null,
    tz: tz || null,
    has_data: totalEvents > 0,
    tracking_since: firstTs,

    // Kept, but never the headline — shown beside best and median so a
    // single-digit number reads as typical rather than as failure (§0).
    streak_days: streak,
    // The same figure undivided, so a 47-hour streak can be shown as 47 hours
    // instead of collapsing onto a 24-hour one.
    streak_ms: lastRelapse == null ? null : Math.max(0, now - lastRelapse),
    // No relapse on record yet: elapsed time since tracking began is the honest
    // number, but it is explicitly not a streak, so the client labels it.
    days_tracked: firstTs == null ? 0 : Math.floor((now - firstTs) / DAY_MS),
    confirmed_days: confirmedDays,
    coverage_days: coverageDays,
    last_relapse_ts: lastRelapse,

    ...attemptStats(relapses, now),

    // The streak number is unchanged by inactivity — this only says how far the
    // app is willing to vouch for it.
    confidence: streakConfidence({
      pendingGapStart: settings.pending_gap_start ?? null,
      lastActivity: lastActivityAt({
        lastSeenAt: settings.last_seen_at ?? null,
        lastEventAt: relapses.length || firstTs != null ? lastEventTs : null,
      }),
      now,
      staleAfterDays: settings.stale_after_days ?? 3,
    }),

    // Trailing, so one slip doesn't erase three months.
    relapses_30d: c.relapses_30d || 0,
    urges_7d: c.urges_7d || 0,
    urges_30d: c.urges_30d || 0,

    // A slow-moving proxy for resist rate, gated because the denominator is
    // "urges I bothered to log" — a drop can mean improvement or just laziness.
    // Two raw counts are more honest than one ratio; this is for the trend line
    // on the charts page, not the home screen.
    resist: {
      urges_90d: urges90,
      relapses_90d: relapses90,
      per_100: urges90 >= 50 ? Math.round((relapses90 / urges90) * 1000) / 10 : null,
      gated_until: Math.max(0, 50 - urges90),
    },
  };
}
