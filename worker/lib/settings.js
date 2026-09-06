// Per-user settings, with the schema defaults mirrored here so a user with no
// row behaves identically to one with an untouched row. Phase 2 reads the push
// fields; phase 1 only needs day_boundary_hour and backfill_window_days.

export const DEFAULT_SETTINGS = {
  daily_checkin_hour: 21,
  morning_checkin_hour: 10,
  morning_checkin_enabled: 1,
  daily_jitter_minutes: 25,
  min_push_gap_minutes: 120,
  day_boundary_hour: 4,
  backfill_window_days: 3,
  risk_notifs_enabled: 0,
  max_pushes_per_day: 3,
  stale_after_days: 3,
  // NULL until answered; 'wanted' or 'declined' thereafter.
  lock_intent: null,
};

// Recorded state rather than preferences: they live in the same row for
// convenience, but they are not things the user sets and updateSettings must
// not accept them from a PATCH body.
export const ACTIVITY_FIELDS = { last_seen_at: null, pending_gap_start: null };

export async function getSettings(db, userId) {
  const row = await db.prepare('SELECT * FROM settings WHERE user_id = ?').bind(userId).first();
  if (!row) return { user_id: userId, ...DEFAULT_SETTINGS, ...ACTIVITY_FIELDS };
  // COALESCE in JS rather than SQL: a column added later is NULL on old rows,
  // and a NULL boundary hour would derive every event into 1970.
  const out = { user_id: userId };
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) out[k] = row[k] ?? v;
  for (const k of Object.keys(ACTIVITY_FIELDS)) out[k] = row[k] ?? null;
  return out;
}

export async function updateSettings(db, userId, patch) {
  const keys = Object.keys(patch).filter(k => k in DEFAULT_SETTINGS);
  if (!keys.length) return getSettings(db, userId);

  const cols = keys.join(', ');
  const placeholders = keys.map(() => '?').join(', ');
  const updates = keys.map(k => `${k} = excluded.${k}`).join(', ');
  await db.prepare(
    `INSERT INTO settings (user_id, ${cols}) VALUES (?, ${placeholders})
     ON CONFLICT(user_id) DO UPDATE SET ${updates}`
  ).bind(userId, ...keys.map(k => patch[k])).run();

  return getSettings(db, userId);
}

/**
 * Record activity state. Separate from updateSettings so a PATCH from the
 * client can never write these — they are observations, not preferences.
 */
export async function recordActivity(db, userId, { last_seen_at, pending_gap_start }) {
  await db.prepare(
    `INSERT INTO settings (user_id, last_seen_at, pending_gap_start)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       pending_gap_start = excluded.pending_gap_start`
  ).bind(userId, last_seen_at, pending_gap_start).run();
}
