// The write path (plan §4). Validate, derive, insert once.
//
// Idempotency is the whole reason `id` is client-generated: the PWA queues
// writes in IndexedDB when offline and flushes them on reconnect, and a flush
// that half-succeeds must be safe to repeat.
import { derive, isValidTimeZone, DAY_MS } from './time.js';

export const KINDS = ['urge', 'relapse', 'daily', 'note'];

// Fixed vocabulary. Free-text tags would fragment ('tired' vs 'sleepy') and
// make the phase 4 contrast between urge and relapse distributions meaningless.
//
// Situational: the circumstances around an event. Recorded on BOTH urges and
// relapses, because comparing the two distributions is what replaces per-urge
// outcome (§7).
export const CONTEXT_TAGS = ['alone', 'in_bed', 'phone', 'tired', 'bored', 'stressed'];

// What was involved. A separate group from CONTEXT_TAGS in the UI — a different
// question, asked separately — but recorded on urges *and* relapses.
//
// Urges too, because an episode can go down the path without finishing it: the
// material was involved even though no relapse followed. That also makes these
// legitimate inputs to the §7 contrast. Were they relapse-only they would score
// a perfect lift by construction and dominate the risk list with a tautology;
// present on both sides, "on 80% of slips against 30% of urges" is real signal.
//
// Independent rather than exclusive: ticking both means both were involved, and
// ticking neither means not answered — which is not the same as "no porn", the
// same NULL-vs-zero distinction intensity and satisfaction already respect.
export const MODE_TAGS = ['porn', 'imagination'];

export const ALL_TAGS = [...CONTEXT_TAGS, ...MODE_TAGS];

const MAX_NOTE = 2000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;   // phone clocks drift; a few minutes is not a lie

export class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate and normalise one client event. Pure — no I/O, so it is testable
 * without a database.
 * @param {object} raw
 * @param {{day_boundary_hour:number, backfill_window_days:number}} settings
 * @param {number} now epoch ms
 */
export function normalizeEvent(raw, settings, now = Date.now()) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('not an object');

  const id = String(raw.id || '');
  if (!UUID_RE.test(id)) throw new ValidationError('id must be a UUID');

  const kind = String(raw.kind || '');
  if (!KINDS.includes(kind)) throw new ValidationError(`kind must be one of ${KINDS.join(', ')}`);

  const ts_utc = Number(raw.ts_utc);
  if (!Number.isFinite(ts_utc) || ts_utc <= 0) throw new ValidationError('ts_utc must be epoch ms');
  if (ts_utc > now + FUTURE_SKEW_MS) throw new ValidationError('ts_utc is in the future');

  const tz = String(raw.tz || '');
  // An offset like '+05:30' means different places in March and November, and
  // DST rules change under you. Only the zone name stays interpretable.
  if (!isValidTimeZone(tz)) throw new ValidationError('tz must be an IANA zone name');

  const recalled = raw.recalled ? 1 : 0;

  // The backfill window exists so a stale offline queue can't silently rewrite
  // history. Anything genuinely older has to say so — that is what `recalled`
  // marks, and phase 4 must keep recalled events separate because they are
  // systematically milder and fuzzier than live ones.
  const windowMs = settings.backfill_window_days * DAY_MS;
  if (!recalled && ts_utc < now - windowMs) {
    throw new ValidationError(
      `ts_utc is older than the ${settings.backfill_window_days}-day backfill window; set recalled`
    );
  }

  let intensity = null;
  if (raw.intensity != null) {
    if (kind !== 'urge') throw new ValidationError('intensity is only valid on an urge');
    intensity = Number(raw.intensity);
    if (!Number.isInteger(intensity) || intensity < 0 || intensity > 5) {
      throw new ValidationError('intensity must be an integer 0–5');
    }
  }

  // The mirror of intensity, and validated the same way: how much it was
  // actually worth, kept so it can later be correlated against the gap it
  // ended. Relapse-only, because on any other kind it would mean nothing.
  let satisfaction = null;
  if (raw.satisfaction != null) {
    if (kind !== 'relapse') throw new ValidationError('satisfaction is only valid on a relapse');
    satisfaction = Number(raw.satisfaction);
    if (!Number.isInteger(satisfaction) || satisfaction < 0 || satisfaction > 5) {
      throw new ValidationError('satisfaction must be an integer 0–5');
    }
  }

  // Recorded on the daily check-in, not as its own event: it describes the day
  // rather than a moment.
  //
  //   0 = no, 1 = yes, 2 = don't recall
  //
  // Not a count. "Twice or three times" asks for a precision nobody actually
  // has hours later, and an unreliable number is worse than a reliable bit.
  //
  // "Don't recall" is a stored *answer*, distinct from NULL, which means the
  // question was never put. Rates must be computed over 0 and 1 only — counting
  // a 2 as a no would understate in a way that looks like a finding.
  let morning_wood = null;
  if (raw.morning_wood != null) {
    if (kind !== 'daily') throw new ValidationError('morning_wood is only valid on a daily check-in');
    morning_wood = Number(raw.morning_wood);
    if (!Number.isInteger(morning_wood) || morning_wood < 0 || morning_wood > 2) {
      throw new ValidationError('morning_wood must be 0 (no), 1 (yes) or 2 (don\'t recall)');
    }
  }

  let context = null;
  if (raw.context != null) {
    if (!Array.isArray(raw.context)) throw new ValidationError('context must be an array');
    const tags = [...new Set(raw.context.map(String))];
    for (const t of tags) {
      if (!ALL_TAGS.includes(t)) throw new ValidationError(`unknown context tag: ${t}`);
      // On a check-in or a note there is no episode for this to describe.
      if (MODE_TAGS.includes(t) && kind !== 'urge' && kind !== 'relapse') {
        throw new ValidationError(`${t} is only valid on an urge or a relapse`);
      }
    }
    // Sorted so the stored JSON is canonical and two identical tag sets compare
    // equal as strings — phase 4 groups on this.
    context = tags.length ? JSON.stringify(tags.sort()) : null;
  }

  let note = null;
  if (raw.note != null && String(raw.note).trim()) {
    note = String(raw.note).trim().slice(0, MAX_NOTE);
  }

  const { logical_day, local_hour, bucket } = derive(ts_utc, tz, settings.day_boundary_hour);

  return {
    id, kind, ts_utc, tz, logical_day, local_hour, bucket,
    intensity, satisfaction, morning_wood, context, note, recalled, created_at: now,
  };
}

