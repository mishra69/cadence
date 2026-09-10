# Journal

Narrative history. `PLAN.md` says what the app is meant to be; this says what
actually happened on the way, including the parts that didn't work. Newest first.

Git history covers *what* changed. This covers *why*, and the wrong turns that
don't leave a trace in a diff.

---

## 2026-09-09, later — the veil conceded, logic extracted, notifications fixed

Both threads left open by the entry below closed on the same evening, one badly
and one well.

**The veil lost, and the loss is now written down.** The opacity fix changed
nothing: the app switcher still shows the real screen. Two implementations were
tried — toggling `display`, then holding the veil on a pre-promoted compositor
layer and toggling only `opacity`, so raising it cost neither layout nor paint —
and neither moved. The handlers fire; that much is verified. What cannot be
forced is a *paint* before iOS takes the snapshot, and iOS captures the last
frame it painted, which is the one from before the handler ran. A native app
gets `applicationWillResignActive` and a guaranteed render opportunity. A web
app has no equivalent.

The instinct was to rip out everything added for it. That would have been wrong:
the veil has three jobs and only one failed. It still blanks the cold start
before the lock screen paints, and still covers the moment the app re-locks on
resume. Ripping it out would have regressed two working protections to fix none.
What went instead was the speculation — back to `display: none`, and the
permanent full-screen `will-change: opacity` layer with it, which cost memory
for nothing.

What was added is the truth, in the places someone would look. §0 marks the
requirement **NOT MET** rather than continuing to list it as a feature, §4.1
carries the amendment and an instruction not to spend more time here, and
`onHide()` says in the code that its presence is not evidence the requirement is
met. The failure mode being guarded against is a future reader — most likely me
— seeing a veil in the source and a requirement in the plan and assuming it is
handled. **The app-switcher thumbnail is public.** The lock still protects the
contents, which need the app opened. That was judged an acceptable residual risk
for a single-user app.

**The extraction went in.** `calc.js` now holds the deciding and the render
functions keep the drawing: the logical-day shift, the hour stepper and its
clamps, the tumbler state, the scrub's touch-to-index mapping, the ribbon
wording. 165 tests became 185.

It is a plain script with one global rather than a module, deliberately. A module
imports its neighbours relatively, and a relative import cannot carry the `?v=`
stamp the service worker precaches by — the trap `deploy.conf` already documents
for webpush-edge. Tests reach it through a `vm` context instead, which has a
second benefit: anything reaching for `document` throws on load rather than
passing against a shim production does not have. Two things that cost time and
are worth remembering: the vm realm has its own `Object.prototype`, so
`deepStrictEqual` fails on prototype identity alone; and the first guard was
*too* tight — `URL` is not a DOM API, it exists in Node as much as in a browser,
and the harness had to name it explicitly.

**And a real bug surfaced, by using the app rather than by testing it.** A daily
check-in notification tapped while the app was already running landed on Home
instead of the sweep. Not a regression — that path was untouched since the first
commit. `notificationclick` focused the existing window and then called
`WindowClient.navigate()`, which **Safari does not implement**. So on the one
platform this feature exists for, focusing was all that happened: the
`?action=sweep` never reached a live page. It worked only from a cold start,
which takes the `clients.openWindow()` branch — hence the intermittency, and
hence `opened_at` being recorded for seven of nine notifications rather than
all of them. Those seven were cold opens. The service worker now posts the
destination to the focused client instead.

**On testing, concluded.** Going back through every UI bug this project has had:
the ones caught by eye — a ramp escalating the wrong way, a ragged ribbon, a
stranded tab bar, contrast too low — would have been caught by nothing, because
they were judgements or iOS-only. The ones a test would have caught were all
arithmetic, and all of them are now reachable from `node:test` with no browser.
Playwright stays deferred: for an app behind Google sign-in, a device lock and
passkeys, the setup cost is a day, and the class of bug it adds coverage for is
the class already covered. This bug is the counter-example worth holding onto
though — it was found by tapping a notification, and no unit test would have
suggested `WindowClient.navigate()` was missing.

