# Cadence — implementation plan

**Cadence** — a personal abstinence/urge tracker. Installable PWA, single Cloudflare Worker, D1.
Deployed at `cadence.mishabhi.workers.dev`.
Single user (me), but schema is `user_id`-scoped so it doesn't need rewriting later.

**Build against the `pwa-cloudflare` skill.** It owns the Worker + static assets layout,
the iOS install prompt, `aes128gcm` Web Push, the Google OIDC verifier (including the `aud`
check), icon generation, and the deploy script. Copy its assets in and record them in
`.skill-assets`. Do not hand-roll push encryption or VAPID signing — use `webpush-edge`.

---

## 0. Constraints

Binding decisions. Don't re-litigate; if the code makes one awkward, flag it rather than
silently choosing otherwise. **Appendix A** records what was considered and rejected, and why —
read it before proposing anything that looks like an obvious improvement.

**Storage**
- D1, not KV. Every interesting query is a time-range scan.
- Event-sourced. Nothing mutable; no `streak` column anywhere. Everything derived at read time.
- Store both the instant (`ts_utc` + IANA `tz`) and a derived, rebuildable cache
  (`logical_day`, `local_hour`, `bucket`). See §3.
- Day boundary is 04:00 local, not midnight.

**Interaction — the load-bearing rule**
- **The app must never sustain or initiate attention on the behavior.** Every interaction is
  short and terminal: enter, record, leave. No timers, no countdowns, no "hang in there"
  screens, no queue of past events to revisit, no notification that asks about urges.
  Anything giving a reason to sit in the app while an urge is active is a design bug, however
  therapeutic it looks. This rule has already killed two features (Appendix A).
- Urge logging is **pull-only**. One scheduled push per day; later, at most 1–2 risk pushes.
- No per-urge outcome. Relapses are their own events; context tags go on both.

**Framing**
- Streak is kept but is never the headline — shown beside personal best and median attempt
  length so a single-digit streak reads as typical rather than as failure.
- Tone is curious and matter-of-fact, never disappointed. Shame is itself a relapse trigger,
  so the guilt-trip register is counterproductive. "Four of five late-night urges this week,"
  not "don't throw it away now." Constrains all copy: UI, notifications, LLM system prompt.

**Privacy — narrow threat model**

The risk is someone standing next to me reading a notification or a screen. Not an attacker,
not a subpoena.
- App name, icon, manifest `short_name`, and **all push text** stay neutral. Highest-priority
  item here, since notifications appear without me choosing to show them. Name is **Cadence**;
  `short_name` is `Cadence`; the icon is abstract with no lettering. Nothing in the manifest,
  the `<title>`, or any notification string names or alludes to the behavior — the word for it
  should not appear anywhere outside the app's own locked interior.
- Face ID / Touch ID on open, PIN fallback (§4.1).
- Content blanked when backgrounded (§4.1) — the app-switcher snapshot leaks more than the
  lock screen.
- Notes are **not** encrypted at rest; see Appendix A.

**Hostname: `cadence.mishabhi.workers.dev`** — fixed before phase 1 step 8, because the
passkey binds to it (§4.1).

---

## 1. Phasing

Phase 1 is usable on its own. Ship it and *actually use it* — phases 4–5 are worthless
without months of real data, and building them early means fitting a model to nothing.

| Phase | Contents | Gate to start |
|---|---|---|
| 0 | Scaffold, auth, D1, installable PWA shell | — |
| 1 | Event logging + core metrics + PIN | phase 0 done |
| 2 | Daily push + nightly sweep + backfill | phase 1 in daily use ~1 week |
| 3 | Charts | ~4 weeks of data |
| 4 | Risk model | ~200 urge events, realistically 2–3 months |
| 5 | LLM notification generation | phase 4 producing sane scores |

---

## 2. Schema

