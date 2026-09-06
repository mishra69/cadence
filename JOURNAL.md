# Journal

Narrative history. `PLAN.md` says what the app is meant to be; this says what
actually happened on the way, including the parts that didn't work. Newest first.

Git history covers *what* changed. This covers *why*, and the wrong turns that
don't leave a trace in a diff.

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
