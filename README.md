# Cadence

A personal abstinence/urge tracker. Installable PWA, one Cloudflare Worker, D1.
Live at **https://cadence.mishabhi.workers.dev**.

`PLAN.md` is the source of truth for *why* anything is the way it is. Read
Appendix A before proposing something that looks like an obvious improvement —
several of those were specced and deliberately cut.

**Phases 1 and 2 are complete and deployed.** Phase 3 (charts) is gated on
about four weeks of data — see the revised, viability-ordered list in PLAN.md §6.

---

## The one rule

> The app must never sustain or initiate attention on the behaviour.

Every interaction is short and terminal: enter, record, leave. No timers, no
countdowns, no "hang in there" screens, no queue of past events to resolve, no
notification that asks about urges. If a change adds a reason to sit in the app
while an urge is running, it is a bug however therapeutic it looks.

Tone is curious and matter-of-fact, never disappointed. Shame is itself a
trigger. This constrains all copy — UI, notifications, and later the LLM prompt.

---

## Layout

```
frontend/        static assets, served by the Worker
  index.html     all screens, one document
  js/lock.js     Face ID / PIN gate + blank-on-background (§4.1)
  js/api.js      API client + IndexedDB outbox
  sw.js          service worker (version stamped by deploy.sh)
worker/
  index.js       router
  lib/time.js    derive() — the foundation everything else sits on
  lib/stats.js   every metric, derived at read time
  schema.sql
scripts/
  rebuild-derived.ts   recompute logical_day/local_hour/bucket from ts_utc+tz
  seed-synthetic.ts    ~6 months of plausible data for building phases 3–4
  dev-token.ts         mint a local session without Google
  make-icons.py
test/            node:test, run with `npm test`
```

## Everyday commands

```bash
npm test                       # 66 tests, no network needed
npm run dev                    # wrangler dev on :8787
./deploy.sh                    # stamp, deploy, wait for propagation
npm run sync-assets            # check the pwa-cloudflare skill copies for drift
```

## Local development

```bash
echo 'TOKEN_SECRET=anything' > worker/.dev.vars
npm --prefix worker run schema:local
npm run dev
```

Then, since there is no Google client ID locally, mint a session by hand:

```bash
node scripts/dev-token.ts --paste     # paste the printed line into the console
```

There is deliberately **no dev-bypass endpoint** in the Worker. An auth hole
that only exists "in dev" is one deploy away from existing in production.

To fill the screens with realistic data:

```bash
node scripts/seed-synthetic.ts --local --apply --user=<the sub from dev-token>
```

`--user` is refused against `--remote`; synthetic data lives under the
`synthetic` user id and must never reach the real stats path.

---

## Google sign-in

Configured and deployed. The client lives in its own Google Cloud project —
**one project per app**, because Branding (the app name users actually see on
the consent screen and in myaccount.google.com/connections) is one-per-project,
and publishing status and any future scope verification are per-project too.
Many clients per project is for one app across web/iOS/Android.

`GOOGLE_CLIENT_ID` is in `worker/wrangler.toml` under `[vars]` — it ships to
browsers anyway, so it is not a secret. The ID-token flow needs no client
secret and no redirect URI, only `https://cadence.mishabhi.workers.dev` as an
**Authorized JavaScript origin** on the client.

`ALLOWED_EMAILS` in the same file is the single-user gate. Accounts are keyed on
Google's immutable `sub`; the email is only an allowlist.

`TOKEN_SECRET` is already set as a Worker secret. Note secrets are per-Worker —
renaming the Worker means running `wrangler secret put` again.

---

## Quick actions from the home screen

The manifest declares `shortcuts` pointing at `/?action=urge` and
`/?action=relapse`, which open straight into that sheet. **Safari does not
implement manifest shortcuts**, so long-pressing the icon on iOS shows only the
system menu — the URLs are the portable half, and iOS reaches them another way:

- **Shortcuts.app** → new shortcut → *Open URL* →
  `https://cadence.mishabhi.workers.dev/?action=urge`. Add that to the home
  screen, or bind it to the Action Button, Back Tap, or Control Center.
- Or add a second home-screen icon pointing straight at the URL.

Shortcut names in the manifest stay neutral ("New entry", "Reset point") because
they render on a home-screen long-press, outside the app's locked interior (§0).

A deep link never bypasses the lock: the action is held until the lock is
satisfied, then the sheet opens. The query param is stripped from the URL on
arrival so a reload doesn't reopen it.

---

## Notifications

One scheduled push a day, and nothing else until phase 5.

**Planning and sending are separate on purpose.** A cron that decided *and*
delivered would quantise every notification to its own tick — on a 30-minute
cron everything lands on :00 or :30, which reads as more mechanical, not less.
So the target is drawn hours ahead and a Durable Object alarm delivers it at
arbitrary minute precision.

- **Planner** (`lib/planner.js`, on the `*/30` cron): draws the day's target
  shortly after that user's own 04:00 local rollover, persists it to
  `notifications.scheduled_for`, and arms the alarm. Idempotent per
  `(user, kind, logical_day)` — once drawn, the target is never redrawn, or the
  jitter would slide forward all evening and might never arrive.
- **Sender** (`do/daily-push.js`): one DO per `(user, kind)`. A DO holds exactly
  one alarm, so sharing one across daily and risk pushes would mean the second
  silently overwrote the first.
