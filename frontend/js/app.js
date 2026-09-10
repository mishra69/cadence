// Cadence — screens, rendering and boot.
//
// The load-bearing interaction rule (§0): the app must never sustain or
// initiate attention on the behaviour. Every path through here is short and
// terminal — enter, record, leave. There is no timer, no countdown, no queue of
// past events to resolve, and no screen that asks how an urge turned out. If a
// change to this file adds a reason to sit in the app while an urge is running,
// it is a bug however therapeutic it looks. Appendix A is the list of things
// that already died this way.

const App = (() => {
  const $ = id => document.getElementById(id);
  const screens = {};
  let stats = null;
  // Seeded with the real vocabulary, not empty: boot must never need the
  // network to render a usable log sheet. /api/config refines this later.
  let config = {
    context_tags: ['alone', 'in_bed', 'phone', 'tired', 'bored', 'stressed'],
    mode_tags: ['porn', 'imagination'],
    google_client_id: null,
  };
  let draft = null;
  let doneTimer = null;

  // Neutral, and true: nothing here hints at what is tracked, and installing is
  // what makes the lock screen and (phase 2) notifications work on iOS.
  const SUB = 'Works offline, and opens to its own lock screen.';

  // Fixed vocabulary from the server, rendered with human labels.
  const TAG_LABELS = {
    alone: 'alone', in_bed: 'in bed', phone: 'on my phone',
    tired: 'tired', bored: 'bored', stressed: 'stressed',
    porn: 'porn', imagination: 'imagination',
  };

  // ── Screen plumbing ───────────────────────────────────────────────────────

  // The only two screens the tab bar belongs on. It must not offer a way past
  // the lock screen, or a distraction mid-log.
  const TABBED = ['home', 'progress'];

  function show(name) {
    // Leaving the screen cancels a pending delete rather than carrying it.
    disarmDelete();
    closeAvatarMenu();
    for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
    $('app').hidden = false;

    $('tabs').hidden = !TABBED.includes(name);
    for (const t of document.querySelectorAll('.tab')) {
      t.setAttribute('aria-current', String(t.dataset.tab === name));
    }

    // The veil comes down only once something is actually on screen, so a cold
    // start never flashes the home screen before the lock.
    Lock.veil(false);
    if (name !== 'done' && doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
    renderLockWarning();
    // The screen scrolls itself now, not the document — scrollTo(0, 0) here
    // moved a window that no longer scrolls, leaving the new screen wherever
    // the last one had been left.
    screens[name]?.scrollTo(0, 0);
  }

  function toast(message, ms = 2400) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, ms);
  }

  const timeOf = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // Takes an explicit plural because naive +'s' produces "entrys".
  function plural(n, unit, many = unit + 's') { return `${n} ${n === 1 ? unit : many}`; }

  // ── Streak tumbler ────────────────────────────────────────────────────────

  const DAY_MS = 86_400_000;
  // Glass interior in viewBox units, matching the clip path in index.html.
  const GLASS_TOP = 4, GLASS_BOTTOM = 54;

  let tumblerFrom = null;   // last relapse, epoch ms

  /**
   * Fills as the current streak day does, emptying at each 24h tick.
   *
   * Anchored to the last relapse rather than to the logical day, because that
   * is what the streak itself counts — `streakDays` is elapsed time, not
   * calendar days (§3), so a fill tied to the 04:00 boundary would empty at a
   * different moment than the number above it increments.
   */
  function renderTumbler(now = Date.now()) {
    const host = $('tumbler');
    if (tumblerFrom == null) { host.hidden = true; return; }
    host.hidden = false;

    const elapsed = Math.max(0, now - tumblerFrom);
    const into = elapsed % DAY_MS;
    const frac = into / DAY_MS;
    const left = DAY_MS - into;
    const nextDay = Math.floor(elapsed / DAY_MS) + 1;

    const h = (GLASS_BOTTOM - GLASS_TOP) * frac;
    $('tumbler-fill').setAttribute('y', GLASS_BOTTOM - h);
    $('tumbler-fill').setAttribute('height', h);
    // Sits on top of the fill, clipped to the glass like everything else, so it
    // narrows with the taper instead of overhanging it.
    $('tumbler-meniscus').setAttribute('y', GLASS_BOTTOM - h);
    $('tumbler-meniscus').setAttribute('height', h > 0 ? 2 : 0);

    const hours = Math.floor(left / 3_600_000);
    const mins = Math.floor((left % 3_600_000) / 60_000);
    $('tumbler-value').textContent = hours ? `${hours}h ${mins}m` : `${mins}m`;
    $('tumbler-label').textContent = `to day ${nextDay}`;
  }

  // One timer for the life of the app rather than one per render: it costs
  // nothing when the screen is hidden, and starting and stopping it on every
  // navigation is more state than a minute tick is worth.
  setInterval(() => {
    if (!screens.progress?.hidden) renderTumbler();
  }, 30_000);

  // ── Home ──────────────────────────────────────────────────────────────────

  function renderStats(s) {
    const dash = '—';
    const d = v => (v == null ? dash : `${v}d`);

    // Never a relapse on record: there is no streak to report, so the slot says
    // how long there has been data rather than inventing a number.
    $('stat-current').textContent = s.streak_days == null
      ? (s.has_data ? d(s.days_tracked) : dash)
      : d(s.streak_days);
    $('stat-best').textContent = d(s.best_days);
    $('stat-typical').textContent = d(s.median_attempt_days);

    tumblerFrom = s.last_relapse_ts ?? null;
    renderTumbler();

    const parts = [];
    if (s.streak_days == null && s.has_data) parts.push('no relapse logged yet');
    if (s.coverage_days) {
      // Ignoring the app doesn't reset anything, but it visibly degrades the
      // data — which is the honest signal, and gentler than a broken streak.
      parts.push(`${s.confirmed_days} of ${plural(s.coverage_days, 'day')} confirmed`);
    }
    if (s.stale) parts.push('offline — showing the last figures');

    // Dim rather than alarm: the number has not changed, only how far the app
    // can vouch for it. Inactivity never resets anything (§3).
    const unverified = !!s.confidence?.unverified;
    $('stat-current').closest('.stat').classList.toggle('unverified', unverified);
    $('coverage').textContent = parts.join(' · ');
    if (unverified) {
      const note = document.createElement('span');
      note.className = 'unverified-note';
      note.textContent = `${parts.length ? ' · ' : ''}unconfirmed for ${
        plural(s.confidence.unverified_days, 'day')}`;
      $('coverage').append(note);
    }

    const facts = $('facts');
    facts.innerHTML = '';
    const row = (label, value, cls) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      if (cls) dd.className = cls;
      facts.append(dt, dd);
    };
    row('Urges, last 7 days', s.urges_7d);
    row('Urges, last 30 days', s.urges_30d);
    row('Relapses, last 30 days', s.relapses_30d);
    if (s.attempt_count) row('Attempts', s.attempt_count);
    // The ratio moves with logging discipline as much as with behaviour, so it
    // stays out of sight until the window can carry it, and never leads.
    if (s.resist.per_100 != null) {
      row('Relapses per 100 urges, 90d', s.resist.per_100);
    } else if (s.resist.urges_90d > 0) {
      row('Relapses per 100 urges', `needs ${s.resist.gated_until} more urges logged`, 'gated');
    }
  }

  // Which window the charts are showing. null = up to today.
  let chartEnd = null;
  const CHART_DAYS = 63;   // nine whole weeks

  async function renderCharts() {
    let s;
    try {
      s = await API.series({ days: CHART_DAYS, end: chartEnd });
    } catch {
      return;   // offline: the panels keep whatever they last drew
    }
    Charts.rolling($('chart-rolling'), s.rolling);
    Charts.ribbon($('chart-ribbon'), s.ribbon);

    // From the ribbon, not the rolling series: the title sits above the ribbon
    // and the week alignment makes it the wider of the two. Pads excluded —
    // they are days that have not happened, and dating the panel to one would
    // put a future date in the header.
    const drawn = s.ribbon.filter(d => d.state !== 'pad');
    const from = drawn[0]?.day;
    const to = drawn[drawn.length - 1]?.day;
    const fmt = d => new Date(`${d}T12:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short' });
    $('ribbon-title').textContent = from ? `${fmt(from)} – ${fmt(to)}` : 'Days';

    // Stop offering "earlier" once the window has run past the first event —
    // an empty page is worse than a disabled button.
    $('range-prev').disabled = !!(s.tracking_since && from && from <= s.tracking_since);
    $('range-next').disabled = chartEnd == null;
  }

  function shiftCharts(weeks) {
    const base = chartEnd ? Date.parse(`${chartEnd}T12:00:00Z`) : Date.now();
    const moved = base + weeks * 7 * 86_400_000;
    // Never page into the future: today is always the newest window.
    chartEnd = moved >= Date.now() ? null : new Date(moved).toISOString().slice(0, 10);
    renderCharts().catch(() => {});
  }

  function renderTimeline(listEl, events, { showDelete = true } = {}) {
    listEl.innerHTML = '';
    for (const ev of events) {
      const li = document.createElement('li');

      const time = document.createElement('span');
      time.className = 'ev-time';
      time.textContent = ev.pending ? '· · ·' : timeOf(ev.ts_utc);

      const body = document.createElement('div');
      body.className = 'ev-body';

      const kind = document.createElement('div');
      kind.className = `ev-kind ${ev.kind}`;
      kind.textContent = {
        urge: 'Urge', relapse: 'Relapse', daily: 'Day confirmed', note: 'Note',
      }[ev.kind] || ev.kind;
      if (ev.kind === 'urge' && ev.intensity != null) kind.textContent += ` · ${ev.intensity}/5`;
      if (ev.kind === 'relapse' && ev.satisfaction != null) kind.textContent += ` · worth ${ev.satisfaction}/5`;
      if (ev.kind === 'daily' && ev.morning_wood != null) {
        kind.textContent += ` · morning ${MORNING_LABELS[ev.morning_wood]}`;
      }
      body.append(kind);

      const bits = [];
      if (ev.context?.length) bits.push(ev.context.map(t => TAG_LABELS[t] || t).join(', '));
      if (ev.note) bits.push(ev.note);
      if (ev.recalled) bits.push('recalled');
      if (ev.pending) bits.push('on this device — not sent yet');
      if (bits.length) {
        const meta = document.createElement('div');
        meta.className = 'ev-meta';
        meta.textContent = bits.join(' — ');
        body.append(meta);
      }

      li.append(time, body);

      if (showDelete && !ev.pending) {
        const del = document.createElement('button');
        del.className = 'ev-del';
        del.textContent = '×';
        del.title = 'Delete';
        del.setAttribute('aria-label', 'Delete this entry');
        del.onclick = e => { e.stopPropagation(); armDelete(del, ev); };
        li.append(del);
      }
      listEl.append(li);
    }
  }

  // The × sits next to a row and is easy to catch by accident. The first tap
  // arms it, the second commits — inline rather than a dialog, so nothing
  // blocks the page and the row being deleted is visible while you decide.
  //
  // Confirmation rather than undo: the usual objection is that confirmations
  // train you to tap through them, but that needs repetition and deleting here
  // is rare. Undo would mean a pending-delete buffer, a timer, and a toast
  // action that is easy to miss — more moving parts for the same protection.
  let armedDelete = null;

  function disarmDelete() {
    if (!armedDelete) return;
    clearTimeout(armedDelete.timer);
    const { button } = armedDelete;
    armedDelete = null;
    if (button.isConnected) {
      button.textContent = '×';
      button.classList.remove('armed');
      button.setAttribute('aria-label', 'Delete this entry');
    }
  }

  function armDelete(button, ev) {
    if (armedDelete?.id === ev.id) return deleteEvent(ev);

    disarmDelete();
    button.textContent = 'Delete?';
    button.classList.add('armed');
    button.setAttribute('aria-label', 'Confirm deleting this entry');
    armedDelete = {
      id: ev.id,
      button,
      // Reverts on its own so an armed row can't sit there waiting to be
      // committed by an unrelated tap later.
      timer: setTimeout(disarmDelete, 4000),
    };
  }

  async function deleteEvent(ev) {
    disarmDelete();
    try {
      await API.remove(ev.id);
      toast('Deleted.');
      await refreshProgress();
      if (!screens.history.hidden) await renderHistory();
      if (!screens.sweep.hidden) await refreshSweepList();
    } catch {
      toast("Couldn't delete that — try again when you're online.");
    }
  }

  // Named for the screen it fills: Progress. Home has no data on it at all.
  async function refreshProgress() {
    try {
      stats = await API.stats();
    } catch (err) {
      if (err.status === 401) return sessionExpired();
      throw err;
    }
    renderStats(stats);
    // The warning reads lock_intent off stats, and show() paints before this
    // resolves — so on a cold start it would render the never-asked wording for
    // a lock that was actually lost. Re-render now that the intent is known.
    renderLockWarning();
    renderAccount().catch(() => {});
    renderCharts().catch(() => {});

    let events = [];
    let dayLoaded = false;
    if (stats.today) {
      try {
        events = await API.events({ day: stats.today });
        dayLoaded = true;
      } catch { /* offline: the outbox below is all there is */ }
    }

    // Anything still queued belongs on today's list — it happened, and hiding
    // it until the network returns would make the app look like it lost the log.
    const pending = (await API.pendingEvents()).map(e => ({ ...e, pending: true, context: e.context || [] }));
    const known = new Set(events.map(e => e.id));
    const merged = [...events, ...pending.filter(e => !known.has(e.id))]
      .sort((a, b) => b.ts_utc - a.ts_utc);

    renderTimeline($('today-list'), merged);
    // Offline, an empty list means "couldn't look", not "nothing happened".
    // Saying the latter would be the app inventing a fact about the day.
    $('today-empty').textContent = dayLoaded
      ? 'Nothing logged yet today.'
      : "Today's entries need a connection.";
    $('today-empty').hidden = merged.length > 0;
    renderConfirmButton(merged, dayLoaded);
  }

  // A one-tap confirmation that the day is accounted for. Phase 2 replaces the
  // prompting half of this with the nightly sweep; the action itself stays.
  function renderConfirmButton(todaysEvents, dayLoaded) {
    const list = $('today-list');
    const existing = $('btn-confirm-day');
    if (existing) existing.remove();

    // Offline the day can't be read back, so the button stays available rather
    // than disabled — logging is allowed to work offline, and a second `daily`
    // for the same day is harmless: coverage counts distinct logical days.
    const done = dayLoaded && todaysEvents.some(e => e.kind === 'daily');
    const btn = document.createElement('button');
    btn.id = 'btn-confirm-day';
    btn.className = 'btn btn-quiet btn-small';
    btn.style.marginTop = '8px';
    btn.textContent = done ? 'Day confirmed' : 'Confirm today';
    btn.disabled = done;
    btn.onclick = async () => {
      btn.disabled = true;
      await API.log({ kind: 'daily' });
      await refreshProgress();
    };
    list.parentElement.append(btn);
  }

  // ── The missing-lock warning ──────────────────────────────────────────────
  //
  // A gate that is silently absent is worse than one never set up: nothing
  // distinguishes "I turned it off" from "it disappeared and I never noticed".
  // This makes the state visible wherever the app is being used.

  /**
   * Two different situations wearing the same symptom.
   *
   * **Lost** — the server records that a lock was wanted, and this device has
   * none. That is the case this banner was built for: it went silently in a 401
   * and stayed gone for a week. Always warned about, and only silenced for the
   * session, because the next launch is exactly when you want reminding.
   *
   * **Declined** — a settled choice. Silent. Re-asking every launch about a
   * decision already made is nagging, it is the register §0 rules out, and it
   * is how an app gets deleted. Settings still shows the true state.
   *
   * **Never asked** — warn once; dismissing records 'declined'.
   *
   * The intent lives in D1 rather than localStorage precisely because a wipe
   * takes the lock and would take a local marker with it — leaving the app
   * unable to tell a loss from a choice, which is the whole distinction.
   */
  function lockWarningState() {
    if (!API.signedIn() || Lock.configured()) return null;
    const intent = stats?.lock_intent ?? null;
    if (intent === 'declined') return null;
    return intent === 'wanted' ? 'lost' : 'never';
  }

  /** Record the intent server-side. Never blocks the UI on it. */
  function setLockIntent(intent) {
    if ((stats?.lock_intent ?? null) === intent) return;
    if (stats) stats.lock_intent = intent;
    API.settings({ lock_intent: intent }).catch(() => {});
  }

  /**
   * Rendered into the empty half of the header row, beside the avatar.
   *
   * It was a fixed banner above the tab bar and that was wrong: it covered the
   * two buttons on Home, so the warning's cost was landing on the actions you
   * actually use. Up here it is unmissable and blocks nothing.
   */
  function renderLockWarning() {
    const state = lockWarningState();
    // Only a lost lock is snoozable; declining is recorded as intent, so there
    // is nothing session-scoped to track for that case.
    const snoozed = state === 'lost' && sessionStorage.getItem('cadence.lock_snooze') === '1';
    const show = !!(state && !snoozed);

    for (const slot of document.querySelectorAll('[data-lock-warn]')) {
      slot.innerHTML = '';
      if (!show) continue;

      const chip = document.createElement('div');
      chip.className = 'lock-chip';

      const label = document.createElement('button');
      label.className = 'lock-chip-text';
      label.textContent = state === 'lost' ? 'Lock is gone — set it up' : 'No lock set';
      label.title = state === 'lost'
        ? 'A lock was set up before and this device no longer has one.'
        : 'Anyone holding your phone can open this.';
      label.onclick = () => openSettingsFrom();

      const x = document.createElement('button');
      x.className = 'lock-chip-x';
      x.textContent = '×';
      x.setAttribute('aria-label', state === 'lost' ? 'Not now' : "Don't ask again");
      x.title = state === 'lost' ? 'Not now' : "Don't ask again";
      x.onclick = e => {
        e.stopPropagation();
        // Snooze a loss for the session; a never-asked becomes a recorded
        // decision, so it is not asked again on any device.
        if (lockWarningState() === 'lost') sessionStorage.setItem('cadence.lock_snooze', '1');
        else setLockIntent('declined');
        renderLockWarning();
      };

      chip.append(label, x);
      slot.append(chip);
    }
  }

  async function openSettingsFrom() {
    settingsReturnTo = TABBED.find(n => !screens[n].hidden) || 'home';
    show('settings');
    await renderSettings();
  }

  // ── Account menu ──────────────────────────────────────────────────────────
  //
  // The occasional destinations live here rather than in the bottom bar. The
  // bar is for the two places you actually live; History, Settings and the
  // sweep are somewhere you go on purpose, and giving them equal prominence
  // made Settings look like a primary action.

  // Settings opens from the avatar, which sits on both tabs — so Back returns
  // where you came from rather than always dropping you on Progress.
  let settingsReturnTo = 'home';

  // Mirrors worker/lib/settings.js DEFAULT_SETTINGS. Refreshed by loadSettings()
  // and by the Settings screen; the defaults stand until then.
  let appSettings = { day_boundary_hour: 4, backfill_window_days: 3 };

  function closeAvatarMenu() {
    const menu = $('avatar-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    for (const b of document.querySelectorAll('.avatar-btn')) {
      b.setAttribute('aria-expanded', 'false');
    }
  }

  function toggleAvatarMenu(trigger) {
    const menu = $('avatar-menu');
    const wasOpen = !menu.hidden;
    closeAvatarMenu();
    if (wasOpen) return;
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  }

  // ── Account ───────────────────────────────────────────────────────────────

  function initialsOf(user) {
    const source = (user?.name || user?.email || '?').trim();
    // Initials from a name; first letter from an email, where the part after
    // the @ says nothing about who this is.
    const words = source.split(/[\s.]+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : source[0] || '?').toUpperCase();
  }

  /** Fill an avatar element with the picture if there is one, initials if not. */
  async function paintAvatar(el, user, src) {
    el.textContent = '';
    if (!src) {
      el.textContent = initialsOf(user);
      return;
    }
    const img = new Image();
    img.alt = '';
    // A Google picture URL can rotate or 404 over time, and an <img> that fails
    // renders as a broken box rather than nothing — so fall back on error.
    img.onerror = () => { el.textContent = initialsOf(user); };
    img.src = src;
    el.append(img);
  }

  async function renderAccount() {
    const user = await API.profile();
    const src = await API.avatarSrc();

    await paintAvatar($('avatar-menu-pic'), user, src);
    $('menu-name').textContent = user?.name || 'Signed in';
    $('menu-email').textContent = user?.email || '';
    await paintAvatar($('avatar-home'), user, src);
    await paintAvatar($('avatar-progress'), user, src);
    await paintAvatar($('avatar-settings'), user, src);

    $('account-name').textContent = user?.name || 'Signed in';
    $('account-email').textContent = user?.email || '';

    // If the avatar never got cached (offline at sign-in, or CORS refused),
    // try again now that the app is running and online.
    if (user?.picture && !(await IDB.get('avatar'))) {
      API.cacheAvatar(user).catch(() => {});
    }

    const refresh = $('account-refresh');
    if (refresh) {
      refresh.hidden = !!user;
      if (!user && API.signedIn()) renderAccountSignIn();
    }
  }

  let accountBtnRendered = false;

  /** A GIS button inside Settings that re-authenticates without signing out. */
  async function renderAccountSignIn() {
    if (accountBtnRendered || !config.google_client_id) return;
    try {
      await loadGoogleScript();
      google.accounts.id.initialize({
        client_id: config.google_client_id,
        callback: async ({ credential }) => {
          try {
            await API.signIn(credential);
            await renderAccount();
            toast('Account updated.');
          } catch {
            toast("Couldn't refresh the account.");
          }
        },
      });
      google.accounts.id.renderButton($('account-signin-btn'), {
        theme: 'filled_black', size: 'medium', shape: 'pill', text: 'continue_with',
      });
      accountBtnRendered = true;
    } catch {
      /* offline, or the script is blocked — the hint above still explains it */
    }
  }

  // ── Welcome back ──────────────────────────────────────────────────────────
  //
  // The streak is elapsed time since the last relapse, which only means
  // something while relapses are being logged. Go quiet and it grows anyway,
  // which rewards abandonment. This asks once, on return, rather than letting
  // the number keep making a claim nothing supports.
  //
  // It never resets anything. "Nothing to add" continues the streak; "I
  // relapsed" logs an event and the arithmetic does the rest.

  let returnGap = null;

  /** @returns {Promise<boolean>} true if the prompt took over the screen */
  async function checkReturn() {
    let r;
    try {
      r = await API.seen();
    } catch {
      return false;   // offline: nothing to ask, and nothing lost by waiting
    }
    if (!r.needs_review) return false;

    returnGap = r;
    show('return');
    $('return-title').textContent = 'Welcome back';
    $('return-body').textContent =
      `No activity for ${plural(r.gap_days, 'day')}. Your streak hasn't been reset — ` +
      `it just hasn't been confirmed for that stretch.`;

    // Says plainly that the window is shorter than the gap, so a date placed at
    // its edge isn't mistaken for an accurate one.
    $('return-note').textContent = r.backfill?.capped
      ? `If you relapsed, it can only be dated within the last ${
          plural(Math.round((r.backfill.latest - r.backfill.earliest) / 86_400_000), 'day')}.`
      : '';
    return true;
  }

  async function clearReturn() {
    $('btn-return-clear').disabled = true;
    try {
      await API.vouch();
    } catch {
      toast('Needs a connection.');
      $('btn-return-clear').disabled = false;
      return;
    }
    returnGap = null;
    $('btn-return-clear').disabled = false;
    show('home');
    refreshProgress().catch(() => {});
  }

  async function returnRelapse() {
    // Straight into the normal relapse sheet, marked as remembered. Clearing
    // the gap happens on save, not now — abandoning the sheet must leave the
    // gap outstanding rather than silently vouching for it.
    openLog('relapse', { recalled: true, window: returnGap?.backfill || null });
  }

  // ── Share to a chatbot ────────────────────────────────────────────────────
  //
  // A share rather than an API call, because a subscription to an assistant does
  // not include API access — handing off to the app is what uses what is already
  // paid for.
  //
  // Cadence's own part stays short: build, hand off, leave. The conversation
  // happens elsewhere, which is what keeps this on the right side of §0 — the
  // app is not the thing holding attention.

  const TERM_KEY = 'cadence.share_term';
  let shareMode = 'reflect';

  const shareTerm = () => (localStorage.getItem(TERM_KEY) || '').trim();

  async function openShare(mode) {
    shareMode = mode;
    show('share');
    $('share-title').textContent = mode === 'now' ? 'Talk it through' : 'Talk it through';

    const box = $('share-explicit');
    const term = shareTerm();
    // Nothing to name it with: the toggle would produce the same text either
    // way, so it says why instead of sitting there inert.
    box.disabled = !term;
    box.checked = false;
    $('share-explicit-hint').textContent = term
      ? `Includes your notes, and calls it "${term}".`
      : 'Set a word for it under Settings → Sharing to enable this.';

    await refreshSharePreview();
  }

  async function refreshSharePreview() {
    const pre = $('share-preview');
    pre.textContent = 'Building…';
    try {
      pre.textContent = await API.context({
        mode: shareMode,
        term: $('share-explicit').checked ? shareTerm() : null,
        notes: $('share-explicit').checked,
      });
    } catch {
      pre.textContent = '';
      toast('Needs a connection to build the summary.');
    }
  }

  async function doShare() {
    const text = $('share-preview').textContent;
    if (!text) return;
    try {
      // The native sheet is what lets the assistant app pick it up directly.
      await navigator.share({ text });
    } catch (err) {
      // AbortError is the user dismissing the sheet — not a failure worth
      // reporting, and not a reason to fall back to the clipboard.
      if (err?.name === 'AbortError') return;
      await copyShare();
      return;
    }
    show('home');
  }

  async function copyShare() {
    const text = $('share-preview').textContent;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied. Paste it into your assistant.');
      show('home');
    } catch {
      toast("Couldn't copy — select the text above instead.");
    }
  }

  // ── Nightly sweep ─────────────────────────────────────────────────────────

  let sweep = null;

  async function openSweep() {
    let data;
    try {
      data = await API.sweep();
    } catch {
      toast('The sweep needs a connection.');
      return show('home');
    }

    sweep = { day: data.logical_day, morning_wood: null };
    show('sweep');
    renderMorning();

    // Deletable here too: the sweep is where remembered entries get added, so
    // it is exactly where a mis-tap needs undoing. Same two-stage confirm.
    renderTimeline($('sweep-list'), data.events, { showDelete: true });
    $('sweep-empty').hidden = data.events.length > 0;
    $('sweep-note').value = '';
    $('sweep-added').textContent = '';
    $('btn-sweep-done').textContent = data.confirmed ? 'Done' : 'Confirm the day';

    const wrap = $('sweep-buckets');
    wrap.innerHTML = '';
    for (const b of data.buckets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      // Not a toggle: each tap adds one more remembered urge to that bucket,
      // because "a couple this afternoon" is a thing recall actually produces.
      btn.onclick = async () => {
        await API.log({
          kind: 'urge',
          ts_utc: b.ts_utc,
          // Recalled events are systematically milder and fuzzier than live
          // ones, and phase 4 would be biased if they were mixed in silently.
          recalled: true,
        });
        // Re-read rather than incrementing a counter: a bare "1 entry added"
        // says nothing about what went in, and leaves a mis-tap with no way
        // back short of hunting through History.
        await refreshSweepList();
      };
      wrap.append(btn);
    }
  }

  // Index is the stored value: 0 = no, 1 = yes, 2 = don't recall.
  //
  // A count was the original design and it was wrong — by check-in time you
  // cannot reliably distinguish "twice" from "three times", so the extra
  // resolution was noise wearing the clothes of data. "Don't recall" is offered
  // explicitly so a forgotten morning is recorded as forgotten rather than
  // silently becoming a no.
  // Keyed by stored value, not positional: 1 is the legacy binary "yes" and is
  // never offered again, so an array indexed by position would silently shift
  // every historical reading by one. See worker/lib/events.js for the encoding.
  const MORNING_LABELS = { 0: 'none', 1: 'yes', 2: 'mild', 3: 'strong', 4: "don't recall" };

  // Strongest first, then down to none, with the non-answer last. Ordering it
  // this way keeps "none" and "don't recall" adjacent at the end, where a
  // mis-tap between the two is least likely to be read as a strength.
  const MORNING_OPTIONS = [3, 2, 0, 4];

  function renderMorning() {
    const wrap = $('morning-chips');
    wrap.innerHTML = '';
    for (const value of MORNING_OPTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = MORNING_LABELS[value];
      b.setAttribute('aria-pressed', String(sweep?.morning_wood === value));
      b.onclick = () => {
        // Tapping the selection clears it — the field is optional, and 0 is a
        // real answer that must stay distinct from "didn't say".
        sweep.morning_wood = sweep.morning_wood === value ? null : value;
        renderMorning();
      };
      wrap.append(b);
    }
  }

  /**
   * The morning prompt: one question, then done.
   *
   * It writes a `daily` event, the same kind the nightly sweep confirms with, so
   * answering here also confirms the day. Answering both can leave two `daily`
   * rows on one logical day — harmless rather than upserted: coverage counts
   * DISTINCT logical_day so it cannot double-count, and the morning reading is
   * found by its non-null field rather than by being the only row.
   */
  async function openMorning() {
    show('morning');
    const wrap = $('morning-now-chips');
    wrap.innerHTML = '';
    for (const value of MORNING_OPTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = MORNING_LABELS[value];
      b.onclick = async () => {
        for (const x of wrap.querySelectorAll('button')) x.disabled = true;
        await API.log({ kind: 'daily', morning_wood: value });
        $('done-text').textContent = 'Noted.';
        show('done');
        doneTimer = setTimeout(() => {
          doneTimer = null;
          show('home');
          refreshProgress().catch(() => {});
        }, CONFIG.DONE_MS);
      };
      wrap.append(b);
    }
  }

  /** Re-read today so an added or removed entry shows up in the list itself. */
  async function refreshSweepList() {
    try {
      const data = await API.sweep();
      renderTimeline($('sweep-list'), data.events, { showDelete: true });
      $('sweep-empty').hidden = data.events.length > 0;
    } catch {
      toast('Saved, but the list needs a connection to refresh.');
    }
  }

  async function finishSweep() {
    const btn = $('btn-sweep-done');
    btn.disabled = true;

    const note = $('sweep-note').value.trim();
    // The check-in is what `confirmed_days` counts; the note rides on it rather
    // than becoming a second event for the same moment.
    await API.log({
      kind: 'daily',
      ...(note ? { note } : {}),
      ...(sweep?.morning_wood != null ? { morning_wood: sweep.morning_wood } : {}),
    });

    $('done-text').textContent = 'Day confirmed.';
    show('done');
    btn.disabled = false;
    doneTimer = setTimeout(() => {
      doneTimer = null;
      show('home');
      refreshProgress().catch(() => {});
    }, CONFIG.DONE_MS);
  }

  // ── Deep links ────────────────────────────────────────────────────────────
  //
  // `/?action=urge` and `/?action=relapse` open straight into that sheet. This
  // is what the manifest `shortcuts` point at on Android and desktop, and what
  // an iOS Shortcut or a second home-screen icon can point at — Safari does not
  // implement manifest shortcuts, so the URL is the portable half.
  //
  // The action is remembered, not acted on immediately: it must wait for the
  // lock, or the shortcut would be a way straight past it.
  let pendingAction = null;
  let pendingNotificationId = null;

  function captureAction() {
    const params = new URL(location.href).searchParams;
    const action = params.get('action');
    if (['urge', 'relapse', 'sweep', 'morning'].includes(action)) pendingAction = action;
    // Which notification sent us here. Reported once a session exists, so
    // phase 5 can compare notified windows against un-notified ones.
    pendingNotificationId = params.get('n');
    // Strip it so a reload — or the app being resumed later — doesn't reopen
    // the sheet out of nowhere.
    if (action || pendingNotificationId) {
      history.replaceState(null, '', location.pathname);
    }
  }

  function consumePendingAction() {
    if (pendingNotificationId) {
      API.notificationOpened(pendingNotificationId).catch(() => {});
      pendingNotificationId = null;
    }
    if (!pendingAction) return;
    const action = pendingAction;
    pendingAction = null;
    if (action === 'sweep') return openSweep();
    if (action === 'morning') return openMorning();
    openLog(action);
  }

  // ── Logging ───────────────────────────────────────────────────────────────

  function openLog(kind, opts = {}) {
    draft = {
      kind, intensity: null, satisfaction: null, context: new Set(), note: '',
      recalled: !!opts.recalled,
      // Set only on the return flow; null means "now".
      ts_utc: null,
      // Whole hours back from save time. 0 is "now", which is the default, so
      // logging in the moment is still a single tap.
      hoursAgo: 0,
      // Clearing the outstanding gap is deferred to a successful save, so
      // abandoning this sheet leaves the gap outstanding rather than silently
      // vouching for it.
      vouchOnSave: !!opts.recalled,
    };

    $('log-title').textContent = kind === 'relapse' ? 'Record a relapse' : 'Log an urge';
    // Each of these is valid on exactly one kind, and the server rejects the
    // other combinations outright.
    $('field-intensity').hidden = kind !== 'urge';
    $('field-satisfaction').hidden = kind !== 'relapse';
    // Urges too: an episode can involve the material without ending in a relapse.
    $('field-mode').hidden = !(kind === 'urge' || kind === 'relapse');
    $('note').value = '';
    $('note').placeholder = kind === 'relapse'
      ? 'Anything about the lead-up? (optional)'
      : 'Anything worth noting? (optional)';
    $('recall-note').hidden = true;

    renderWhen(opts.window);
    // Never both: the return flow already asks which *day*, at whole-day
    // resolution, and offering an hour on top would imply a precision that
    // flow's whole design says the memory does not have.
    $('field-hour').hidden = draft.kind !== 'relapse' || draft.recalled;
    if (!$('field-hour').hidden) renderHour();
    renderScale('intensity');
    renderScale('satisfaction');
    renderChips();
    renderModeChips();
    renderRequired();
    show('log');
  }

  /**
   * The logical day a wall-clock instant belongs to, as a local Date.
   *
   * Shifts the **wall clock**, not the instant — `ts - 4h` is a day out for an
   * 04:00–05:00 event on the spring-forward DST date. Same correction PLAN.md §3
   * records for the server's derive(); the two must agree or this control would
   * promise a day the server then disagrees with.
   */
  function logicalDateOf(ts, boundaryHour) {
    const d = new Date(ts);
    if (d.getHours() < boundaryHour) d.setDate(d.getDate() - 1);
    d.setHours(12, 0, 0, 0);
    return d;
  }

  /**
   * Hour-granularity "when did it happen", for a relapse logged after the fact.
   *
   * Hours rather than a clock picker because an hour is the honest resolution of
   * the memory, and because the two things downstream care about are the bucket
   * (`local_hour`) and the logical day — neither of which minutes affect.
   *
   * These stay `recalled = 0`. In this codebase `recalled` means reconstructed
   * days later and systematically fuzzier, and phase 4 is meant to hold those
   * apart; a time you actually remember from this morning is not that.
   */
  function renderHour() {
    const boundary = appSettings.day_boundary_hour;
    const maxBack = appSettings.backfill_window_days * 24;
    const now = Date.now();
    const ts = now - draft.hoursAgo * 3_600_000;

    $('hour-back').disabled = draft.hoursAgo >= maxBack;
    $('hour-fwd').disabled = draft.hoursAgo <= 0;

    $('hour-label').textContent = new Date(ts)
      .toLocaleTimeString([], { hour: 'numeric', minute: draft.hoursAgo ? undefined : '2-digit' });

    const sub = $('hour-sub');
    const ago = draft.hoursAgo === 0 ? 'now' : plural(draft.hoursAgo, 'hour') + ' ago';
    const today = logicalDateOf(now, boundary);
    const then = logicalDateOf(ts, boundary);
    if (then.getTime() === today.getTime()) {
      sub.textContent = ago;
    } else {
      // The reason this control exists: before 04:00 belongs to the previous
      // logical day, so a 1am relapse logged at 9am would otherwise be filed a
      // whole day late — moving the ribbon cell, the streak start, and both
      // attempt lengths around it.
      const day = then.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      sub.innerHTML = `${ago} · <span class="hour-flip">counts as ${day}</span>`;
    }
  }

  function stepHour(by) {
    const maxBack = appSettings.backfill_window_days * 24;
    draft.hoursAgo = Math.max(0, Math.min(maxBack, draft.hoursAgo + by));
    renderHour();
  }

  /**
   * Whole-day choices inside the allowed backfill window. Local midday is used
   * as the instant: the day is what the streak arithmetic needs, and inventing
   * an hour nobody remembers would pollute the hour-of-day distribution. These
   * carry recalled = 1, which is what keeps them out of the live-log analysis.
   */
  function renderWhen(window) {
    const field = $('field-when');
    field.hidden = !window;
    if (!window) return;

    const wrap = $('when-chips');
    wrap.innerHTML = '';
    const today = new Date();
    today.setHours(12, 0, 0, 0);

    for (let back = 0; back < 14; back++) {
      const d = new Date(today);
      d.setDate(d.getDate() - back);
      const ts = d.getTime();
      if (ts < window.earliest || ts > window.latest) continue;

      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = back === 0 ? 'today'
        : back === 1 ? 'yesterday'
        : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      b.setAttribute('aria-pressed', String(draft.ts_utc === ts));
      b.onclick = () => { draft.ts_utc = ts; renderWhen(window); };
      wrap.append(b);
    }

    // Default to the earliest allowed day rather than today: after a gap, the
    // relapse is more likely to have happened before the moment of return.
    if (draft.ts_utc == null) {
      const first = wrap.querySelector('button:last-child');
      if (first) first.click();
    }
  }

  /**
   * What a relapse still needs before it can be saved.
   *
   * Relapse only. Urge logging is already the path that feels like too much
   * work, and making it stricter would cost more data than it gained. Relapses
   * are rare, so a couple of required taps there is affordable.
   *
   * Enforced in the client, deliberately not on the server: a rule that can
   * change must never be able to wedge an event already sitting in the offline
   * queue, unable to flush and unable to be fixed.
   */
  function missingRequired() {
    if (!draft || draft.kind !== 'relapse') return [];
    const missing = [];
    if (draft.satisfaction == null) missing.push('worth it');
    if (!(config.mode_tags || []).some(t => draft.context.has(t))) missing.push('what was involved');
    return missing;
  }

  function renderRequired() {
    const missing = missingRequired();
    const save = $('btn-log-save');
    save.disabled = missing.length > 0;

    const hint = $('log-missing');
    hint.hidden = missing.length === 0;
    hint.textContent = missing.length ? `Still needed: ${missing.join(' and ')}.` : '';

    const relapse = draft?.kind === 'relapse';
    for (const [id, satisfied] of [
      ['req-satisfaction', draft?.satisfaction != null],
      ['req-mode', (config.mode_tags || []).some(t => draft?.context.has(t))],
    ]) {
      const el = $(id);
      if (!el) continue;
      el.hidden = !relapse;
      el.classList.toggle('satisfied', satisfied);
      el.textContent = satisfied ? 'answered' : 'required';
    }
  }

  /** A 0–5 row bound to one field of the draft. Used by intensity and satisfaction. */
  function renderScale(field) {
    const wrap = $(field);
    wrap.innerHTML = '';
    for (let i = 0; i <= 5; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = i;
      b.setAttribute('aria-pressed', String(draft[field] === i));
      b.onclick = () => {
        // Tapping the selected value clears it — both scales are optional, and
        // a value you can't take back is a reason to hesitate.
        draft[field] = draft[field] === i ? null : i;
        renderScale(field);
        renderRequired();
      };
      wrap.append(b);
    }
  }

  // Same shape as the situational chips, separate group. Both write into the
  // one `context` set — the split is about which question is being asked, and
  // about keeping these out of the urge/relapse contrast on the server.
  function renderModeChips() {
    const wrap = $('mode-chips');
    wrap.innerHTML = '';
    for (const tag of (config.mode_tags || [])) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = TAG_LABELS[tag] || tag;
      b.setAttribute('aria-pressed', String(draft.context.has(tag)));
      b.onclick = () => {
        draft.context.has(tag) ? draft.context.delete(tag) : draft.context.add(tag);
        renderModeChips();
        renderRequired();
      };
      wrap.append(b);
    }
  }

  function renderChips() {
    const wrap = $('context-chips');
    wrap.innerHTML = '';
    for (const tag of config.context_tags) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = TAG_LABELS[tag] || tag;
      b.setAttribute('aria-pressed', String(draft.context.has(tag)));
      b.onclick = () => {
        draft.context.has(tag) ? draft.context.delete(tag) : draft.context.add(tag);
        renderChips();
      };
      wrap.append(b);
    }
  }

  async function saveLog() {
    if (missingRequired().length) return renderRequired();
    const btn = $('btn-log-save');
    btn.disabled = true;

    const payload = { kind: draft.kind };
    if (draft.recalled) payload.recalled = true;
    if (draft.ts_utc != null) payload.ts_utc = draft.ts_utc;
    // Resolved against save time, not sheet-open time, so "2 hours ago" means
    // two hours before the tap that recorded it however long the sheet sat open.
    else if (draft.hoursAgo > 0) payload.ts_utc = Date.now() - draft.hoursAgo * 3_600_000;
    // `!= null` rather than a truthiness check: 0 is a real answer on both
    // scales, and the most interesting one on satisfaction.
    if (draft.kind === 'urge' && draft.intensity != null) payload.intensity = draft.intensity;
    if (draft.kind === 'relapse' && draft.satisfaction != null) payload.satisfaction = draft.satisfaction;
    if (draft.context.size) payload.context = [...draft.context];
    const note = $('note').value.trim();
    if (note) payload.note = note;

    const { queued } = await API.log(payload);

    // The gap is accounted for by the event itself, so clear it now rather than
    // when the sheet opened — abandoning the sheet must leave it outstanding.
    if (draft.vouchOnSave) {
      returnGap = null;
      API.vouch().catch(() => {});
    }

    // Terminal: acknowledge, then get out of the way. No timer, no countdown,
    // no "how did it go" — see Appendix A for why both of those are gone.
    $('done-text').textContent = queued
      ? 'Saved on this device.'
      : (draft.kind === 'relapse' ? 'Recorded.' : 'Logged.');
    show('done');
    btn.disabled = false;

    doneTimer = setTimeout(async () => {
      doneTimer = null;
      // Back to the two buttons, not to the numbers. Landing on stats after a
      // log is exactly the "something to read while an urge runs" the §0 rule
      // rules out.
      show('home');
      // Refresh in the background so Progress is current whenever it is opened.
      refreshProgress().catch(() => {});
    }, CONFIG.DONE_MS);
  }

  // ── History ───────────────────────────────────────────────────────────────

  async function renderHistory() {
    const body = $('history-body');
    body.innerHTML = '<p class="empty">Loading…</p>';
    let events;
    try {
      events = await API.events({ from: Date.now() - 90 * 86_400_000, limit: 1000 });
    } catch {
      body.innerHTML = '<p class="empty">Offline — history needs a connection.</p>';
      return;
    }
    if (!events.length) {
      body.innerHTML = '<p class="empty">Nothing logged yet.</p>';
      return;
    }

    const byDay = new Map();
    for (const ev of events) {
      if (!byDay.has(ev.logical_day)) byDay.set(ev.logical_day, []);
      byDay.get(ev.logical_day).push(ev);
    }

    body.innerHTML = '';
    for (const [day, evs] of byDay) {
      const h = document.createElement('h3');
      h.className = 'day-head';
      // Parsed as UTC noon so the label can't slip a day in a western zone.
      h.textContent = new Date(`${day}T12:00:00Z`).toLocaleDateString([], {
        weekday: 'short', day: 'numeric', month: 'short',
      });
      const ul = document.createElement('ul');
      ul.className = 'timeline';
      renderTimeline(ul, evs);
      body.append(h, ul);
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async function renderSettings() {
    const bioAvailable = await Lock.biometricAvailable();
    const bioOn = Lock.biometricRegistered();
    $('bio-status').textContent = bioOn
      ? 'Face ID / Touch ID — on'
      : (bioAvailable ? 'Face ID / Touch ID' : 'Face ID / Touch ID — not available here');
    $('btn-bio-setup').textContent = bioOn ? 'Remove' : 'Set up';
    $('btn-bio-setup').disabled = !bioAvailable && !bioOn;

    $('pin-status').textContent = Lock.pinSet() ? 'PIN — set' : 'PIN';
    $('btn-pin-setup').textContent = Lock.pinSet() ? 'Remove' : 'Set up';

    $('idle-timeout').value = String(Lock.idleSeconds());
    $('share-term').value = shareTerm();

    const boundary = $('boundary-hour');
    if (!boundary.options.length) {
      for (let h = 0; h <= 11; h++) {
        const o = document.createElement('option');
        o.value = String(h);
        o.textContent = `${String(h).padStart(2, '0')}:00`;
        boundary.append(o);
      }
    }

    try {
      const s = await API.settings();
      appSettings = { ...appSettings, ...s };
      boundary.value = String(s.day_boundary_hour);
      $('backfill-days').value = String(s.backfill_window_days);
    } catch { /* offline: the controls keep whatever they last showed */ }

    await renderPush();
    await renderAccount().catch(() => {});

    const facts = $('device-facts');
    facts.innerHTML = '';
    const row = (k, v) => {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      facts.append(dt, dd);
    };
    row('Time zone', API.tz());
    row('Installed', matchMedia('(display-mode: standalone)').matches || navigator.standalone
      ? 'yes' : 'no — running in the browser');
    $('outbox-count').textContent = String(await API.pendingCount());
  }

  // ── Push ──────────────────────────────────────────────────────────────────

  // Every reason subscribing can fail, said plainly. "needs-install" is the one
  // that actually happens: on iOS, Web Push works only from a home-screen
  // install and silently does nothing in a browser tab.
  const PUSH_REASONS = {
    unsupported: 'This browser has no Web Push support.',
    'needs-install': 'On iPhone this needs the home-screen install, not Safari.',
    blocked: 'Notifications are blocked for this site in system settings.',
    dismissed: 'Permission was dismissed.',
    'no-vapid-key': 'The server has no VAPID key configured.',
  };

  async function renderPush() {
    const status = $('push-status');
    const btn = $('btn-push');
    const detail = $('push-detail');
    const support = API.pushSupport();

    let devices = 0;
    try { devices = (await API.pushStatus()).devices; } catch { /* offline */ }

    const enabled = support.state === 'granted' && devices > 0;
    status.textContent = enabled
      ? `Enabled · ${plural(devices, 'device')}`
      : 'Not enabled';
    btn.textContent = enabled ? 'Turn off' : 'Enable';
    btn.disabled = !enabled && ['unsupported', 'needs-install', 'blocked'].includes(support.state);
    detail.textContent = enabled
      ? 'Tap the version number below to send a test notification.'
      : (PUSH_REASONS[support.state] || '');
  }

  async function togglePush() {
    const btn = $('btn-push');
    const detail = $('push-detail');
    btn.disabled = true;

    if (btn.textContent === 'Turn off') {
      await API.pushUnsubscribe();
      await renderPush();
      return;
    }

    // This call must stay inside the click handler — iOS refuses the permission
    // prompt outside a user gesture, and awaiting anything first can break the
    // gesture chain.
    const result = await API.pushSubscribe();
    if (!result.ok) {
      detail.textContent = PUSH_REASONS[result.reason] || `Couldn't enable: ${result.reason}`;
      btn.disabled = false;
      return;
    }
    await renderPush();
    toast('Notifications on. Tap the version number to test.');
  }

  // The hidden trigger the skill recommends. A real push through the real
  // pipeline, reported as whatever actually came back.
  async function sendTestPush() {
    const detail = $('push-detail');
    detail.textContent = 'Sending…';
    const r = await API.pushTest();
    if (r.ok && r.sent > 0) {
      detail.textContent = `Sent to ${plural(r.sent, 'device')}. It should arrive within a few seconds.`;
      return;
    }
    // Surface the raw result: a push that is accepted and never displays looks
    // identical to one that was never sent, unless the status code is shown.
    const first = r.results?.find(x => !x.ok) || {};
    detail.textContent = `Not delivered — ${first.status || r.status || 'no devices'}${
      r.pruned ? `, ${r.pruned} stale subscription(s) pruned` : ''}. ${first.body || r.error || ''}`.trim();
    await renderPush();
  }

  // ── Sign-in ───────────────────────────────────────────────────────────────

  function loadGoogleScript() {
    return new Promise((resolve, reject) => {
      if (window.google?.accounts?.id) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      // A cross-origin script tag can stall without ever firing onerror, so
      // this needs its own deadline or the sign-in screen sits blank forever.
      const timer = setTimeout(() => reject(new Error('sign-in script timed out')), 10_000);
      s.onload = () => { clearTimeout(timer); resolve(); };
      // GIS is cross-origin and cannot be vendored, so sign-in never works
      // offline. Everything after sign-in does.
      s.onerror = () => { clearTimeout(timer); reject(new Error('could not load Google sign-in')); };
      document.head.append(s);
    });
  }

  async function showSignIn() {
    // Paint first — everything below needs the network, and the veil must not
    // wait on it.
    show('signin');
    await loadConfig();
    if (!config.google_client_id) {
      $('signin-setup').hidden = false;
      return;
    }
    try {
      await loadGoogleScript();
      google.accounts.id.initialize({
        client_id: config.google_client_id,
        callback: async ({ credential }) => {
          try {
            await API.signIn(credential);
            await afterSignIn();
          } catch {
            $('signin-error').textContent = 'Sign-in failed.';
            $('signin-error').hidden = false;
          }
        },
      });
      google.accounts.id.renderButton($('google-btn'), {
        theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with',
      });
    } catch {
      $('signin-error').textContent = navigator.onLine
        ? 'Sign-in failed.'
        : 'Sign-in needs a connection.';
      $('signin-error').hidden = false;
    }
  }

  async function afterSignIn() {
    await API.flush().catch(() => {});
    show('home');
    // The notification's destination has to survive the sign-in it triggered.
    // Dropping it here is why tapping a check-in landed on a dead login screen
    // and then went nowhere.
    consumePendingAction();
    await refreshProgress();
    // Held back until after sign-in: the install prompt renders over the
    // sign-in button and blocks login on a first visit.
    if (window.PWAInstall) PWAInstall.init({ appName: 'Cadence', sub: SUB, remember: 7 });
  }

  /**
   * Explicit sign-out. Clears the session and the cached data, and deliberately
   * does NOT clear the lock any more.
   *
   * It used to. The result was that signing out and back in left the app with
   * no gate and nothing saying so — a passkey has to be re-registered by hand,
   * and nobody thinks to. A session action destroying a device credential was
   * the wrong coupling: the lock belongs to the phone, not to the login, and
   * Settings → Lock → Remove exists for when you actually want it gone.
   */
  async function signOut() {
    await API.signOut();
    location.reload();
  }

  /**
   * The session stopped being accepted. Deliberately NOT signOut(): an expired
   * or rejected token is a reason to sign in again, not a reason to destroy the
   * Face ID registration and PIN — which would turn a transient auth problem
   * into re-registering a passkey and losing the lock entirely.
   */
  async function sessionExpired() {
    await API.clearSession();
    await showSignIn();
  }

  // ── Lock screen ───────────────────────────────────────────────────────────

  // Once an automatic attempt has been refused in this page session, stop
  // making them. That covers both possibilities behind a NotAllowedError —
  // an older Safari demanding a gesture, and the user cancelling because they
  // want the PIN — neither of which is improved by asking again unprompted.
  let autoUnlockBlocked = false;

  async function showLock() {
    show('lock');
    const bio = Lock.biometricRegistered();
    $('btn-unlock').hidden = !bio;
    $('btn-use-pin').hidden = !(bio && Lock.pinSet());
    $('pin-form').hidden = bio;
    $('btn-use-bio').hidden = !bio;
    $('lock-error').hidden = true;
    $('pin-input').value = '';
    $('lock-reset').hidden = true;
    // Always offered, not only after a failure: the failure mode this exists
    // for is a credential deleted outside the app, and that can present as a
    // system sheet the user dismisses rather than as an error we ever see.
    $('btn-lock-escape').hidden = false;

    if (!bio && !Lock.pinSet()) {
      // Nothing configured — nothing to unlock. Shouldn't be reachable, but a
      // lock screen with no way past it would be an unrecoverable app.
      Lock.unlocked();
      return afterUnlock();
    }

    // Prompt for Face ID immediately rather than waiting for a tap.
    //
    // §4.1 assumed Safari forbids a WebAuthn call outside a user gesture and
    // built the Unlock button around that. It is no longer true: iOS 17.4
    // dropped the gesture requirement in favour of rate limiting, and older
    // Safari allowed one gesture-free get() per navigation — which is exactly
    // one more than this needs. The button stays as the fallback, already on
    // screen, for when the call is refused or cancelled.
    // Not while hidden: on a resume the lock is armed from visibilitychange,
    // and a WebAuthn call made before the app is actually frontmost fails for
    // reasons that have nothing to do with the user.
    if (bio && !autoUnlockBlocked && document.visibilityState === 'visible') {
      // Disabled while the sheet is up, so a tap on the button behind it can't
      // start a second ceremony and cancel the first.
      $('btn-unlock').disabled = true;
      try {
        await Lock.unlockWithBiometric();
        return afterUnlock();
      } catch {
        autoUnlockBlocked = true;
        if (Lock.pinSet()) $('btn-use-pin').hidden = false;
      } finally {
        $('btn-unlock').disabled = false;
      }
    }
  }

  async function afterUnlock() {
    if (API.signedIn()) {
      show('home');
      // Directly, not only via refreshProgress — Home shows the avatar too, and
      // it must appear even when stats can't be fetched.
      renderAccount().catch(() => {});
      // Records the visit, and takes over the screen if it reveals a gap.
      if (await checkReturn()) return;
      // A shortcut lands here only after the lock has been satisfied — the
      // deep link chooses the destination, it never bypasses the gate.
      consumePendingAction();
      refreshProgress().catch(() => {});
      await API.flush().catch(() => {});
      if (window.PWAInstall) PWAInstall.init({ appName: 'Cadence', sub: SUB, remember: 7 });
    } else {
      await showSignIn();
    }
  }

  function lockError(message) {
    const el = $('lock-error');
    el.textContent = message;
    el.hidden = false;
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  function wire() {
    $('btn-log-urge').onclick = () => openLog('urge');
    $('btn-log-relapse').onclick = () => openLog('relapse');
    $('btn-log-cancel').onclick = () => show('home');
    $('btn-log-save').onclick = () => saveLog();
    for (const b of document.querySelectorAll('.avatar-btn')) {
      b.onclick = e => { e.stopPropagation(); toggleAvatarMenu(b); };
    }
    $('avatar-menu').onclick = e => e.stopPropagation();
    $('range-prev').onclick = () => shiftCharts(-4);
    $('range-next').onclick = () => shiftCharts(4);
    $('btn-open-sweep').onclick = () => openSweep();
    $('btn-talk-now').onclick = () => openShare('now');
    $('btn-talk-reflect').onclick = () => openShare('reflect');
    $('btn-share-cancel').onclick = () => show(shareMode === 'now' ? 'home' : 'progress');
    $('share-explicit').onchange = () => refreshSharePreview();
    $('btn-share-go').onclick = () => doShare();
    $('btn-share-copy').onclick = () => copyShare();
    $('menu-settings').onclick = () => openSettingsFrom();
    $('btn-settings-back').onclick = async () => {
      show(settingsReturnTo);
      if (settingsReturnTo === 'progress') await refreshProgress().catch(() => {});
    };

    $('btn-return-clear').onclick = () => clearReturn();
    $('btn-return-relapse').onclick = () => returnRelapse();
    $('btn-sweep-skip').onclick = () => show('home');
    $('btn-morning-skip').onclick = () => show('home');
    $('btn-sweep-done').onclick = () => finishSweep();

    // A tap anywhere else is a cancel. The delete button stops propagation, so
    // this never fires for the button that is arming or committing.
    document.addEventListener('click', () => { disarmDelete(); closeAvatarMenu(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAvatarMenu(); });

    for (const t of document.querySelectorAll('.tab')) {
      t.onclick = async () => {
        show(t.dataset.tab);
        if (t.dataset.tab === 'progress') await refreshProgress().catch(() => {});
      };
    }

    for (const el of document.querySelectorAll('[data-go]')) {
      el.onclick = async () => {
        const to = el.dataset.go;
        show(to);
        if (to === 'history') await renderHistory();
        if (to === 'settings') await renderSettings();
        if (to === 'progress') await refreshProgress().catch(() => {});
      };
    }

    // Lock screen
    $('btn-unlock').onclick = async () => {
      try {
        await Lock.unlockWithBiometric();
        await afterUnlock();
      } catch {
        lockError('Not unlocked.');
        if (Lock.pinSet()) $('btn-use-pin').hidden = false;
      }
    };
    $('btn-use-pin').onclick = () => {
      $('pin-form').hidden = false;
      $('btn-unlock').hidden = true;
      $('btn-use-pin').hidden = true;
      $('pin-input').focus();
    };
    // An explicit tap is a user gesture, so it clears the block and lets
    // showLock() prompt again immediately.
    $('btn-use-bio').onclick = () => { autoUnlockBlocked = false; showLock(); };
    $('btn-lock-escape').onclick = () => {
      $('lock-reset').hidden = false;
      $('btn-lock-escape').hidden = true;
    };
    $('btn-lock-reset-confirm').onclick = async () => {
      Lock.reset();
      // Intent stays 'wanted', so the header chip immediately asks for a new
      // lock rather than treating the reset as a decision to go without one.
      toast('Lock removed. Set a new one from Settings.');
      await afterUnlock();
    };
    $('pin-form').onsubmit = async e => {
      e.preventDefault();
      try {
        await Lock.unlockWithPin($('pin-input').value);
        await afterUnlock();
      } catch {
        lockError('Wrong PIN.');
        $('pin-input').value = '';
      }
    };

    // Settings
    $('btn-bio-setup').onclick = async () => {
      if (Lock.biometricRegistered()) {
        Lock.forgetBiometric();
        return renderSettings();
      }
      try {
        await Lock.registerBiometric();
        setLockIntent('wanted');
        toast('Face ID will be asked for next time the app opens.');
      } catch {
        toast("Couldn't set that up on this device.");
      }
      renderSettings();
      renderLockWarning();
    };

    $('btn-pin-setup').onclick = () => {
      if (Lock.pinSet()) {
        Lock.clearPin();
        return renderSettings();
      }
      $('pin-setup-form').hidden = false;
      $('pin-new').value = '';
      $('pin-again').value = '';
      $('pin-setup-hint').textContent = '4–12 digits.';
      $('pin-new').focus();
    };
    $('btn-pin-cancel').onclick = () => { $('pin-setup-form').hidden = true; };
    $('pin-setup-form').onsubmit = async e => {
      e.preventDefault();
      const pin = $('pin-new').value;
      if (pin !== $('pin-again').value) {
        $('pin-setup-hint').textContent = "Those didn't match.";
        $('pin-again').value = '';
        return;
      }
      try {
        await Lock.setPin(pin);
      } catch (err) {
        $('pin-setup-hint').textContent = err.message;
        return;
      }
      $('pin-setup-form').hidden = true;
      setLockIntent('wanted');
      toast('PIN set.');
      renderSettings();
      renderLockWarning();
    };

    $('btn-push').onclick = () => togglePush();
    $('settings-version').onclick = () => sendTestPush();

    $('idle-timeout').onchange = e => Lock.setIdleSeconds(Number(e.target.value));
    // localStorage, not the server: §0 keeps this word out of anywhere it could
    // persist and be read, and a D1 column is exactly such a place.
    $('share-term').onchange = e => {
      localStorage.setItem(TERM_KEY, e.target.value.trim());
    };

    $('boundary-hour').onchange = async e => {
      appSettings.day_boundary_hour = Number(e.target.value);
      await API.settings({ day_boundary_hour: Number(e.target.value) });
      toast('Applies to events logged from now on. Run rebuild-derived for older ones.');
      stats = null;
    };
    $('backfill-days').onchange = async e => {
      appSettings.backfill_window_days = Number(e.target.value);
      await API.settings({ backfill_window_days: Number(e.target.value) });
    };
    // Repeat-friendly: stepping back six hours is six taps, not a long-press.
    $('hour-back').onclick = () => stepHour(1);
    $('hour-fwd').onclick = () => stepHour(-1);
    $('menu-signout').onclick = () => signOut();
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function boot() {
    for (const el of document.querySelectorAll('.screen')) {
      screens[el.id.replace('screen-', '')] = el;
    }
    wire();
    VersionUI.init();
    // Read before anything can navigate or replace the URL.
    captureAction();

    Lock.init({ onLock: () => showLock() });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(err => {
        console.warn('[sw] registration failed', err);
      });
    }

    // The veil is only ever lowered by show(). If a future change re-introduces
    // an await before first paint, this turns "the app never opens" into a
    // visible stutter instead.
    const watchdog = setTimeout(() => {
      if (Object.values(screens).every(el => el.hidden)) {
        console.warn('[boot] nothing painted in time — forcing a screen');
        if (Lock.locked) showLock();
        else show(API.signedIn() ? 'home' : 'signin');
      }
    }, 6000);

    // Decide the screen from local state only, and paint. Nothing before this
    // point touches the network — anything awaited up here is a chance to hang
    // on a cold launch with no error to catch. That is exactly what stuck the
    // app on the start screen.
    if (Lock.locked) showLock();
    else await afterUnlock();
    clearTimeout(watchdog);

    // Both are refinements, not prerequisites: `config` already holds the
    // fallback vocabulary and `appSettings` the default day boundary, so a slow
    // or failed fetch costs nothing visible.
    loadConfig();
    loadSettings();
  }

  let settingsPromise = null;

  /**
   * Fetch settings at most once, same shape as loadConfig: a refinement, not a
   * prerequisite. The defaults below mirror worker/lib/settings.js, so the hour
   * stepper behaves correctly on a cold, offline launch — it would otherwise
   * have to guess the day boundary, and guessing it wrong is exactly the error
   * the stepper exists to prevent.
   */
  function loadSettings() {
    if (!settingsPromise) {
      settingsPromise = API.settings()
        .then(s => { appSettings = { ...appSettings, ...s }; return appSettings; })
        .catch(() => appSettings);
    }
    return settingsPromise;
  }

  let configPromise = null;

  /** Fetch /api/config at most once. Never throws; the fallback stands. */
  function loadConfig() {
    if (!configPromise) {
      configPromise = API.config()
        .then(c => {
          config = c;
          // If the log sheet is already open, take the server's vocabulary now.
          if (!screens.log.hidden && draft) { renderChips(); renderModeChips(); }
          return c;
        })
        .catch(() => config);
    }
    return configPromise;
  }

  return { boot, refreshProgress, openLog };
})();

App.boot().catch(err => {
  console.error('[boot]', err);
  document.getElementById('veil').hidden = true;
  document.body.insertAdjacentHTML('beforeend',
    '<p class="error" style="padding:24px">Something went wrong starting up. Reopen the app.</p>');
});
