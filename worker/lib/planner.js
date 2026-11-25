// The planner half of phase 2 (plan §5). Decides *when*; the Durable Object
// alarm in do/daily-push.js decides *whether*, at fire time, and delivers.
//
// Runs on the safety-net cron. The plan describes this as "the 04:00 rollover
// plus a cron every 30 min"; with a per-user timezone there is no single wall
// clock a cron can fire at, so the rollover is implemented as "the first tick
// after this user's logical day changed". The effect is the same and it needs
// no assumption about where the phone is: the target is drawn within half an
// hour of 04:00 local, which is many hours before the window, so the full ±25
// minutes of jitter is genuinely available.
import { derive } from './time.js';
import { getSettings } from './settings.js';
import { drawMorningTarget, isMissed } from './schedule.js';

/**
 * The zone to plan in: whatever the phone last reported. Push subscriptions
 * carry it, and events carry it — the most recent wins, so the schedule
 * self-corrects within a day of landing somewhere new. That self-correction is
 * why recompute-and-re-arm-on-tz-change was cut (Appendix A).
 */
export async function currentTz(db, userId) {
  const row = await db.prepare(
    `SELECT tz FROM (
       SELECT tz, ts_utc AS at FROM events WHERE user_id = ? AND tz IS NOT NULL
       UNION ALL
       SELECT tz, created_at AS at FROM push_subs WHERE user_id = ? AND tz IS NOT NULL
     ) ORDER BY at DESC LIMIT 1`
  ).bind(userId, userId).first();
  return row?.tz || null;
}

/** Every user with at least one live push subscription. */
export async function usersToPlan(db) {
  const { results } = await db.prepare(
    'SELECT DISTINCT user_id FROM push_subs'
  ).all();
  return (results || []).map(r => r.user_id);
}

/**
 * Plan today's check-in for one user, and re-arm anything missed.
 *
 * Idempotent by (user, kind, logical_day): once a row exists for the day, the
 * target it holds is never redrawn. That persistence is the point — a jitter
 * re-drawn on every safety-net tick would slide the target forward all evening
 * and might never be reached.
 *
 * @returns {Promise<{action:string, scheduled_for?:number, logical_day?:string}>}
 */
export async function planForUser(env, userId, { now = Date.now(), rng = Math.random } = {}) {
  const db = env.DB;
  const tz = await currentTz(db, userId);
  // No timezone on record means no event and no subscription has ever reported
  // one. There is nothing to plan against, and guessing UTC would be worse.
  if (!tz) return { action: 'no-tz' };

  const settings = await getSettings(db, userId);
  const logicalDay = derive(now, tz, settings.day_boundary_hour).logical_day;

  // The evening "confirm the day" notification is retired: the day is no
  // longer confirmed, and a nightly ping to do nothing in particular is noise.
  // The morning reminder is the only one planned; it is sent only if the
  // morning has not already been logged (checked at fire time, in the DO).
  const out = {};
  if (settings.morning_checkin_enabled) {
    out.morning = await planKind(env, userId, 'morning_check', { tz, settings, logicalDay, now, rng });
  }
  return out;
}

/**
 * Plan one notification kind for one day.
 *
 * Kinds are planned independently and delivered by separate Durable Objects —
 * one per (user, kind), as §5 requires, because a DO holds exactly one alarm and
 * sharing it would mean whichever was armed second silently overwrote the first.
 */
async function planKind(env, userId, kind, { tz, settings, logicalDay, now, rng }) {
  const db = env.DB;

  const existing = await db.prepare(
    `SELECT * FROM notifications
     WHERE user_id = ? AND kind = ? AND logical_day = ?`
  ).bind(userId, kind, logicalDay).first();

  if (existing) {
    // Already planned. The only thing left is to notice an alarm that never
    // fired — Durable Objects can lose one to eviction, a deploy or clock skew
    // — and re-arm it rather than skip the day.
    if (isMissed(existing, now, tz, settings)) {
      await armAlarm(env, userId, kind, existing.id, now + 1000);
      return { action: 're-armed', scheduled_for: existing.scheduled_for, logical_day: logicalDay };
    }
    return { action: 'already-planned', scheduled_for: existing.scheduled_for, logical_day: logicalDay };
  }

  const target = drawMorningTarget(logicalDay, tz, settings, rng);

  // A day that has already run past its own window — first install in the
  // evening, say — gets nothing rather than an immediate ping. Tomorrow's
  // rollover will plan properly.
  if (target < now) {
    await db.prepare(
      `INSERT INTO notifications (id, user_id, kind, body, source, logical_day,
                                  scheduled_for, sent_at, suppressed_reason)
       VALUES (?, ?, ?, ?, 'fallback', ?, ?, NULL, 'gap')`
    ).bind(crypto.randomUUID(), userId, kind, bodyFor(kind), logicalDay, target).run();
    return { action: 'too-late', logical_day: logicalDay };
  }

  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO notifications (id, user_id, kind, body, source, logical_day, scheduled_for)
     VALUES (?, ?, ?, ?, 'fallback', ?, ?)`
  ).bind(id, userId, kind, bodyFor(kind), logicalDay, target).run();

  await armAlarm(env, userId, kind, id, target);
  return { action: 'planned', scheduled_for: target, logical_day: logicalDay };
}

function bodyFor() {
  return morningBody();
}

/**
 * One Durable Object per (user, kind). A DO holds exactly one alarm, so sharing
 * one across daily and risk notifications would mean whichever was armed second
 * silently overwrote the first. Separate objects sidestep the coordination
 * entirely and cost nothing at a handful of alarms a day. The tradeoff is that
 * they cannot see each other, which is why min_push_gap_minutes is re-checked
 * against D1 at fire time rather than coordinated between them.
 */
export async function armAlarm(env, userId, kind, notificationId, at) {
  // Same class, distinct instance per kind — that is what gives each kind its
  // own alarm without any coordination between them.
  const id = env.DAILY_PUSH.idFromName(`${userId}:${kind}`);
  const stub = env.DAILY_PUSH.get(id);
  await stub.fetch('https://do/arm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, notificationId, at }),
  });
}

/**
 * The morning reminder. Nothing on a lock screen that says what it is about —
 * "Morning check" is as much as it ever reveals.
 */
export function morningBody() {
  return 'Morning check — not logged yet.';
}

/** The cron entry point. */
export async function runPlanner(env, { now = Date.now(), rng = Math.random } = {}) {
  const users = await usersToPlan(env.DB);
  const out = [];
  for (const userId of users) {
    try {
      out.push({ userId, ...(await planForUser(env, userId, { now, rng })) });
    } catch (err) {
      // One user's bad state must not stop the tick for everyone else.
      console.error('[planner]', userId, err?.stack || err);
      out.push({ userId, action: 'error', error: String(err) });
    }
  }
  return out;
}