/**
 * Insert an event, ignoring a repeat of one already stored.
 * @returns {Promise<{stored:boolean}>} stored:false means it was already there
 */
export async function insertEvent(db, userId, ev) {
  const res = await db.prepare(
    `INSERT INTO events
       (id, user_id, kind, ts_utc, tz, logical_day, local_hour, bucket,
        intensity, satisfaction, morning_wood, context, note, recalled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).bind(
    ev.id, userId, ev.kind, ev.ts_utc, ev.tz, ev.logical_day, ev.local_hour, ev.bucket,
    ev.intensity, ev.satisfaction, ev.morning_wood, ev.context, ev.note, ev.recalled, ev.created_at
  ).run();

  return { stored: (res.meta?.changes ?? 0) > 0 };
}

/** Rehydrate a stored row into the shape the client works with. */
export function rowToEvent(row) {
  return {
    id: row.id,
    kind: row.kind,
    ts_utc: row.ts_utc,
    tz: row.tz,
    logical_day: row.logical_day,
    local_hour: row.local_hour,
    bucket: row.bucket,
    intensity: row.intensity,
    satisfaction: row.satisfaction,
    morning_wood: row.morning_wood,
    context: row.context ? JSON.parse(row.context) : [],
    note: row.note,
    recalled: !!row.recalled,
  };
}

export async function listEvents(db, userId, { from, to, day, limit = 500 }) {
  const clauses = ['user_id = ?'];
  const binds = [userId];
  if (day) { clauses.push('logical_day = ?'); binds.push(day); }
  if (from != null) { clauses.push('ts_utc >= ?'); binds.push(from); }
  if (to != null) { clauses.push('ts_utc <= ?'); binds.push(to); }

  const { results } = await db.prepare(
    `SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY ts_utc DESC LIMIT ?`
  ).bind(...binds, Math.min(Number(limit) || 500, 2000)).all();

  return (results || []).map(rowToEvent);
}

/** Deleting is for a mis-tap, and nothing else. There is no edit path. */
export async function deleteEvent(db, userId, id) {
  const res = await db.prepare('DELETE FROM events WHERE user_id = ? AND id = ?')
    .bind(userId, id).run();
  return { deleted: (res.meta?.changes ?? 0) > 0 };
}
