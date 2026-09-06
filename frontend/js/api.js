// API client and the offline outbox.
//
// The contract the rest of the app relies on: log() never fails and never
// blocks. If the network is there the event goes straight up; if it isn't, it
// lands in the outbox and the UI moves on exactly as it would have. Logging
// happens in the moment an urge is running, and a spinner or a retry dialog at
// that moment is the app asking for attention — which is the one thing it must
// never do (§0).

const API = (() => {
  const TOKEN_KEY = 'cadence.token';

  const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  class HttpError extends Error {
    constructor(status, body) {
      super(body?.error || `HTTP ${status}`);
      this.status = status;
      this.body = body;
    }
  }

  // A hung request is worse than a failed one. On an iOS cold launch the radio
  // is often still waking, and fetch stalls rather than rejecting — so anything
  // awaited before first paint can hang the app forever with no error to catch.
  // Every request gets a deadline; callers already handle rejection.
  const TIMEOUT_MS = 8000;

  async function request(path, { method = 'GET', body, auth = true, timeout = TIMEOUT_MS } = {}) {
    const headers = { 'X-TZ': tz() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      const t = getToken();
      if (!t) throw new HttpError(401, { error: 'no session' });
      headers.Authorization = `Bearer ${t}`;
    }

    // AbortController rather than AbortSignal.timeout: this has to work on
    // whatever iOS version the phone happens to be on.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    let res;
    try {
      res = await fetch(path, {
        method, headers,
        signal: ac.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new HttpError(0, { error: ac.signal.aborted ? 'timed out' : 'offline' });
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 207) throw new HttpError(res.status, data);
    return data;
  }

  // ── Sign-in ───────────────────────────────────────────────────────────────

  async function config() { return request('/api/config', { auth: false }); }

  async function signIn(idToken) {
    const r = await request('/api/auth/google', {
      method: 'POST', body: { id_token: idToken }, auth: false,
    });
    setToken(r.token);
    await IDB.put('profile', r.user);
    // Don't block sign-in on it — the avatar is decoration, and the URL still
    // works as a plain <img> src even if this fails.
    cacheAvatar(r.user).catch(() => {});
    return r.user;
  }

  /** The signed-in user, from the last sign-in. Null before one. */
  async function profile() { return (await IDB.get('profile')) || null; }

  /**
   * Store the avatar bytes as a data URL so it renders offline and stops being
   * a third-party request on every launch.
   *
   * Best-effort by design: the URL is cross-origin, so this fetch depends on
   * Google serving CORS headers. When it doesn't, the caller falls back to the
   * remote URL — which works in an <img> regardless, just not offline.
   */
  async function cacheAvatar(user) {
    if (!user?.picture) return null;
    const res = await fetch(user.picture, { mode: 'cors' });
    if (!res.ok) throw new Error(`avatar ${res.status}`);
    const blob = await res.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
    await IDB.put('avatar', dataUrl);
    return dataUrl;
  }

  /** A renderable avatar source: cached bytes first, then the remote URL. */
  async function avatarSrc() {
    const cached = await IDB.get('avatar');
    if (cached) return cached;
    return (await profile())?.picture || null;
  }

  function signedIn() { return !!getToken(); }

  async function signOut() {
    setToken(null);
    await IDB.clear();
  }

  /**
   * Drop the session but keep everything else. Used when the server stops
   * accepting the token: the cached profile, the outbox and the device's lock
   * are all still valid and re-signing-in should restore the app, not rebuild it.
   */
  async function clearSession() { setToken(null); }

  // ── Events ────────────────────────────────────────────────────────────────

  /**
   * Record an event. Resolves as soon as it is durable *somewhere* — server or
   * outbox — and reports which, so the UI can say "saved on this device" rather
   * than pretending.
   * @returns {Promise<{queued:boolean, event:object}>}
   */
  async function log(partial) {
    const event = {
      id: crypto.randomUUID(),
      ts_utc: Date.now(),
      tz: tz(),
      ...partial,
    };

    // Queue first, then try to send. The other order loses the event if the tab
    // is killed between a failed request and the write.
    await IDB.queue(event);
    try {
      await flush();
      return { queued: (await IDB.pendingCount()) > 0, event };
    } catch {
      return { queued: true, event };
    }
  }

  let flushing = null;

  /** Send everything in the outbox. Safe to call concurrently and repeatedly. */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const pending = await IDB.pending();
      if (!pending.length || !getToken()) return { sent: 0 };

      const { results } = await request('/api/events', { method: 'POST', body: pending });
      let sent = 0;
      for (const r of results || []) {
        if (r.ok) { await IDB.dequeue(r.id); sent++; continue; }
        // A permanently-invalid event would otherwise wedge everything behind
        // it in the queue forever, so it is dropped rather than retried. The
        // server only rejects things that can never become valid.
        if (r.id) {
          console.warn('[api] dropping rejected event', r.id, r.error);
          await IDB.dequeue(r.id);
        }
      }
      return { sent };
    })().finally(() => { flushing = null; });
    return flushing;
  }

  async function pendingEvents() { return IDB.pending(); }
  async function pendingCount() { return IDB.pendingCount(); }

  async function events(params = {}) {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '')
    );
    const r = await request(`/api/events?${q}`);
    return r.events;
  }

  async function remove(id) { return request(`/api/events/${encodeURIComponent(id)}`, { method: 'DELETE' }); }

  // ── Stats ─────────────────────────────────────────────────────────────────

  /** Fresh stats if the network allows, otherwise the last good ones. */
  async function stats() {
    try {
      const s = await request('/api/stats');
      await IDB.put('stats', { at: Date.now(), value: s });
      return { ...s, stale: false };
    } catch (err) {
      if (err.status === 401) throw err;
      const cached = await IDB.get('stats');
      if (!cached) throw err;
      return { ...cached.value, stale: true, stale_since: cached.at };
    }
  }

  // ── Push ──────────────────────────────────────────────────────────────────
  //
  // The library half is loaded as a module and lands on window.Push after the
  // classic scripts run, so it is read at call time rather than captured.

  function pushSupport() {
    return window.Push ? window.Push.pushSupport() : { state: 'unsupported' };
  }

  /** Must be called from inside a user gesture — iOS requires it. */
  async function pushSubscribe() {
    if (!window.Push) return { ok: false, reason: 'unsupported' };
    return window.Push.subscribe({
      swPath: '/sw.js',
      keyUrl: '/api/push/key',
      // tz as a query param, not a header: the library builds this request
      // itself and only forwards the headers below, so X-TZ never arrives.
      subscribeUrl: `/api/push/subscribe?tz=${encodeURIComponent(tz())}`,
      // Our endpoints are bearer-gated; without this the library issues bare
      // fetches and /api/push/subscribe answers 401.
      headers: { Authorization: `Bearer ${getToken()}` },
    });
  }

  async function pushUnsubscribe() {
    if (!window.Push) return { ok: false };
    return window.Push.unsubscribe({
      swPath: '/sw.js',
      unsubscribeUrl: '/api/push/unsubscribe',
      headers: { Authorization: `Bearer ${getToken()}` },
    });
  }

  async function pushStatus() { return request('/api/push/status'); }

  /** Fires a real push through the real pipeline. Returns whatever happened. */
  async function pushTest() {
    try {
      return { ok: true, ...(await request('/api/push/test', { method: 'POST' })) };
    } catch (err) {
      return { ok: false, status: err.status, error: err.message, ...(err.body || {}) };
    }
  }

  /**
   * Record that the app was opened, and learn whether that revealed a gap.
   * One call does both, so the gap is measured before last_seen_at moves.
   */
  async function seen() { return request('/api/seen', { method: 'POST' }); }

  /** Account for a gap: nothing happened while away. Never moves the streak. */
  async function vouch() { return request('/api/seen/vouch', { method: 'POST' }); }

  /** The text to hand an outside chatbot. `term` is sent, never stored. */
  async function context({ mode = 'reflect', term = null, notes = false } = {}) {
    const q = new URLSearchParams({ mode });
    if (term) q.set('term', term);
    if (notes) q.set('notes', '1');
    return (await request(`/api/context?${q}`)).text;
  }

  /** Precomputed chart series for Progress. */
  async function series({ days = 63, end = null } = {}) {
    const q = new URLSearchParams({ days: String(days) });
    if (end) q.set('end', end);
    return request(`/api/series?${q}`);
  }

  /** Today's events plus the recall buckets that have already elapsed. */
  async function sweep() { return request('/api/sweep'); }

  /** Plan today's check-in now, instead of waiting for a cron tick. */
  async function planSweep() { return request('/api/sweep/plan', { method: 'POST' }); }

  /** Mark a notification opened, for phase 5's attribution. Never throws. */
  async function notificationOpened(id) {
    return request('/api/notifications/opened', { method: 'POST', body: { id } })
      .catch(() => ({ ok: false }));
  }

  async function settings(patch) {
    if (!patch) return (await request('/api/me')).settings;
    return request('/api/settings', { method: 'PATCH', body: patch });
  }

  // Flush opportunistically: on reconnect, and whenever the app comes back to
  // the foreground (iOS fires 'online' unreliably after a long suspend).
  addEventListener('online', () => flush().catch(() => {}));
  addEventListener('visibilitychange', () => {
    if (!document.hidden) flush().catch(() => {});
  });

  return {
    tz, config, signIn, signedIn, signOut, clearSession, getToken,
    profile, avatarSrc, cacheAvatar,
    log, flush, events, remove, stats, settings,
    pendingEvents, pendingCount,
    pushSupport, pushSubscribe, pushUnsubscribe, pushStatus, pushTest,
    sweep, planSweep, notificationOpened, seen, vouch, context, series,
    HttpError,
  };
})();
