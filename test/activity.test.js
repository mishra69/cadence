import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastActivityAt, assessGap, onSeen, backfillWindow, streakConfidence,
} from '../worker/lib/activity.js';
import { DAY_MS } from '../worker/lib/time.js';

const NOW = Date.UTC(2026, 7, 29, 12, 0);
const ago = d => NOW - d * DAY_MS;
const STALE = 3;

// ── What counts as activity ─────────────────────────────────────────────────

test('opening the app counts, even with nothing logged', () => {
  // The user's point: opening and reporting nothing is itself a statement.
  assert.equal(lastActivityAt({ lastSeenAt: ago(1), lastEventAt: ago(9) }), ago(1));
});

test('logging counts too, and the most recent of the two wins', () => {
  assert.equal(lastActivityAt({ lastSeenAt: ago(9), lastEventAt: ago(2) }), ago(2));
  assert.equal(lastActivityAt({ lastSeenAt: null, lastEventAt: ago(4) }), ago(4));
  assert.equal(lastActivityAt({ lastSeenAt: null, lastEventAt: null }), null);
});

// ── Detecting the gap ───────────────────────────────────────────────────────

test('a first run is not a gap', () => {
  // Nothing on record must not greet a new user with "you were away".
  assert.deepEqual(assessGap({ lastActivity: null, now: NOW, staleAfterDays: STALE }),
                   { stale: false, gap_days: 0 });
});

test('the threshold is three days of total silence', () => {
  assert.equal(assessGap({ lastActivity: ago(2), now: NOW, staleAfterDays: STALE }).stale, false);
  assert.equal(assessGap({ lastActivity: ago(3), now: NOW, staleAfterDays: STALE }).stale, true);
  assert.equal(assessGap({ lastActivity: ago(9), now: NOW, staleAfterDays: STALE }).gap_days, 9);
});

test('daily opens never trip it, however little is logged', () => {
  let lastSeen = ago(30);
  for (let d = 30; d >= 0; d--) {
    const at = ago(d);
    const { stale } = assessGap({ lastActivity: lastSeen, now: at, staleAfterDays: STALE });
    assert.equal(stale, false, `tripped on day ${d}`);
    lastSeen = at;
  }
});

// ── The open that notices ───────────────────────────────────────────────────

test('a normal open records the visit and asks nothing', () => {
  const r = onSeen({
    lastSeenAt: ago(1), lastEventAt: ago(1), pendingGapStart: null,
    now: NOW, staleAfterDays: STALE,
  });
  assert.equal(r.needs_review, false);
  assert.equal(r.pending_gap_start, null);
  assert.equal(r.last_seen_at, NOW);
});

test('returning after a long absence raises the prompt and pins the gap start', () => {
  const r = onSeen({
    lastSeenAt: ago(9), lastEventAt: ago(11), pendingGapStart: null,
    now: NOW, staleAfterDays: STALE,
  });
  assert.equal(r.needs_review, true);
  assert.equal(r.pending_gap_start, ago(9), 'the gap starts at the last sign of life');
  assert.equal(r.gap_days, 9);
});

test('the prompt survives being ignored', () => {
  // last_seen_at is bumped by the very open that spots the gap, so without
  // persisting pending_gap_start the prompt would appear once and never again.
  const first = onSeen({
    lastSeenAt: ago(9), lastEventAt: null, pendingGapStart: null,
    now: NOW, staleAfterDays: STALE,
  });
  const second = onSeen({
    lastSeenAt: first.last_seen_at, lastEventAt: null,
    pendingGapStart: first.pending_gap_start,
    now: NOW + 60_000, staleAfterDays: STALE,
  });
  assert.equal(second.needs_review, true);
  assert.equal(second.pending_gap_start, ago(9), 'still measured from the original gap');
});

// ── Placing a relapse on return ─────────────────────────────────────────────

test('backfill is capped at the configured window, not the whole gap', () => {
  // The chosen behaviour: away 9 days, you may still only place it in the last
  // 3. A relapse that really happened on day 8 gets recorded as 3 days ago,
  // which understates the streak rather than overstating it.
  const w = backfillWindow({ gapStart: ago(9), now: NOW, backfillWindowDays: 3 });
  assert.equal(w.earliest, ago(3));
  assert.equal(w.latest, NOW);
  assert.equal(w.capped, true, 'the UI should say the window is shorter than the gap');
});

test('a short gap is not padded out to the full window', () => {
  // Away 2 days: offering 3 would let a date be placed before the user was last
  // active, overwriting a stretch already accounted for.
  const w = backfillWindow({ gapStart: ago(2), now: NOW, backfillWindowDays: 3 });
  assert.equal(w.earliest, ago(2));
  assert.equal(w.capped, false);
});

// ── How the streak is presented ─────────────────────────────────────────────

test('an unresolved gap makes the streak unverified without changing it', () => {
  const c = streakConfidence({
    pendingGapStart: ago(9), lastActivity: NOW, now: NOW, staleAfterDays: STALE,
  });
  assert.equal(c.unverified, true);
  assert.equal(c.unverified_since, ago(9));
  assert.equal(c.unverified_days, 9);
});

test('accounting for the gap restores confidence', () => {
  const c = streakConfidence({
    pendingGapStart: null, lastActivity: NOW, now: NOW, staleAfterDays: STALE,
  });
  assert.deepEqual(c, { unverified: false, unverified_since: null, unverified_days: 0 });
});

test('drifting again is flagged before the next open', () => {
  // The screen may be read without a fresh open — a stale streak must not be
  // presented as confirmed just because no gap has been recorded yet.
  const c = streakConfidence({
    pendingGapStart: null, lastActivity: ago(5), now: NOW, staleAfterDays: STALE,
  });
  assert.equal(c.unverified, true);
  assert.equal(c.unverified_days, 5);
});

test('a brand new user is never told the streak is unverified', () => {
  const c = streakConfidence({
    pendingGapStart: null, lastActivity: null, now: NOW, staleAfterDays: STALE,
  });
  assert.equal(c.unverified, false);
});

test('inactivity never alters the streak itself — only the claim about it', () => {
  // The §3 rule that survives: pausing is not resetting. Nothing in this module
  // returns or mutates a streak length.
  const c = streakConfidence({
    pendingGapStart: ago(40), lastActivity: ago(40), now: NOW, staleAfterDays: STALE,
  });
  assert.equal(c.unverified, true);
  assert.ok(!('streak_days' in c), 'must not express an opinion about the number');
});
