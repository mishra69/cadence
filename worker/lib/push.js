// Web Push transport (skill: "Notifications"). Phase 2 will sit on top of this;
// nothing here schedules anything. The only way to fire a notification today is
// the test trigger in Settings, by hand.
//
// Encryption and VAPID signing come from webpush-edge — Apple accepts only the
// aes128gcm coding and answers the older one with 201 and no notification, so
// hand-rolling this produces a failure that looks like success.
import { createPusher } from 'webpush-edge';

/**
 * A `{ get, set }` store over the existing push_subs table (§2 schema).
 *
 * webpush-edge hands back the *whole* subscription list on every change, so the
 * naive implementation is "delete all, reinsert". That resets created_at and
 * fail_count on every write and defeats the upsert, so this diffs instead:
 * endpoints that disappeared are deleted, the rest are upserted on the endpoint
 * unique index and keep their history.
 */
export function d1Store(db) {
  return {
    async get(userId) {
      const { results } = await db.prepare(
        'SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?'
      ).bind(userId).all();
      return (results || []).map(r => ({
        endpoint: r.endpoint,
        keys: { p256dh: r.p256dh, auth: r.auth },
      }));
    },

    async set(userId, subs) {
      const now = Date.now();
      const keep = (subs || []).map(s => s.endpoint);

      const statements = [];
      if (keep.length) {
        statements.push(
          db.prepare(
            `DELETE FROM push_subs WHERE user_id = ?
              AND endpoint NOT IN (${keep.map(() => '?').join(',')})`
          ).bind(userId, ...keep)
        );
      } else {
        statements.push(db.prepare('DELETE FROM push_subs WHERE user_id = ?').bind(userId));
      }

      for (const s of subs || []) {
        statements.push(
          db.prepare(
            `INSERT INTO push_subs (id, user_id, endpoint, p256dh, auth, created_at, last_ok_at, fail_count)
             VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
             ON CONFLICT(endpoint) DO UPDATE SET
               user_id = excluded.user_id,
               p256dh  = excluded.p256dh,
               auth    = excluded.auth`
          ).bind(crypto.randomUUID(), userId, s.endpoint, s.keys.p256dh, s.keys.auth, now)
        );
      }

      await db.batch(statements);
    },
  };
}

export function pusherFor(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK) {
    throw new Error('VAPID keys are not configured');
  }
  return createPusher({
    publicKey: env.VAPID_PUBLIC_KEY,
    privateJwk: env.VAPID_PRIVATE_JWK,
    contact: env.PUSH_CONTACT || 'mailto:mishabhi@gmail.com',
    store: d1Store(env.DB),
  });
}

/**
 * Every notification body must be readable on a lock screen in public (§0).
 * Push text is the highest-priority privacy item in the plan, because it appears
 * without me choosing to show it — so the app name is all the title ever says,
 * and the body never alludes to what is tracked.
 */
export function notification(body, { navigate = '/' } = {}) {
  return {
    title: 'Cadence',
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    navigate,
    // A tag means a new notification replaces the old one rather than stacking
    // — a column of identical alerts on a lock screen is its own kind of leak.
    tag: 'cadence',
  };
}
