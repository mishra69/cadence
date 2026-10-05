# Issues

Known problems not yet fixed. Standing in for an issue tracker until the repo
has a remote. `PLAN.md` is what the app should be, `JOURNAL.md` is what
happened; this is what is known to be wrong.

Newest first. Close an issue by moving it to **Closed** with the commit that
fixed it — don't delete it, since why it was wrong is often the useful part.

---

## Open

### 1. `/api/series` silently drops the oldest events past 2,000

**Found** 2026-10-05 · **Bites** around early 2029 · **Severity** wrong numbers, no error

`/api/series` loads the whole history to draw the Progress charts:

```js
// worker/index.js:358
const events = await listEvents(db, userId, { limit: 5000 });
```

but `listEvents` caps every request at 2,000 without saying so:

```js
// worker/lib/events.js:223
).bind(...binds, Math.min(Number(limit) || 500, 2000)).all();
```

Rows come back newest first (`ORDER BY ts_utc DESC`), so past 2,000 events
the **oldest** are dropped without any error or log line.

**What goes wrong**

- `tracking_since` moves forward to the oldest *loaded* event, so the chart
  stops offering "older" before history actually runs out.
- The history gates in `rollingRelapses` (`hist >= 7`, `hist >= 28`) measure
  from that wrong start. Near the start of the record, points that could be
  drawn are left out.
- The ribbon draws days before the first entry as absent (since 2026-10-05).
  Past the cap, the first *loaded* entry is no longer the first entry, so
  real days at the start of the record would vanish from the ribbon as if
  they predated the app.
- `relapseGaps` loses its earliest attempts, so the chart's typical line
  stops matching "typical" in the stats row. The stats row isn't affected: it
  reads relapses with no `LIMIT` (`worker/lib/stats.js:84`). A test checks the
  two agree, but only with fewer than 2,000 events, so it won't catch this.

**When**

97 events in the first 48 days (2026-08-18 → 2026-10-05), so about 2 a day
counting morning check-ins and reviews. That reaches 2,000 in about 2½ years.
More logging brings it closer.

**Fix**

- Load only what is drawn: events from the start of the window being drawn
  onward, plus the full relapse list for the gap chart (small, and already
  fetched this way in `getStats`).
- Get the tracking start from one aggregate query, as `getStats` already does
  (`SELECT MIN(ts_utc) ... FROM events WHERE user_id = ?`).
- Add a test with more than 2,000 events, so the cap can't drop rows silently
  again. Also have `listEvents` report when it truncates instead of capping
  quietly.

**Related**

The comment above that relapse query (`worker/lib/stats.js:82`) says relapses
are "rare by construction (4–8/month)". In production it's about 20 a month.
Fetching them all is still cheap, but the stated reason is out of date.

---

## Closed

*(none yet)*