```sql
CREATE TABLE events (
  id           TEXT PRIMARY KEY,      -- client-generated UUID → idempotent retries
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,         -- 'urge' | 'relapse' | 'daily' | 'note'

  -- source of truth
  ts_utc       INTEGER NOT NULL,      -- epoch ms — when it happened
  tz           TEXT NOT NULL,         -- IANA, e.g. 'Asia/Kolkata'. NEVER an offset.

  -- derived cache (rebuildable — see §3)
  logical_day  TEXT NOT NULL,         -- 'YYYY-MM-DD', 4am-shifted, in tz
  local_hour   INTEGER NOT NULL,      -- 0–23
  bucket       TEXT NOT NULL,         -- 'morning'|'afternoon'|'evening'|'late'

  intensity    INTEGER,               -- 0–5, urge only
  context      TEXT,                  -- JSON array: ['alone','in_bed','phone','tired','bored','stressed']
                                      -- recorded on BOTH urge and relapse events — comparing the
                                      -- two distributions is what replaces per-urge outcome
  note         TEXT,                  -- free text, encrypted
  recalled     INTEGER NOT NULL DEFAULT 0,  -- 1 = backfilled via nightly sweep
  created_at   INTEGER NOT NULL       -- server receive time; differs from ts_utc when recalled
);

CREATE INDEX idx_events_user_ts  ON events(user_id, ts_utc);
CREATE INDEX idx_events_user_day ON events(user_id, logical_day);
CREATE INDEX idx_events_kind     ON events(user_id, kind, ts_utc);

CREATE TABLE push_subs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  tz TEXT, created_at INTEGER NOT NULL, last_ok_at INTEGER, fail_count INTEGER DEFAULT 0
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'daily_sweep' | 'risk' | 'milestone'
  body TEXT NOT NULL,
  source TEXT NOT NULL,            -- 'llm' | 'fallback'
  risk_score REAL,
  scheduled_for INTEGER, sent_at INTEGER, opened_at INTEGER,
  suppressed_reason TEXT,          -- NULL if sent; 'cap' | 'gap' | 'unsane_hour'
  outcome_90m TEXT                 -- notification attribution only, unrelated to urge outcome:
                                   -- 'none' | 'urge_logged' | 'relapse' in the 90 min after send
);

CREATE TABLE message_pool (       -- phase 5: pre-generated, never generated at send time
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
  body TEXT NOT NULL, generated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, used_at INTEGER
);

CREATE TABLE settings (
  user_id TEXT PRIMARY KEY,
  daily_checkin_hour INTEGER DEFAULT 21,
  daily_jitter_minutes INTEGER DEFAULT 25,   -- ± around daily_checkin_hour
  min_push_gap_minutes INTEGER DEFAULT 120,
  day_boundary_hour INTEGER DEFAULT 4,
  backfill_window_days INTEGER DEFAULT 3,
  risk_notifs_enabled INTEGER DEFAULT 0,
  max_pushes_per_day INTEGER DEFAULT 3
);
```

---

## 3. Time handling

The single highest-risk area. Get it wrong and every chart is subtly wrong forever.

Client sends `ts_utc` and `Intl.DateTimeFormat().resolvedOptions().timeZone`. Worker derives
the rest — Workers ships full ICU, so this works there and only there:

```js
export function derive(tsUtc, tz, boundaryHour = 4) {
  const shifted = new Date(tsUtc - boundaryHour * 3600_000);
  const logical_day = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(shifted);
  const local_hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', hour12: false
  }).format(new Date(tsUtc)));
  const bucket =
    local_hour < 4  ? 'late'      :
    local_hour < 12 ? 'morning'   :
    local_hour < 17 ? 'afternoon' :
    local_hour < 22 ? 'evening'   : 'late';
  return { logical_day, local_hour, bucket };
}
```

> **Implementation note (added during phase 1).** The sketch above shifts the *instant* by four
> hours. That is off by a day for events in the 04:00–05:00 window on a DST spring-forward
> date: four elapsed hours before 04:30 PDT is 23:30 PST the previous day, which files a
> plainly-after-the-boundary event under the previous logical day. `worker/lib/time.js` shifts
> the *wall clock* instead — read the local hour, borrow a calendar day if it falls before the
> boundary. Pure date arithmetic, unperturbable by any offset change. The §9 spring-forward
> test pins it.

IANA name, never `+05:30` — the same offset string in March and November can mean different
places, and DST rules change. Storing the zone keeps the data interpretable.

**Provide `scripts/rebuild-derived.ts`** that recomputes `logical_day` / `local_hour` /
`bucket` for all rows from `ts_utc` + `tz`. This is what makes the 4am boundary a *setting*
rather than a permanent commitment.

### Streak vs. coverage — computed differently on purpose