---

## 2026-09-06 – 09-09 — logging accuracy, the tumbler, and the veil

The week the open questions got answered, mostly in our favour.

**Time of day on a relapse.** Logging one hours after it happened turned out to
be the normal case rather than the exception — one that puts you to sleep gets
logged the next morning. Until now an ordinary log stamped `now`, and the only
way to say otherwise was the return-prompt flow: whole days at local midday,
and only after a detected gap.

The argument that settled it was not the one I made. I had reasoned from the
hour-of-day distribution — logging a 2pm relapse at 11pm files it as `late`
instead of `afternoon`, and biases *systematically* toward evening because
evening is when you sit with your phone. The stronger argument was the 04:00
boundary: a 1am relapse logged at 09:15 lands on the wrong **logical day**,
moving its ribbon cell, the streak start, and both attempt lengths around it.
An hour-level error, but a day-level consequence. The stepper now names the
resulting day whenever it differs from the one the app would assume, so the
flip is visible before saving. `logicalDateOf` shifts the wall clock rather
than the instant, matching §3's correction for the server's `derive()`.

**The morning check-in got a strength.** Binary yes/no threw away the
distinction worth having. The interesting part was the numbering. Production
had six rows at `0` ("no"), three at `1` ("yes"), and — decisively — **zero**
at `2` ("don't recall"), which freed everything above `1` to be renumbered
without touching a row. The obvious mapping would have quietly relabelled those
three "yes" answers as "mild", so `1` is kept as legacy, never offered again,
and excluded from the strength split. Same instinct as nulls-as-gaps: three
rows did not answer a question about strength, and saying they did would invent
the distinction the change exists to make.

**The tumbler.** A glass under the stats row that fills as the streak day does.
Anchored to the last relapse rather than the logical day, because `streakDays`
counts elapsed time — a fill tied to 04:00 would empty at a different moment
than the number above it increments. Held back for four hours after a relapse:
an empty glass beside a full "24h 0m" is the least useful it ever looks, and
those are the hours it would be looked at hardest. It shipped with a 30-second
timer, which was the wrong instinct twice over — a level that creeps while
being watched invites watching it, and Progress sits behind a deliberate tap
precisely so it cannot be watched. Removed.

**Two bugs on the phone, one real, one not what it looked like.**

The tab bar was found stranded mid-page with the ribbon continuing underneath
it. Cause: the **document** was the scroller, and `position: fixed` resolves
against the viewport, so iOS occasionally repainted the bar at a stale offset
mid-fling. Each `.screen` now scrolls itself; the viewport never moves, so
there is no offset to be stale about. It also demoted
`overscroll-behavior: none` from load-bearing to redundant, which is just as
well — it was never reliable on iOS.

The privacy veil was reported not working, and the reflex was to hunt a logic
bug. There wasn't one: `pagehide` raises the veil and it covers the viewport,
verified. What it lost was a **race**. `[hidden]` means `display: none`, so
raising the veil needed a layout pass and a paint, and iOS snapshots the last
frame it painted — the frame from before the handler ran. It now stays laid out
on its own compositor layer and toggles opacity alone. This improves the odds
and does not guarantee them; if iOS still snapshots ahead of the composite,
there is no further pure-web lever. **Still unproven on device.**

**Verification, at last.** Most of the handoff's unverified list came back
clean: the morning notifications arrive and behave, sharing to ChatGPT and
friends works on iOS, and the lock re-registration path is confirmed. The
ribbon is settled. `outcome_90m` was dropped outright rather than deferred —
not important enough to carry. That leaves the veil as the one shipped-but-
unproven item, and phase 4 as the one open decision.