- **The fire-time check is the enforcement point**, not a sweep that disarms
  alarms. An armed alarm is a *prediction*; the authoritative answer only exists
  at fire time, and a disarm sweep races the alarm it's cancelling. Suppressions
  are written to the row with a reason, so phase 5's attribution keeps its
  control cases.
- **Sane-hours guard**: outside 07:00–23:59 *local, in the current zone*, the
  send is dropped. This is the entire timezone story for scheduling — an alarm
  armed at 04:00 Pacific fires at ~03:30 IST if you fly that afternoon, and a
  4am ping is the one outcome worth preventing. Recompute-and-re-arm on tz
  change was specced and cut (Appendix A).

**The nightly sweep** opens from the notification (`/?action=sweep`) or from
Progress → *Review today*. Today's timeline, coarse recall buckets, an optional
line about the day, confirm. Buckets are never a time picker — they match how
recall works, and only buckets that have already elapsed are offered, so a 21:00
sweep can't backfill a late night that hasn't happened. Backfilled entries get
`recalled = 1` and the bucket midpoint as their timestamp; keep them separate in
any analysis, since they're systematically milder and fuzzier than live ones.

### Testing the transport

Settings → Notifications → **Enable** registers the device, then **tap the
version number** at the bottom of Settings to send a real push. That turns
"notifications don't work" into a status code: 201 accepted, 403 VAPID
mismatch, 400 encryption, 410 subscription gone.

`POST /api/sweep/plan` plans today's check-in immediately instead of waiting for
a cron tick. It only plans — it cannot make a send happen.

- On iPhone this works **only from the home-screen install**, never a browser
  tab. The UI says so when it detects that state.
- Permission is requested inside the click handler — iOS refuses it outside a
  user gesture.
- `VAPID_PUBLIC_KEY` is in `wrangler.toml`; the private half is a Worker secret.
  Rotating them invalidates every subscription and every device must re-subscribe.
- `pushsubscriptionchange` posts to `/api/push/rotate`, which is **public by
  necessity** — a service worker holds no session token. It is authorised by
  possession of the old endpoint and can do exactly one thing: swap an endpoint
  on a row that already exists.
- The service-worker half is hand-written rather than importing
  `webpush-edge/sw`, because that needs `{ type: 'module' }` registration and
  iOS is the whole point of the feature.
- All notification text stays neutral enough to read on a lock screen in public
  (§0). The title is only ever "Cadence".

---

## Things that will bite

**Time is the highest-risk area.** `worker/lib/time.js` is a pure function over
`(ts_utc, tz)` and everything else is a cache. Two rules:

- Store the IANA zone name, never an offset. `+05:30` means different places in
  March and November, and DST rules change.
- Charts group by `local_hour` / `bucket`, never by UTC hour. 23:00 IST and
  23:00 EST are the same behavioural moment.

`derive()` shifts the **wall clock**, not the instant — the plan's sketch did the
latter, which is off by a day for 04:00–05:00 events on a DST spring-forward
date. There is a test pinning this.

**Home has no data on it.** Two buttons, nothing else — anything on that screen
is something to read while an urge is running, which is the §0 rule. Numbers
live on Progress, behind a deliberate tap.

**`satisfaction` is relapse-only, `intensity` is urge-only.** Both 0–5, both
optional, and both use `!= null` checks throughout: 0 is a real answer and on
satisfaction it is the most interesting one. The field exists to be correlated
against the gap it ended — see the pairing test in `test/events.test.js`.

**Streak is elapsed time, coverage counts days.** Deliberately different
formulas: counting distinct days breaks in both directions across the Pacific,
while check-ins are inherently per-day. See §3.

**Changing `day_boundary_hour` does not rewrite history.** Existing rows keep
their cached `logical_day` until you run:

```bash
node scripts/rebuild-derived.ts            # dry run, shows what would change
node scripts/rebuild-derived.ts --apply
```

It is idempotent — a second run should report zero changes.

**Deploys need two reloads.** The first load installs the new service worker,
the second runs it. On iOS that means force-quitting from the app switcher
twice. Check the build stamp at the bottom of Progress rather than guessing.

Asset URLs carry `?v=<build>`, stamped into `index.html` by `deploy.sh`, so that
first load can never pair new markup with the previous build's CSS — which
rendered as a broken layout rather than a stale one. `sw.js` builds the same
suffix from its own stamped `VERSION`, and the two must stay byte-identical or
the app silently loses offline support: the page would request a URL the cache
has never held. `deploy.sh` rewrites `?v=` in `.html` files only, precisely so
the literal in `sw.js` survives.

**Face ID prompts on launch, not on a tap.** §4.1 assumed Safari forbids
WebAuthn outside a user gesture; iOS 17.4 dropped that requirement, and older
Safari allowed one gesture-free `get()` per navigation anyway. The Unlock button
is the fallback. After one refused or cancelled automatic attempt the app stops
retrying for that page session — otherwise choosing the PIN means fighting a
Face ID sheet that keeps reappearing.

**The lock is a gate, not security.** The WebAuthn assertion is not verified
server-side and no data is gated on it. The threat model is someone standing
next to me reading the screen. Do not describe it in the UI as anything more.

**`rpId` is the full hostname.** Moving to a custom domain means re-registering
the passkey. Never widen it to `mishabhi.workers.dev` — that would share the
credential with every other worker on the subdomain, the Focus PWA included.

---

## Before phase 2

Use it daily for about a week first. Phases 4–5 are worthless without months of
real data, and building them early means fitting a model to nothing.