I travel between US Pacific, US Eastern, and IST. Counting distinct `logical_day` values
breaks across the Pacific: flying west you skip a calendar day and the streak jumps 2 for ~30
elapsed hours; flying east you can cross 04:00 twice and double-count.

- **Streak** = `floor((now - last_relapse_ts_utc) / 86_400_000)` — pure elapsed time.
  Timezone-proof, monotonic, immune to both bugs above.
- **Check-in coverage** = `COUNT(DISTINCT logical_day)` where a `daily` event exists, over the
  streak window. Check-ins are inherently per-day, so day-counting is correct here.

Display as `42 days · 38 confirmed`. Ignoring the app doesn't reset anything — that would just
make me delete it after a bad week — but it visibly degrades data quality, which is the
honest signal.

> **Amended after use.** That mitigation was too weak. Coverage is a small grey line under a
> large confident number, and the number wins: stop logging and the streak grows anyway, which
> rewards abandonment. The streak now carries a *confidence*, not just a value. Opening the app
> counts as activity for that day even with nothing logged — that is itself a statement — and
> after `stale_after_days` (default 3) of total silence the streak renders unverified and a
> return prompt asks once: **nothing to add** (vouches for the gap) or **I relapsed** (logs an
> event, and the arithmetic moves the streak).
>
> Still never a reset on inactivity — pausing is not punishing, and the original reason for
> refusing to reset stands. A returning relapse may only be dated within `backfill_window_days`,
> so a long absence containing an early relapse *understates* the streak rather than
> overstating it. `recalled = 1` and a local-noon timestamp keep these out of the live-log
> hour distribution.

**Charts always group by `local_hour` / `bucket`, never by UTC hour.** 23:00 IST and 23:00 EST
are the same behavioral moment.

**A `tz` change is itself a feature, not just metadata.** Travel means hotel, alone, disrupted
routine, jetlag — plausibly the highest-risk periods. Expose `days_since_tz_change` and
`is_traveling` to phase 4 for free.

---

## 4. Phase 1 — logging and metrics

### Write path
`POST /api/events` — accepts the event, derives time fields, upserts by client `id`
(idempotent; the PWA may retry offline). Queue writes in IndexedDB when offline and flush on
reconnect. Rejects `ts_utc` older than `backfill_window_days` unless `recalled = 1`.

### Read path
`GET /api/stats` returns, all derived:

