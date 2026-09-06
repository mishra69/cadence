// Scheduling for the one daily push (plan §5).
//
// Everything here is a pure function over an injected clock, timezone and RNG.
// That is the whole point: the alternative is a scheduler you can only test by
// waiting until 21:00, or by simulating a flight.
//
// The load-bearing split is planning vs sending. A cron that decides *and*
// delivers quantises every notification to the tick boundary — on a 30-minute
// cron everything lands on :00 or :30, which reads as more mechanical, not
// less. So the target is drawn hours ahead and a Durable Object alarm delivers
// it at arbitrary minute precision.
import { derive, fromLocal, localParts } from './time.js';

/** Local hours outside which a notification is never delivered. */
export const SANE_START_HOUR = 7;
export const SANE_END_HOUR = 24;   // exclusive: 23:59 is fine, 00:00 is not

/** Never schedule earlier than this, whatever the jitter draws. */
export const EARLIEST_HOUR = 19;

/**
 * The target instant for a day's check-in.
 *
 * The jitter is only meaningful because this runs at the 04:00 rollover, hours
 * before the window. Computing it at fire time could only ever delay, never
 * advance, so the offset would be one-sided (0 to +25) and bunched just after
 * a tick. Drawn ahead, the full ±25 minutes is genuinely available.
 *
 * A notification arriving at exactly 21:00 every night becomes its own
 * conditioned cue, which is the §0 rule again. Irregular timing is a
 * requirement, not a garnish.
 *
 * @param {string} logicalDay 'YYYY-MM-DD'
 * @param {string} tz IANA zone
 * @param {{daily_checkin_hour:number, daily_jitter_minutes:number, day_boundary_hour:number}} settings
 * @param {() => number} rng returns [0, 1)
 * @returns {number} epoch ms
 */
export function drawTarget(logicalDay, tz, settings, rng = Math.random) {
  const [y, m, d] = logicalDay.split('-').map(Number);
  const jitter = Math.round((rng() * 2 - 1) * settings.daily_jitter_minutes);

  let ts = fromLocal(tz, y, m, d, settings.daily_checkin_hour, jitter);

  // Clamp, in local terms, to [EARLIEST_HOUR, end of the logical day). The
  // upper clamp matters because a late checkin_hour plus positive jitter could
  // otherwise cross 04:00 and land in the *next* logical day, where it would be
  // both mistimed and attributed to the wrong date.
  const earliest = fromLocal(tz, y, m, d, EARLIEST_HOUR, 0);
  if (ts < earliest) ts = earliest;

  // The last minute still inside this logical day: 03:59 the following morning.
  const latest = fromLocal(tz, y, m, d + 1, settings.day_boundary_hour, -1);
  if (ts > latest) ts = latest;

  // Belt and braces: if the clamps somehow disagree with the boundary, the
  // logical day is the authority and the target is pulled back into it.
  if (derive(ts, tz, settings.day_boundary_hour).logical_day !== logicalDay) {
    return earliest;
  }
  return ts;
}

/**
 * The target for the morning marker.
 *
 * Same jitter reasoning as the evening check-in — a notification arriving at
 * exactly 10:00 every day becomes its own conditioned cue — but a tighter
 * window, because the question is "did this happen this morning" and drifting
 * toward noon starts to make that ambiguous.
 *
 * No EARLIEST_HOUR floor here: that floor exists to keep the evening check-in
 * from landing in the afternoon, and it would push a morning target past its
 * own point.
 */
export function drawMorningTarget(logicalDay, tz, settings, rng = Math.random) {
  const [y, m, d] = logicalDay.split('-').map(Number);
  const jitter = Math.round((rng() * 2 - 1) * 15);
  const hour = settings.morning_checkin_hour ?? 10;
  let ts = fromLocal(tz, y, m, d, hour, jitter);

  // Never before the sane-hours floor: a marker prompt at 06:00 is exactly the
  // sort of thing the guard exists to prevent.
  const earliest = fromLocal(tz, y, m, d, SANE_START_HOUR, 0);
  if (ts < earliest) ts = earliest;
  return ts;
}

/**
 * Is this a civilised local hour to arrive at?
 *
 * This is the entire timezone story for scheduling. An alarm armed at 04:00
 * Pacific for 21:00 Pacific fires at ~04:00 IST if I fly to India that
 * afternoon, and a 4am ping from this app is the one outcome worth preventing.
 * Recompute-and-re-arm-on-tz-change was specced and cut (Appendix A): the next
 * rollover reads tz from the most recent event and self-corrects within a day,
 * so the blast radius is one dropped check-in on a travel day.
 */
export function isSaneHour(tsUtc, tz) {
  const { hour } = localParts(tsUtc, tz);
  return hour >= SANE_START_HOUR && hour < SANE_END_HOUR;
}

/**
 * The fire-time decision, as a pure function of what D1 already knows.
 *
 * Checked here rather than by disarming alarms in a sweep. An armed alarm is a
 * *prediction* that a send will be allowed; the authoritative answer only
 * exists at fire time. A disarm sweep races the alarm it is trying to cancel —
 * one at 20:59 cannot reliably beat an alarm at 21:00 — whereas this has no
 * race, needs no extra cron pass, and fails closed.
 *
 * @returns {{send:boolean, reason?:'gap'|'cap'|'unsane_hour'}}
 */
export function sendDecision({ now, tz, lastSentAt, sentToday, settings }) {
  if (!isSaneHour(now, tz)) return { send: false, reason: 'unsane_hour' };

  if (sentToday >= settings.max_pushes_per_day) return { send: false, reason: 'cap' };

  if (lastSentAt != null) {
    const gapMinutes = (now - lastSentAt) / 60_000;
    if (gapMinutes < settings.min_push_gap_minutes) return { send: false, reason: 'gap' };
  }

  return { send: true };
}

/**
 * Has this target been missed, and is it still worth firing?
 *
 * Durable Object alarms can be lost to eviction, a deploy, or clock skew. The
 * safety-net cron re-arms rather than skipping — but only inside the logical
 * day it was drawn for, because a check-in delivered the following afternoon is
 * worse than none.
 */
export function isMissed(row, now, tz, settings) {
  if (row.sent_at || row.suppressed_reason) return false;
  if (row.scheduled_for > now) return false;
  return derive(now, tz, settings.day_boundary_hour).logical_day === row.logical_day;
}

/**
 * The buckets the nightly sweep offers, with a midpoint instant for each.
 *
 * Coarse buckets, never a time picker: buckets match how recall actually works,
 * and a picker invites invented precision about something remembered hours
 * later. Only buckets whose midpoint has already passed are offered — at a
 * 21:00 sweep, "late night" is still ahead, and backfilling it would be both a
 * lie and a future-dated event the write path rejects.
 */
export function recallBuckets(logicalDay, tz, now, settings = { day_boundary_hour: 4 }) {
  const [y, m, d] = logicalDay.split('-').map(Number);
  const defs = [
    { id: 'morning', label: 'morning', hour: 8, minute: 0, dayOffset: 0 },
    { id: 'afternoon', label: 'afternoon', hour: 14, minute: 30, dayOffset: 0 },
    { id: 'evening', label: 'evening', hour: 19, minute: 30, dayOffset: 0 },
    // 00:00–04:00 belongs to this logical day but the *next* calendar date.
    { id: 'late', label: 'late night', hour: 1, minute: 0, dayOffset: 1 },
  ];

  return defs
    .map(b => ({ ...b, ts: fromLocal(tz, y, m, d + b.dayOffset, b.hour, b.minute) }))
    .filter(b => b.ts <= now);
}
