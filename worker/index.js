// Cadence — one Worker serving the app shell and /api/*.
//
// Same origin throughout, so there is no CORS code here and there should never
// be any. Anything that isn't /api/* falls through to the static assets binding.
import { assertTimeZoneSupport } from './lib/time.js';
import { userFromRequest, signInWithGoogle } from './lib/auth.js';
import { getSettings, updateSettings, recordActivity } from './lib/settings.js';
import { onSeen, backfillWindow } from './lib/activity.js';
import {
  normalizeEvent, insertEvent, listEvents, deleteEvent,
  ValidationError, CONTEXT_TAGS, MODE_TAGS, KINDS,
} from './lib/events.js';
import { getStats } from './lib/stats.js';
import { derive } from './lib/time.js';
import { pusherFor, notification } from './lib/push.js';
import { runPlanner, planForUser } from './lib/planner.js';
import { recallBuckets } from './lib/schedule.js';
import { buildContext } from './lib/context.js';
import { rollingRelapses, dayRibbon, relapseGaps } from './lib/series.js';

export { DailyPushDO } from './do/daily-push.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export default {
  /**
   * The safety-net tick. Plans each user's check-in shortly after their own
   * 04:00 rollover and re-arms anything missed; it never sends directly.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runPlanner(env)
        .then(r => console.log('[cron]', JSON.stringify(r)))
        .catch(err => console.error('[cron]', err?.stack || err))
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      // Assets are matched before the Worker runs, so reaching here means no
      // such file. Serve the shell for anything that looks like a route.
      return env.ASSETS
        ? env.ASSETS.fetch(new Request(new URL('/', url), request))
        : new Response('not found', { status: 404 });
    }

    try {
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof ValidationError) return json({ error: err.message }, 400);
      console.error('unhandled', err?.stack || err);
      return json({ error: 'internal error' }, 500);
    }
  },
};

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // ── Public ────────────────────────────────────────────────────────────────

  // The client ID is public by definition and the page needs it before there is
  // any session, so this is unauthenticated on purpose. Serving it from here
  // rather than hardcoding it in the page keeps wrangler.toml the single source.
  if (path === '/api/config' && method === 'GET') {
    return json({
      google_client_id: env.GOOGLE_CLIENT_ID || null,
      configured: !!(env.GOOGLE_CLIENT_ID && env.TOKEN_SECRET),
      context_tags: CONTEXT_TAGS,
      mode_tags: MODE_TAGS,
      kinds: KINDS,
    });
  }

  // The VAPID public key is public by definition, and gating it means the
  // browser cannot subscribe at all.
  if (path === '/api/push/key' && method === 'GET') {
    return json({ key: env.VAPID_PUBLIC_KEY || null });
  }

  // `pushsubscriptionchange` fires in the service worker, which holds no session
  // token — so endpoint rotation cannot be authenticated the normal way. This
  // route is authorised by *possession of the old endpoint*: a capability URL
  // only that device and this server ever held. It can do exactly one thing,
  // swap one endpoint for another on a row that already exists, and it cannot
  // create a subscription or name a user.
  if (path === '/api/push/rotate' && method === 'POST') {
    const { old_endpoint, subscription } = await request.json().catch(() => ({}));
    if (!old_endpoint || !subscription?.endpoint || !subscription?.keys) {
      return json({ error: 'bad request' }, 400);
    }
    const row = await env.DB.prepare('SELECT user_id FROM push_subs WHERE endpoint = ?')
      .bind(old_endpoint).first();
    // Unknown endpoint: say nothing useful. A probe learns only that it guessed
    // wrong, which it already knew.
    if (!row) return json({ ok: false }, 404);

    await env.DB.prepare(
      `UPDATE push_subs SET endpoint = ?, p256dh = ?, auth = ?, fail_count = 0
       WHERE endpoint = ?`
    ).bind(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, old_endpoint)
      .run();
    return json({ ok: true });
  }

  if (path === '/api/auth/google' && method === 'POST') {
    const { id_token } = await request.json().catch(() => ({}));
    if (!id_token) return json({ error: 'sign-in failed' }, 400);
    try {
      const result = await signInWithGoogle(id_token, env);
      return json(result);
    } catch (err) {
      // One generic answer for every failure — a probe learns nothing about
      // which check it tripped.
      console.warn('sign-in rejected:', err.message);
      return json({ error: 'sign-in failed' }, 401);
    }
  }

  // ── Authenticated ─────────────────────────────────────────────────────────

  const userId = await userFromRequest(request, env);
  if (!userId) return json({ error: 'unauthorized' }, 401);

  const db = env.DB;
  const tz = request.headers.get('X-TZ') || url.searchParams.get('tz') || null;

  // Records that the app was opened, and reports any gap that opening revealed.
  // The gap is computed *before* last_seen_at is bumped, so this single call is
  // both the write and the read with no ordering hazard.
  if (path === '/api/seen' && method === 'POST') {
    const settings = await getSettings(db, userId);
    const now = Date.now();

    const lastEvent = await db.prepare(
      'SELECT MAX(ts_utc) AS at FROM events WHERE user_id = ?'
    ).bind(userId).first();

    const result = onSeen({
      lastSeenAt: settings.last_seen_at,
      lastEventAt: lastEvent?.at ?? null,
      pendingGapStart: settings.pending_gap_start,
      now,
      staleAfterDays: settings.stale_after_days,
    });
    await recordActivity(db, userId, result);

    return json({
      needs_review: result.needs_review,
      gap_days: result.gap_days,
      gap_start: result.pending_gap_start,
      backfill: result.needs_review
        ? backfillWindow({
            gapStart: result.pending_gap_start,
            now,
            backfillWindowDays: settings.backfill_window_days,
          })
        : null,
    });
  }

  // The user has accounted for the gap: nothing happened while they were away.
  // Clearing pending_gap_start is what stops the prompt returning; it never
  // touches the streak, which only a logged relapse can move.
  if (path === '/api/seen/vouch' && method === 'POST') {
    const settings = await getSettings(db, userId);
    await recordActivity(db, userId, {
      last_seen_at: Date.now(),
      pending_gap_start: null,
    });
    return json({ ok: true, vouched_days: settings.pending_gap_start
      ? Math.floor((Date.now() - settings.pending_gap_start) / 86_400_000) : 0 });
  }

  if (path === '/api/me' && method === 'GET') {
    return json({ user_id: userId, settings: await getSettings(db, userId) });
  }

  if (path === '/api/events' && method === 'POST') {
    const body = await request.json().catch(() => null);
    // Accept one event or a batch — the offline queue flushes several at once,
    // and one round trip beats N over a phone connection that just came back.
    const raw = Array.isArray(body) ? body : [body];
    if (!raw.length || raw.length > 100) return json({ error: 'expected 1–100 events' }, 400);

    const settings = await getSettings(db, userId);
    const now = Date.now();
    const results = [];
    for (const item of raw) {
      try {
        const ev = normalizeEvent(item, settings, now);
        const { stored } = await insertEvent(db, userId, ev);
        results.push({ id: ev.id, ok: true, stored });
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        // A permanently-bad event must not wedge the offline queue behind it,
        // so it is reported per-item and the client drops it rather than
        // retrying forever.
        results.push({ id: item?.id ?? null, ok: false, error: err.message });
      }
    }
    return json({ results }, results.every(r => r.ok) ? 200 : 207);
  }

  if (path === '/api/events' && method === 'GET') {
    const p = url.searchParams;
    return json({
      events: await listEvents(db, userId, {
        from: p.has('from') ? Number(p.get('from')) : null,
        to: p.has('to') ? Number(p.get('to')) : null,
        day: p.get('day'),
        limit: p.get('limit'),
      }),
    });
  }

  if (path.startsWith('/api/events/') && method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/events/'.length));
    return json(await deleteEvent(db, userId, id));
  }

  if (path === '/api/stats' && method === 'GET') {
    const settings = await getSettings(db, userId);
    return json(await getStats(db, userId, tz, settings));
  }

  // ── Push (transport only — nothing here schedules anything) ───────────────

  if (path === '/api/push/subscribe' && method === 'POST') {
    const { subscription } = await request.json().catch(() => ({}));
    if (!subscription?.endpoint) return json({ error: 'no subscription' }, 400);
    const push = pusherFor(env);
    await push.subscribe(userId, subscription);
    // Remember the zone the device is in; phase 2's planner reads it, and it is
    // free to record now.
    if (tz) {
      await db.prepare('UPDATE push_subs SET tz = ? WHERE endpoint = ?')
        .bind(tz, subscription.endpoint).run();
    }
    return json({ ok: true, devices: (await push.list(userId)).length });
  }

  if (path === '/api/push/unsubscribe' && method === 'POST') {
    const { endpoint } = await request.json().catch(() => ({}));
    const push = pusherFor(env);
    await push.unsubscribe(userId, endpoint || { all: true });
    return json({ ok: true, devices: (await push.list(userId)).length });
  }

  if (path === '/api/push/status' && method === 'GET') {
    const push = pusherFor(env);
    const subs = await push.list(userId);
    return json({
      devices: subs.length,
      // Enough to tell "this device is registered" from "some other device is",
      // without shipping the full capability URL back to the page.
      endpoints: subs.map(s => s.endpoint.slice(-12)),
    });
  }

  // The skill's hidden test trigger. Turns "notifications don't work" into a
  // status code: 201 accepted, 403 VAPID mismatch, 400 encryption, 410 gone.
  if (path === '/api/push/test' && method === 'POST') {
    const push = pusherFor(env);
    const result = await push.send(userId, notification('Test notification — the wiring works.'));
    return json(result, result.sent > 0 ? 200 : 502);
  }

  // The nightly sweep's inputs. Bucket midpoints are derived here rather than
  // in the client so there is one implementation of "which local instant does
  // 'afternoon on this logical day' mean", and so the filtering of buckets that
  // haven't happened yet can't drift from the write path's future-date check.
  if (path === '/api/sweep' && method === 'GET') {
    if (!tz) return json({ error: 'no timezone' }, 400);
    const settings = await getSettings(db, userId);
    const now = Date.now();
    const today = derive(now, tz, settings.day_boundary_hour).logical_day;

    const events = await listEvents(db, userId, { day: today });
    // Answered here rather than in the client so "today's morning reading" has
    // one definition. The sweep uses it to show what the morning already said
    // instead of asking again at 21:00 — a night-time recall of a morning fact
    // is exactly what the morning prompt exists to avoid.
    const morning = events.find(e => e.morning_wood != null);
    return json({
      logical_day: today,
      events,
      buckets: recallBuckets(today, tz, now, settings)
        .map(b => ({ id: b.id, label: b.label, ts_utc: b.ts })),
      // `daily` only: a morning answer is not a review of the day.
      confirmed: events.some(e => e.kind === 'daily'),
      morning_wood: morning ? morning.morning_wood : null,
    });
  }

  // Marks the notification as opened, for phase 5's attribution. Best-effort:
  // a missing or unknown id is not an error worth surfacing to the client.
  if (path === '/api/notifications/opened' && method === 'POST') {
    const { id } = await request.json().catch(() => ({}));
    if (id) {
      await db.prepare(
        'UPDATE notifications SET opened_at = ? WHERE id = ? AND user_id = ? AND opened_at IS NULL'
      ).bind(Date.now(), id, userId).run();
    }
    return json({ ok: true });
  }

  // Manual trigger for the planner, so phase 2 can be exercised without waiting
  // for a cron tick. Plans only — it cannot make a send happen.
  if (path === '/api/sweep/plan' && method === 'POST') {
    return json(await planForUser(env, userId));
  }

  // Builds the text handed to an outside chatbot. Server-side because the
  // aggregation is the same code the stats path uses, and because the naming
  // rule is one decision that should live in one place.
  //
  // `term` arrives per request and is never stored: §0 keeps the word for the
  // behaviour out of anywhere it could be read, and a column in D1 is exactly
  // the kind of place it would quietly persist.
  if (path === '/api/context' && method === 'GET') {
    const p = url.searchParams;
    const settings = await getSettings(db, userId);
    const [stats, events] = await Promise.all([
      getStats(db, userId, tz, settings),
      listEvents(db, userId, { from: Date.now() - 90 * 86_400_000, limit: 500 }),
    ]);
    return json({
      text: buildContext({
        mode: p.get('mode') === 'now' ? 'now' : 'reflect',
        stats,
        events,
        term: p.get('term') || null,
        includeNotes: p.get('notes') === '1',
      }),
    });
  }

  // Chart series, computed here so there is one implementation of every
  // definition and the client cannot drift from it.
  if (path === '/api/series' && method === 'GET') {
    if (!tz) return json({ error: 'no timezone' }, 400);
    const settings = await getSettings(db, userId);
    const days = Math.min(Number(url.searchParams.get('days')) || 60, 365);
    const now = Date.now();

    // Paging back through time. The window ends on `end`; everything before it
    // still has to be loaded, because both series need history *behind* the
    // window to know whether they are allowed to draw at all.
    const endDay = url.searchParams.get('end');

    const events = await listEvents(db, userId, { limit: 5000 });
    const firstTs = events.length ? Math.min(...events.map(e => e.ts_utc)) : null;

    return json({
      end_day: endDay,
      // So the client can stop offering "older" once it runs out of history.
      tracking_since: firstTs ? derive(firstTs, tz, settings.day_boundary_hour).logical_day : null,
      rolling: rollingRelapses({ events, tz, settings, now, days, endDay }),
      ribbon: dayRibbon({ events, tz, settings, now, days, endDay }),
      ...relapseGaps({ events, tz, settings, now, days, endDay }),
    });
  }

  if (path === '/api/settings' && method === 'PATCH') {
    const patch = await request.json().catch(() => ({}));
    return json(await updateSettings(db, userId, patch));
  }

  return json({ error: 'not found' }, 404);
}

// Fail at module load on a runtime without full ICU rather than silently
// filing every event under UTC. Cheap, and the alternative is data that looks
// fine and is wrong from the first event onward.
assertTimeZoneSupport();