- current streak (elapsed-time formula) + confirmed-day count
- personal best, median attempt length, attempt count
- **relapses in last 30 days** (trailing — one slip doesn't erase three months of progress)
- urges logged, last 7d and last 30d
- **relapses per 100 urges**, trailing 90d only — a slow-moving proxy for resist rate. Show it
  *only* once there are ≥50 urges in the window, and never as a headline. The denominator
  depends on how diligently I log, so a drop can mean improvement or just laziness. Two raw
  counts are more honest than one ratio; the ratio is for the trend line, not the home screen.

`GET /api/events?from=&to=` for the charts.

### UI
Home: one big **Log an urge** button. Intensity 0–5, context chips, optional note, done.
Two taps minimum, four for the full record — if it's slower than that I
won't use it in the moment, and the in-the-moment logs are the valuable ones.

Logging is **terminal**. Confirm the entry, show a brief neutral acknowledgement, and end —
no timer, no countdown, no "hang in there" screen, nothing that gives a reason to stay. A
visible clock keeps attention on the urge for as long as it runs, which is the same mistake
the probes made in a longer-lasting form. The app's job at that moment is to be done.

**Outcome is never asked.** Not at log time, not later. If a relapse happened it gets its own
event; silence means it didn't. See §0.

Secondary: today's timeline, stats row, history. Relapse reporting is available directly, not
buried, and takes the same intensity/context/note fields as an urge — that symmetry is what
makes the aggregate comparison work. Its confirmation copy is neutral — no "are you sure?", no red.

### 4.1 Lock and screen hygiene

**Face ID / Touch ID via WebAuthn platform authenticator, PIN as fallback.**

Register once with `authenticatorAttachment: 'platform'`, `residentKey: 'required'`,
`userVerification: 'required'`. Unlock calls `navigator.credentials.get()` with
`userVerification: 'required'` — that's what triggers the OS biometric prompt. iOS falls back
to the device passcode on its own if Face ID fails.

Constraints, all of which are load-bearing:

- **A user gesture is required.** Safari won't allow a WebAuthn call on page load, so the app
  opens to a locked screen with an explicit **Unlock** button. This is wanted, not tolerated —
  the extra tap is a deliberate speed bump.

  > **Superseded (device testing).** The premise is out of date: iOS 17.4 dropped the user-gesture
  > requirement for WebAuthn in favour of rate limiting, and Safari before that allowed one
  > gesture-free `navigator.credentials.get()` per navigation — one more than an unlock needs.
  > The app now prompts for Face ID on launch, with the Unlock button already on screen as the
  > fallback when the call is refused or cancelled. The "deliberate speed bump" argument did not
  > survive contact with using it: the tap read as the app being broken, not as friction worth
  > having.

- **`residentKey: 'discouraged'`, not `'required'`.** A discoverable credential makes iOS show an
  account-picker sheet before Face ID, turning unlock into two taps. Discovery buys nothing for a
  single-user app that stores the credential id locally and passes `allowCredentials` every time —
  and if that storage is ever cleared, the PIN and session token go with it, so there would be
  nothing left for a discoverable credential to unlock.
- **`rpId` must be `cadence.mishabhi.workers.dev`** — the full hostname. Do *not* set it to
  `mishabhi.workers.dev` even if the Public Suffix List permits it: that scope would share the
  credential with every other worker on the same subdomain (the existing Focus PWA included),
  which is both wrong and a small privacy leak. `workers.dev` itself can never be an rpId.
  The credential binds to this exact host, so a later move to a custom domain means
  re-registering — a ~30 second annoyance for one user, not a blocker.
- **App-level PIN fallback**, hashed in localStorage, for desktop, non-Safari browsers, and
  the case where biometrics simply refuse mid-session. Always reachable from the lock screen.
- This is a gate, not security. The assertion is not verified server-side and the data is not
  gated on it. That is a conscious choice given the threat model — do not describe it in the
  UI as anything stronger.

**Blank on background.** On `visibilitychange` → hidden and on `pagehide`, immediately replace
the view with a neutral placeholder. iOS snapshots the app for the app switcher, and that
thumbnail bypasses the lock entirely. Re-lock on resume after a short idle timeout (default 60s)
so quick app-switching mid-log isn't punished.

**Do not use the PRF extension.** It was considered for deriving a note-encryption key from the
authenticator; ruled out along with note encryption generally (§0).

---

## 5. Phase 2 — the one daily push

**Split planning from sending.** A cron that both decides and delivers quantizes every
notification to the tick boundary — with a 30-minute cron everything lands on :00 or :30,
which reads as *more* mechanical, not less.

- **Planner: runs at the 04:00 rollover, plus a safety-net cron every 30 min.** At rollover it
  draws the day's target time and arms a Durable Object alarm for it — hours ahead of the
  window. The ± jitter is only meaningful because of this: computing the target at the moment
  of firing could only ever delay, never advance, so the offset would be one-sided (0 to +25)
  and clustered just after tick boundaries. Plan ahead and the full 20:35–21:25 window is
  genuinely available. The 30-min cron exists to re-arm alarms that were missed (DO eviction,
  deploy, clock skew) and to catch the cases below — it is not the normal send path.
- **Sender: DO alarm.** Fires at arbitrary minute precision. This is what actually delivers.

Two implementation notes:

- **One DO per `(user, kind)`**, addressed with `idFromName(\`${userId}:daily\`)` etc. A DO
  holds only one alarm, so sharing one across daily and risk notifications would mean
  overwriting whichever was armed first. Separate DOs sidestep the coordination entirely and
  cost nothing at a handful of alarms per day. The tradeoff: they can't see each other, so
  `min_push_gap_minutes` is enforced by the planner at plan time and re-checked against D1 by
  the DO immediately before sending.
- **Sane-hours guard, and nothing more, for timezone changes.** Before sending, the DO checks
  the local hour against the *current* tz; if it's outside 07:00–23:59 local, drop the send
  silently and let the next rollover re-plan. This exists because an alarm armed at 04:00
  Pacific for 21:00 Pacific fires at ~04:00 IST if I fly to India that afternoon — a 4am ping
  from this app is the one outcome actually worth preventing.

  **Do not build recompute-and-re-arm-on-tz-change.** It was specced and cut. The rollover
  already reads tz from the most recent event, so the schedule self-corrects within a day; the
  blast radius is one dropped check-in on a travel day, 8–10 times a year. Not worth the
  complexity, and not testable without simulating flights. The guard above is five lines and
  covers the only real harm.

**Jitter the daily check-in ±25 min** around `daily_checkin_hour`, drawn once at the 04:00
rollover and persisted to `notifications.scheduled_for`. Persisting matters: if the jitter is
re-drawn on every safety-net tick the target keeps sliding and may never be reached. Clamp so
it can never cross the 04:00 logical-day boundary or land before ~19:00.

Rationale beyond feel: a notification arriving at exactly 21:00 nightly becomes its own
conditioned cue, which is the §0 rule again. Irregular timing is a design requirement, not a
garnish.

This is the **only** scheduled push until phase 5.

The nightly sweep, in order:

1. Show today's logged events as a timeline.
2. Ask: *"Anything you didn't get to log?"* — coarse buckets (morning / afternoon / evening /
   late night), **not** a time picker. Buckets match how recall actually works; a time picker
   invites invented precision. Backfilled events get `recalled = 1`, `ts_utc` = bucket midpoint.
3. Optional one-line note on the day.
4. Confirm the day.

Three steps, no per-urge follow-ups. The sweep is the only place effort is asked for, so it
stays short or it stops happening.

This does double duty: it's the retrospective data capture *and* it's the habit-forming
mechanism. "Did I log everything?" is a much softer prompt than "are you having an urge?",
which is exactly why it replaced the probes.

Keep `recalled` separate in all analysis — recalled urges are systematically milder and
fuzzier than live ones, and mixing them silently would bias phase 4.

---

## 6. Phase 3 — charts

Client-side, hand-rolled SVG, or Chart.js **vendored into `frontend/js/vendor/`** — a CDN
chart library installs fine and then fails to run offline. These shapes are simple enough that
hand-rolled SVG is the default.

Ordered by how early they say anything, not by how interesting they are. The first group is
readable almost immediately; the second needs volume and renders as noise or emptiness before
it arrives.

**Build first — legible when sparse**

1. **Survival curve** — P(reaching day N) across all attempts. The one that actually teaches
   something: it shows where the cliff is. Readable from about three completed attempts.
2. **Attempts as bars** — every attempt side by side, newest last. Complements the survival
   curve by showing the actual sequence rather than the aggregate, and is legible at n=3.
3. **Coverage calendar** — a small strip of which logical days hold any event at all. Not a
   behaviour metric: it shows data quality, which is the binding constraint on everything
   below and is otherwise buried in the "N of M confirmed" line.
4. Context tag frequency: urge events vs relapse events, side by side. Tags that are common on
   relapses but not on urges are the risk contexts. This is the payoff for tagging both.

**Build once the data supports it**

5. **Satisfaction × gap** — each relapse's `satisfaction` against the elapsed days since the
   previous one. The question is whether a longer gap makes it more or less worth it; needs
   roughly 15 relapses before the scatter means anything.
6. Urges by hour of day — a plain histogram, which works from a few dozen events.
7. Urges by hour × weekday heatmap (`local_hour`). 168 cells: months, not weeks. The
   histogram above is the version that arrives first.
8. Intensity over time with relapse markers.
9. Relapses per 30 days, rolling — the headline progress metric, but needs ~60 days.
10. Relapses per 100 urges, trailing 90d — gated on ≥50 urges in window.

Every chart must render sensibly with two weeks of sparse data. Empty states matter more than
polish here — and an empty state should say what it is waiting for, not just that it is empty.

**The denominator problem is real.** Most of these key off urge volume, and the urge log is the
one that thins out first when logging discipline slips. A chart that silently reads as
"improvement" when it actually means "logged less" is worse than no chart.

**And the missingness is not random — it is inversely correlated with the signal.** Observed in
week one: urges go unlogged specifically *because there are too many to log*. So the denominator
shrinks exactly when the true rate is highest. This is worse than ordinary under-reporting:

- Relapses per 100 urges will **rise** during high-urge stretches purely from a missing
  denominator, which reads as deterioration on top of deterioration.
- Any phase 4 model of urge occurrence is trained on data that systematically under-samples the
  periods it most needs to predict.

Logging was deliberately left as a primary action anyway (it is one extra tap, and the burden
should fall on its own as the rate drops). But do not treat urge counts as a rate until this is
addressed. The cheap fix, if it becomes worth it, is a coarse magnitude question in the nightly
sweep — "roughly how many today: a few / several / lots" — which captures the size of a busy day
without asking for one tap per urge.

---

## 7. Phase 4 — risk model (only after ~200 urge events)

**Split the prediction problem, because the two halves have wildly different data density.**

- **Urge occurrence** — dense. Several per day once logging is habitual. This is what's
  actually learnable.
- **Relapse risk given context** — sparse (4–8 relapses/month), but a much simpler function.
  With per-urge outcome gone, estimate it by contrasting the context/time distribution of
  relapse events against that of urge events — essentially a naive-Bayes likelihood ratio per
  tag and bucket. Less precise than paired outcomes, adequate at this data volume, and it
  costs no extra logging effort.

Predict the first, condition on the second. Do **not** attempt a joint model — 80 relapses/year
against 168 hour×weekday cells will never fit, and any model that appears to fit is overfit.

Grid: 4 buckets × 7 weekdays = 28 cells. Learnable from a few hundred events. Features:
bucket, weekday, days since last relapse, hours since last urge, trailing-7d urge count,
`is_traveling`, recent context tags.

Start with a smoothed empirical rate (Laplace / beta-binomial shrinkage toward the global
rate). Logistic regression at most. Resist anything fancier — with this much data it's
theatre, and it'll be harder to debug than to justify.

Output is a coarse risk score. The honest ceiling is "Thursday evenings after a long day are
your pattern," not "you're at risk in the next 40 minutes" — and the coarse version is more
actionable anyway *and* doesn't need to fire at a vulnerable moment.

Log sample counts alongside every score. A cell with n=3 must be visibly untrustworthy in the UI.

---

## 7b. Roadmap — LLM as a backend, not a chat partner

Everything worth getting back from a model is a **nightly batch over stored text**, not a live
conversation. The live conversation already happens outside the app via the share hand-off; the
model's job in here is to turn text the app already holds into things the app can use.

**The rule that makes this safe:** LLM output lives in the *derived cache* tier alongside
`logical_day` and `bucket` — regenerable, never authoritative. Wrong output is then a bug you
re-run away rather than corruption. Nothing a model produces may enter the source-of-truth tier
(`ts_utc`, `tz`, `kind`) without an explicit human confirmation step.

Ranked by value:

1. **Notes → structured features.** A note is currently human-readable and nothing else —
   invisible to charts and to phase 4. Extracting `{tags, affect, themes}` unlocks data already
   being collected. Highest value, no new UI, no integrity risk.
2. **Natural language → recalled events.** "A few yesterday afternoon, one late night" parsed
   into events. The only item here that *reduces* effort rather than adding to it, which matters
   because friction is what limits the dataset (§6). Touches source of truth, so it needs a
   "here's what I understood" confirm step.
3. **Notification bodies** — phase 5 as already specced.
4. **Vocabulary discovery.** The context tags were guessed before any data existed. Clustering
   notes over months would show which are missing and which never get used.
5. **Periodic narrative summary.** Low risk, moderate value; the share flow already gives most
   of this for free.

**Do not ask a model for:**

- Anything arithmetic does — rates, streaks, the urge/relapse tag contrast. All computed
  deterministically today. A model would be slower, less accurate and non-reproducible.
- **Risk scores.** §7 says start with a smoothed empirical rate and resist anything fancier
  because it is theatre at this data volume. An LLM score is exactly that, plus unfalsifiable:
  there is no way to tell a good one from a confident one.
- Clinical framing of any kind.

---

## 8. Phase 5 — generated notifications

**Never call the LLM at send time.** Latency, cost, and a failed API call means no
notification at all.

Notes are readable server-side by design (§0), so the generator can be seeded with them
directly. Nightly cron generates a small pool (~10) of variants seeded with recent stats and notes,
writes them to `message_pool` with a TTL. The planner evaluates risk, picks an unused
pool message, and arms an alarm with ±10 min jitter. A hardcoded static set is the fallback
whenever the pool is empty or generation failed — the notification always goes out.

System prompt constraints, non-negotiable:
- Curious and matter-of-fact. Never disappointed, never guilt-tripping, never streak-loss framing.
- Notification body must be neutral enough to read on a lock screen in public. No explicit
  reference to the behavior, ever.
- Reference data, not character: "four of five late-night urges this week" not "you're doing great."
- ≤ 100 chars.

**Measure whether this works.** Every notification gets an ID; a follow-up job backfills
`outcome_90m` by joining against events in the next 90 minutes. Compare risk-notified windows
against matched un-notified ones. Within a few months this answers whether notifications help
or whether I've built an expensive way to annoy myself — and if it's the latter, phase 5 gets
deleted, not tuned.

**Enforcing the daily cap: check at fire time, not by disarming.** The DO already hits D1
before sending (for `min_push_gap_minutes`); the same query counts today's sends and aborts if
`max_pushes_per_day` is reached. Do it there rather than in a sweep that disarms alarms.

An armed alarm is a *prediction* that a send will be allowed; the authoritative answer only
exists at fire time. A disarm sweep has to keep that prediction consistent against a moving
D1 state, and it races the alarm it's trying to cancel — a sweep at 20:59 can't reliably beat
an alarm at 21:00. The fire-time check has no race, needs no extra cron pass, and fails closed.
The planner should still decline to arm anything already over cap; that's an optimization, not
the enforcement point.

Cheap and worth it: when the DO aborts, write the notification row with `sent_at = NULL` and a
reason. Otherwise suppressed notifications are invisible and phase 5's attribution analysis
silently loses its control cases.

Note the 30-min planner tick is not a precision constraint here: phase 4 predicts over
4-hour buckets, so the risk score doesn't change meaningfully within half an hour.

---

## 9. Tests worth writing

Not comprehensive — just the things that will silently corrupt data.

- `derive()` across: DST spring-forward and fall-back in `America/Los_Angeles`; `Asia/Kolkata`
  (half-hour offset, no DST); an event at 01:30 local landing on the previous logical day.
- Streak across a SFO→BLR flight (skipped calendar day) and BLR→SFO (doubled 04:00). Elapsed-time
  formula must be unaffected by both.
- `rebuild-derived` is idempotent, and changing `day_boundary_hour` 4→3 reassigns only events
  in hours 03:00–03:59.
- Duplicate `POST /api/events` with the same client `id` inserts once.
- Backfill outside the window is rejected unless `recalled = 1`.
- Stats endpoints return sane values on an empty database and on a single-event database.
- Scheduling: the target is drawn at rollover and stable across safety-net ticks; over many
  simulated days the send times are distributed across the full ±25 min window rather than
  skewed positive or clustered on :00/:30 (this is what catches the plan-at-fire-time bug);
  the jittered time never crosses the 04:00 boundary; a missed alarm is re-armed by the next
  tick rather than skipped; `min_push_gap_minutes` suppresses a second push.
- Sane-hours guard as a pure function with an injected clock and tz — 03:00 IST is dropped,
  21:00 IST sends. No flight simulation needed; that's the point of doing it this way.
  blanked on `visibilitychange` → hidden; re-lock fires after the idle timeout but not on a
  2-second app switch.

Ship a `scripts/seed-synthetic.ts` generating ~6 months of plausible events across three
timezones, so phases 3–4 can be built and eyeballed before real data exists. Keep synthetic
data in a separate `user_id` and never let it reach the real stats path.

---

## 10. Build order for phase 0–1

1. Clone skill assets in; `.skill-assets` manifest; verify `sync-assets.sh` runs clean.
2. Worker + D1 binding + migrations. Neutral app name, manifest, icons.
3. Google OIDC via the skill's verifier — confirm the `aud` check is present and tested.
4. `derive()` + its tests, before any UI. This is the foundation everything else sits on.
5. `POST /api/events`, idempotent, with the offline queue.
6. Home screen: log-urge flow (intensity + context + optional note, then done — no outcome
   prompt, no timer).
7. `GET /api/stats` + stats row.
8. Lock screen: WebAuthn registration + unlock, PIN fallback, blank-on-background (§4.1).
   Decide the final hostname *before* this step.
9. Install prompt (skill asset), verify on a real iPhone — the skill exists because these fail
   silently, so test on device, not in simulator. Test the lock flow **from the home-screen
   install**, not from Safari: the standalone context is where PWA auth historically breaks,
   and a working Safari test proves nothing about it.
10. Deploy. Use it for a week before writing another line.

---

## Appendix A — considered and rejected

Each of these looked like a good idea, was specced, and was cut for a reason that isn't
obvious from the code. Re-proposing them is the most likely failure mode of handing this plan
to someone (or something) that wasn't in the conversation.

**Randomized probes** — push notifications at random times asking "any urge right now?", to
get unbiased sampling data for the risk model. Cut: asking about the behavior is itself a cue,
and the *sender* is a cue regardless of how neutrally the text is worded. Manufacturing the
event you're trying to measure is worse than measuring it coarsely. This is where the §0
interaction rule came from. The unbiased-denominator problem it solved is now handled by
elapsed time between logs plus the nightly recall sweep.

**20-minute countdown after logging an urge** — urges do peak and pass on roughly that scale,
so a timer looked like both an intervention and a natural outcome prompt. Cut: a visible clock
holds attention on the urge for as long as it runs. Same mistake as probes, in a
longer-lasting form. Logging is terminal instead.

**Per-urge outcome resolution** — resolving each urge as resisted/relapsed in the nightly
sweep, stored as a `resolution` event with `ref_id`. Cut as redundant: relapses are already
logged as their own events, so an urge with no relapse near it was resisted. It also created a
queue of past urges to revisit, violating the §0 rule. Cost: the risk model can no longer pair
outcomes, and estimates relapse-context from aggregate distributions instead (§7). Acceptable
at 4–8 relapses/month, where a paired model would have been overfit anyway.

**Resist rate as a headline metric** — demoted, not removed. Without paired outcomes the
denominator is "urges I bothered to log", so the ratio moves with logging discipline, not just
behavior. Survives as relapses-per-100-urges on a 90-day window, gated on ≥50 urges, on the
charts page only.

**Note encryption / WebAuthn PRF** — deriving a note-encryption key from the authenticator.
Cut: E2E encryption makes notes unreadable server-side, which kills note-seeded generation in
phase 5, and buys nothing against a threat model that is "someone reading over my shoulder".
D1 at-rest encryption is sufficient. Don't add application-layer crypto later without
revisiting phase 5.

**Recompute-and-re-arm on timezone change** — detecting a tz change mid-day and rescheduling
the pending notification. Cut: the 04:00 rollover already reads tz from the most recent event,
so the schedule self-corrects within a day. Blast radius is one mistimed or dropped check-in
on a travel day, 8–10 times a year, and it can't be tested without simulating flights. The
sane-hours guard (§5) is five lines and prevents the only real harm, a 4am ping.

Note this is specifically about *scheduling*. Timezone correctness in the **data** was kept and
matters: `derive()` across DST and half-hour offsets, elapsed-time streak across date-line
crossings, and `is_traveling` as a phase 4 feature. Those are pure functions over stored
fields, cheap to test, and wrong-forever if skipped.

**Chatbot counselling via share, not API** — a button that builds a context summary and hands
it to an assistant app through the iOS share sheet, with copy-to-clipboard as the fallback.
Built rather than rejected, but it sits against two constraints and the reasoning should
survive:

- *Why not an API call.* A Claude or ChatGPT subscription does not include API access — they
  are billed separately — so calling the API is a new metered cost, and it would mean building
  a chat UI inside an app whose premise is that you leave quickly. The hand-off uses what is
  already paid for.
- *Against §0.* The in-the-moment entry point was added deliberately after the Appendix A risk
  was flagged: a counselling chat during an active urge is a longer, more engaging version of
  the countdown that was cut. The distinction relied on is that a countdown makes the urge the
  object of attention with nothing to do, whereas a conversation is displacement and
  processing. Cadence's own part stays short — build, hand off, leave — so the app is not the
  thing holding attention. If this turns out to prolong urges rather than defuse them, the
  in-the-moment entry point is the part to delete, not the feature.
- *Against the naming rule.* The generated text lands permanently in another app's history, so
  by default it carries all the data and never names the behaviour, and notes are withheld
  (a note is where the user's own words are most likely to name it). Naming is opt-in per
  share, and the word itself is stored in localStorage — never in D1, where it would persist
  in backups.

**Disarm sweep for over-cap notifications** — a cron pass that cancels armed alarms once the
daily cap is hit. Cut in favour of a fire-time check; see §5.
