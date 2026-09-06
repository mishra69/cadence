// Streak staleness.
//
// The streak is elapsed time since the last relapse (§3). That is timezone-proof
// and monotonic, but it is only *meaningful* while relapses are actually being
// logged — abandon the app and it grows forever, which quietly rewards
// abandonment. §3's answer was that coverage degrades visibly, but coverage is a
// small grey line under a large confident number, and in practice the number
// wins.
//
// So: the streak is a claim, and the app can only vouch for it as far as it has
// evidence. Past that it says so. It still never resets on inactivity — that was
// rejected for a good reason and stays rejected. Pausing is not punishing.
//
// Pure functions over an injected clock, same as schedule.js.
import { DAY_MS } from './time.js';

/**
 * Anything that counts as "the user was here". Opening the app counts even with
 * nothing logged: it is a statement that there was nothing to report, which is
 * weaker evidence than a check-in but far better than silence.
 */
export function lastActivityAt({ lastSeenAt, lastEventAt }) {
  const candidates = [lastSeenAt, lastEventAt].filter(v => v != null);
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * Did enough silence pass to stop trusting the streak?
 *
 * @returns {{stale:boolean, gap_days:number}}
 */
export function assessGap({ lastActivity, now, staleAfterDays }) {
  // Nothing on record: a first run is not a gap.
  if (lastActivity == null) return { stale: false, gap_days: 0 };
  const gapDays = Math.floor((now - lastActivity) / DAY_MS);
  return { stale: gapDays >= staleAfterDays, gap_days: Math.max(0, gapDays) };
}

/**
 * What an app-open should record, and whether it should raise the return prompt.
 *
 * The gap start is persisted rather than recomputed, because this same open
 * bumps last_seen_at — without persisting it the prompt would show once and be
 * impossible to show again.
 *
 * @returns {{last_seen_at:number, pending_gap_start:number|null, needs_review:boolean, gap_days:number}}
 */
export function onSeen({ lastSeenAt, lastEventAt, pendingGapStart, now, staleAfterDays }) {
  const lastActivity = lastActivityAt({ lastSeenAt, lastEventAt });
  const { stale, gap_days } = assessGap({ lastActivity, now, staleAfterDays });

  // An unresolved gap from a previous return stays pending — reopening the app
  // is not the same as accounting for the days that were missed.
  const gapStart = pendingGapStart ?? (stale ? lastActivity : null);

  return {
    last_seen_at: now,
    pending_gap_start: gapStart,
    needs_review: gapStart != null,
    gap_days: gapStart != null ? Math.floor((now - gapStart) / DAY_MS) : gap_days,
  };
}

/**
 * The window a returning user may place a relapse in.
 *
 * Capped at backfill_window_days rather than spanning the whole gap: a decision
 * to keep remembered dates close enough to be real. The cost is that a long
 * absence containing an early relapse produces a streak that is too *short* —
 * the safe direction, but it does mean the number can understate after a long
 * time away.
 *
 * Clamped to the gap so it can never offer a date from before the user was last
 * active, which would overwrite a period already accounted for.
 */
export function backfillWindow({ gapStart, now, backfillWindowDays }) {
  const earliestAllowed = now - backfillWindowDays * DAY_MS;
  const earliest = gapStart == null ? earliestAllowed : Math.max(earliestAllowed, gapStart);
  return { earliest, latest: now, capped: gapStart != null && gapStart < earliestAllowed };
}

/**
 * How the streak should be presented.
 *
 * `unverified` never changes the number — it changes what the app is willing to
 * claim about it.
 */
export function streakConfidence({ pendingGapStart, lastActivity, now, staleAfterDays }) {
  if (pendingGapStart != null) {
    return {
      unverified: true,
      unverified_since: pendingGapStart,
      unverified_days: Math.floor((now - pendingGapStart) / DAY_MS),
    };
  }
  // No pending gap, but drifting again right now — flagged before the next open
  // so a streak read on a stale screen isn't presented as confirmed.
  const { stale, gap_days } = assessGap({ lastActivity, now, staleAfterDays });
  if (stale) {
    return { unverified: true, unverified_since: lastActivity, unverified_days: gap_days };
  }
  return { unverified: false, unverified_since: null, unverified_days: 0 };
}