**On testing.** Every UI bug this week was caught by eye, which prompted the
question of whether Playwright was missing. Going back through them, it would
have caught none: the ramp, the ribbon, the tab bar and the contrast were all
either judgement calls or iOS-only. What it *would* have caught is
logic-reached-through-the-DOM — the `el` scoping slip in `show()`, the hour
clamp, the morning chips writing the right value. All of which is reachable
from `node:test` with no browser at all, if the pure parts are pulled out of
the render functions they are currently tangled with. That extraction is the
next piece of work; Playwright stays deferred until it is clear what remains
uncovered.

---

## 2026-09-05 — version control, chart scrubbing, the ramp

A day of being wrong in useful ways.

It opened with no repository at all — around twenty-five deploys and no history,
the top-ranked debt in the previous session's handoff. `git init` came first,
65 files at deploy `20260905_1759`, with `.dev.vars` already correctly ignored.
`deploy.conf` got `GIT_COMMIT=1` so every deploy now stamps its own commit and a
version string maps back to a tree. That closed the debt end to end on its first
run.

Then a detour into **why the charts were hand-rolled**. The answer turned out to
be less principled than the code implied: the pwa-cloudflare skill says *"vendor
every CDN dependency locally"* and is actively pro-library elsewhere (*"use
webpush-edge — don't hand-roll the encryption"*). Only the CDN option was ever
ruled out; hand-rolling was `PLAN.md`'s own call on three simple shapes. I also
overstated the cost of vendoring — claimed a library would re-download on every
deploy, which is wrong, since an unversioned vendored file survives in the HTTP
cache exactly like `webpush-edge` does.

Then I **started work nobody asked for**: an `outcome_90m` backfill, off the back
of a description I had written into an option that was labelled *"leave it,
decide later."* A deferral is not a work order. Stopped, correctly. The file was
broken anyway — it imported a `constants.js` that never existed — and it later
got swept into a commit by an over-broad `git add -A worker`, then removed in
`43916cd`.

The real bugs came after.

**The multi-slip ramp was inverted.** It escalated toward black
(`color-mix(--viz-slip 78%, #000)`), a light-background convention, on a
`#202638` surface. Two slips moved *toward* the background and three landed near
`--viz-unknown`, the "nothing logged" grey. More was drawn as less. Corrected to
escalate up in lightness, then it took two more passes to get the step wide
enough to see: L\* 75, then 83 with a hue rotation from orange toward gold. If
it is still not enough, the next lever is not colour — there is little lightness
headroom left above `#bf7d34` before it collides with `--text`, so a notch or
inset mark on multi-slip cells is the move.

**Scrubbing shipped twice.** First as a readout line below the plot, argued for
on the grounds that a phone tooltip appears under the finger asking for it. That
was the wrong call — it makes you look away from the point you are touching. It
was rebuilt as a pill over the plot. The pill tracks x but stays pinned to the
top rather than following the point's y, because this series swings 4→6→4
between adjacent days and a y-anchored pill would leap around while dragging.

**The ribbon was packed tight, then widened again a message later** —
`max-width: 232px` for density, then dropped entirely to fill the column. The
two requests pull against each other; it landed on full width with 2px gaps.

**Its jutting bottom row was a real bug, not a layout accident.** The days pulled
in by week alignment were drawn as absent `pad` cells, which left the first
column empty above the bottom row and made the block read as a staircase. They
were never absent: `/api/series` loads the whole history, not the window, so
those days had data all along. A cell is now absent only if the day has not
happened yet. Knock-on: the panel title moved from the rolling series to the
ribbon's own drawn range, since week alignment makes the ribbon the wider of the
two.

Five deploys (`_1759` → `_2337`), 163 tests to 164, nothing known broken.

**Left open, deliberately:** phase 4 (§7's density premise is false in
production — 1 urge against 13 relapses), `outcome_90m` still never populated,
the 9-vs-10 ribbon column wobble when paging, and every device-verification item
from the previous handoff — the privacy veil, the morning notification, and the
lock re-registration — all still unconfirmed on the phone.
