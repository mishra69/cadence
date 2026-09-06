// The sender half of phase 2 (plan §5). A Durable Object alarm, because a cron
// can only fire on its own tick boundary and would quantise every notification
// to :00 or :30 — which reads as more mechanical, not less. An alarm fires at
// arbitrary minute precision, so the jitter the planner drew is actually
// delivered.
//
// This object decides nothing about *when*. It decides, at the moment of
// firing, whether the send is still allowed.
import { getSettings } from '../lib/settings.js';
import { sendDecision } from '../lib/schedule.js';
import { currentTz } from '../lib/planner.js';
import { pusherFor, notification } from '../lib/push.js';
import { derive, streakDays } from '../lib/time.js';
import { dailyBody, morningBody } from '../lib/planner.js';

export class DailyPushDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const { userId, notificationId, at } = await request.json();
    await this.state.storage.put({ userId, notificationId, at });
    // setAlarm replaces any existing one, which is exactly right: there is only
    // ever one pending daily check-in per user, and a re-arm should supersede.
    await this.state.storage.setAlarm(at);
    return Response.json({ armed: at });
  }

  async alarm() {
    const { userId, notificationId } = await this.state.storage.get(['userId', 'notificationId'])
      .then(m => ({ userId: m.get('userId'), notificationId: m.get('notificationId') }));
    if (!userId || !notificationId) return;

    const db = this.env.DB;
    const now = Date.now();

    const row = await db.prepare('SELECT * FROM notifications WHERE id = ?')
      .bind(notificationId).first();
    // Already resolved by a re-arm racing this alarm, or deleted. Nothing to do.
    if (!row || row.sent_at || row.suppressed_reason) return;

    const tz = await currentTz(db, userId);
    if (!tz) return;

    const settings = await getSettings(db, userId);
    const today = derive(now, tz, settings.day_boundary_hour).logical_day;

    // One query answers both the gap and the cap. The plan is explicit that the
    // cap is enforced here rather than by a sweep that disarms alarms: an armed
    // alarm is a prediction, and the authoritative answer only exists now.
    const agg = await db.prepare(
      `SELECT MAX(sent_at) AS last_sent_at,
              SUM(CASE WHEN logical_day = ? THEN 1 ELSE 0 END) AS sent_today
       FROM notifications
       WHERE user_id = ? AND sent_at IS NOT NULL`
    ).bind(today, userId).first();

    const decision = sendDecision({
      now,
      tz,
      lastSentAt: agg?.last_sent_at ?? null,
      sentToday: agg?.sent_today ?? 0,
      settings,
    });

    if (!decision.send) {
      // Recording the suppression is cheap and worth it: otherwise suppressed
      // notifications are invisible, and phase 5's attribution analysis loses
      // exactly its control cases.
      await db.prepare('UPDATE notifications SET suppressed_reason = ? WHERE id = ?')
        .bind(decision.reason, notificationId).run();
      return;
    }

    // Built now rather than at plan time: the row was written at the 04:00
    // rollover and "Day 12" has to be true at 21:00, not seventeen hours ago.
    let body = row.body;
    let action = 'sweep';
    if (row.kind === 'morning_check') {
      body = morningBody();
      action = 'morning';
    } else {
      const lastRelapse = await db.prepare(
        "SELECT MAX(ts_utc) AS at FROM events WHERE user_id = ? AND kind = 'relapse'"
      ).bind(userId).first();
      body = dailyBody({ streakDays: streakDays(lastRelapse?.at ?? null, now) });
    }

    try {
      const push = pusherFor(this.env);
      // The id rides along so the client can report the open. Without it
      // opened_at stays null forever and phase 5 has no attribution to work with.
      const result = await push.send(userId, notification(body, {
        navigate: `/?action=${action}&n=${encodeURIComponent(notificationId)}`,
      }));

      if (result.sent > 0) {
        // Store what was actually sent, not what was planned — phase 5's
        // attribution compares outcomes against the wording that landed.
        await db.prepare('UPDATE notifications SET sent_at = ?, body = ? WHERE id = ?')
          .bind(now, body, notificationId).run();
      } else {
        // Every device is gone or refusing. Not a suppression decision, so it
        // is recorded distinctly — this is a delivery failure.
        await db.prepare('UPDATE notifications SET suppressed_reason = ? WHERE id = ?')
          .bind('no_device', notificationId).run();
      }
    } catch (err) {
      console.error('[daily-push] send failed', err?.stack || err);
      // Left unsent and unsuppressed on purpose: the next safety-net tick sees
      // it as missed and re-arms, which is the right response to a transient
      // failure. The logical-day check in isMissed() stops that retrying past
      // the day it was meant for.
    }
  }
}
