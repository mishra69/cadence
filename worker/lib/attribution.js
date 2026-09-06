// Notification attribution (plan §7b, "Measure whether this works").
//
// Every sent notification eventually gets an `outcome_90m`: what, if anything,
// the user logged in the 90 minutes after it landed. On its own this is a weak
// signal — the point is the comparison phase 5 makes between notified windows
// and matched un-notified ones. Recording it now is cheap and cannot be
// reconstructed later at any price, so it starts before phase 5 does.
//
// Nothing here reads or writes notification *content*. It joins two timestamp
// columns and writes one enum.
import { OUTCOME_WINDOW_MS } from './constants.js';

/**
 * Settle every notification whose 90-minute window has closed.
 *
 * Deliberately *not* run at send time or on a per-notification timer. The
 * window is a property of the clock, not of the delivery, so a sweep that asks
 * "which windows have closed since I last looked" is both simpler than an
 * alarm per notification and self-healing: a tick that never ran, a deploy in
 * the middle of a window, or nine months of rows that predate this file all
 * settle on the next pass with no special case.
 *
 * That is also why this needs no separate backfill script. The first run
 * settles all history; every run after it settles a handful.
 *
 * Idempotent: `outcome_90m IS NULL` is the work queue, and settling a row
 * removes it from that queue permanently.
 *
 * @param {D1Database} db
 * @param {{now?: number}} opts
 * @returns {Promise<{settled: number}>}
 */
export async function settleOutcomes(db, { now = Date.now() } = {}) {
  const res = await db.prepare(
    // COALESCE supplies 'none' for the two ways the subquery yields NULL: no
    // events at all in the window (SUM over zero rows is NULL), and events that
    // are neither kind (SUM is 0, so the CASE falls through). Both mean the
    // same thing here — nothing was logged — and collapsing them keeps 'none'
    // an honest category rather than a mix of NULL and 'none'.
    `UPDATE notifications
        SET outcome_90m = COALESCE((
              SELECT CASE
                       WHEN SUM(kind = 'relapse') > 0 THEN 'relapse'
                       WHEN SUM(kind = 'urge')    > 0 THEN 'urge_logged'
                     END
                FROM events
               WHERE events.user_id = notifications.user_id
                 AND events.ts_utc  >  notifications.sent_at
                 AND events.ts_utc  <= notifications.sent_at + ?
            ), 'none')
      WHERE sent_at IS NOT NULL
        AND outcome_90m IS NULL
        AND sent_at + ? <= ?`
  ).bind(OUTCOME_WINDOW_MS, OUTCOME_WINDOW_MS, now).run();

  return { settled: res?.meta?.changes ?? 0 };
}
