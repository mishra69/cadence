// Client-side logic, tested without a browser.
//
// These are the cases that would silently show the wrong thing rather than
// throw — the same bar the rest of the suite is held to. What a colour looks
// like, whether a chart is legible, and how a drag feels are not here and
// cannot be: no assertion catches a judgement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCalc } from './helpers/frontend.js';

const Calc = loadCalc();
const HOUR = 3_600_000;
const DAY = 86_400_000;

// Local midday, so nothing sits near a boundary by accident. These use local
// time on purpose: the wall clock is what the day boundary is defined against.
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

// ── The logical day ─────────────────────────────────────────────────────────

test('before the boundary hour belongs to the previous day', () => {
  const b = 4;
  assert.equal(Calc.logicalDate(at(2026, 9, 9, 3, 59), b).getDate(), 8, '03:59 is still the 8th');
  assert.equal(Calc.logicalDate(at(2026, 9, 9, 4, 0), b).getDate(), 9, '04:00 starts the 9th');
  assert.equal(Calc.logicalDate(at(2026, 9, 9, 23, 30), b).getDate(), 9);
});

test('the boundary rolls the month and the year', () => {
  const d = Calc.logicalDate(at(2027, 1, 1, 2, 0), 4);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 11);   // December
  assert.equal(d.getDate(), 31);
});

test('a boundary of 0 makes the logical day the calendar day', () => {
  assert.equal(Calc.logicalDate(at(2026, 9, 9, 0, 30), 0).getDate(), 9);
});

// ── The hour stepper ────────────────────────────────────────────────────────

test('stepping back across the boundary flips the day it counts as', () => {
  // The case this control was built for: a 1am relapse logged at 09:15.
  const now = at(2026, 9, 9, 9, 15);
  const pick = h => Calc.hourPick({ hoursAgo: h, now, boundaryHour: 4, backfillDays: 3 });

  assert.equal(pick(4).flipped, false, '05:15 is still today');
  assert.equal(pick(6).flipped, true, '03:15 belongs to yesterday');
  assert.equal(pick(8).flipped, true, '01:15 belongs to yesterday');
  assert.equal(pick(8).logicalDate.getDate(), 8);
});

test('the stepper cannot leave the backfill window the server enforces', () => {
  const now = at(2026, 9, 9, 12, 0);
  const pick = h => Calc.hourPick({ hoursAgo: h, now, boundaryHour: 4, backfillDays: 3 });

  assert.equal(pick(0).canFwd, false, 'nothing is more recent than now');
  assert.equal(pick(0).canBack, true);
  assert.equal(pick(72).canBack, false, '3 days is the window');
  assert.equal(pick(72).hoursAgo, 72);
  // An out-of-range value is clamped rather than trusted: the server would
  // reject the event outright, and a client should never be able to build one.
  assert.equal(pick(200).hoursAgo, 72);
  assert.equal(pick(-5).hoursAgo, 0);
});

test('a wider backfill window widens the stepper with it', () => {
  const now = at(2026, 9, 9, 12, 0);
  assert.equal(Calc.hourPick({ hoursAgo: 200, now, boundaryHour: 4, backfillDays: 14 }).hoursAgo, 200);
  assert.equal(Calc.hourPick({ hoursAgo: 400, now, boundaryHour: 4, backfillDays: 14 }).hoursAgo, 336);
});

test('stepHoursAgo clamps at both ends', () => {
  assert.equal(Calc.stepHoursAgo(0, -1, 3), 0);
  assert.equal(Calc.stepHoursAgo(0, 1, 3), 1);
  assert.equal(Calc.stepHoursAgo(72, 1, 3), 72);
  assert.equal(Calc.stepHoursAgo(71, 1, 3), 72);
});

// ── The tumbler ─────────────────────────────────────────────────────────────

test('the tumbler is held back for the first four hours after a relapse', () => {
  const t = at(2026, 9, 9, 6, 0);
  assert.equal(Calc.tumblerState(t, t + 3.9 * HOUR).visible, false);
  assert.equal(Calc.tumblerState(t, t + 4 * HOUR).visible, true);
});

test('the tumbler still appears at each daily tick, which is a day earned', () => {
  const t = at(2026, 9, 9, 6, 0);
  // The glass empties at 24h as it does right after a relapse, but this
  // emptying is the opposite kind of moment and is not hidden.
  const tick = Calc.tumblerState(t, t + DAY);
  assert.equal(tick.visible, true);
  assert.equal(tick.fill, 0);
  assert.equal(tick.label, 'to day 2');
  assert.equal(Calc.tumblerState(t, t + 2 * DAY).label, 'to day 3');
});

test('the fill tracks the position within the day, not the day count', () => {
  const t = at(2026, 9, 9, 6, 0);
  assert.equal(Calc.tumblerState(t, t + 6 * HOUR).fill, 0.25);
  assert.equal(Calc.tumblerState(t, t + 30 * HOUR).fill, 0.25, 'day two, same quarter');
  assert.equal(Calc.tumblerState(t, t + 12 * HOUR).fill, 0.5);
});

test('no relapse on record means no anchor and nothing shown', () => {
  // Without one there is no 24h boundary to fill against, and counting toward
  // an invented one would be worse than showing nothing.
  assert.equal(Calc.tumblerState(null, Date.now()).visible, false);
});

test('a clock that has gone backwards never shows a negative fill', () => {
  const t = at(2026, 9, 9, 6, 0);
  assert.equal(Calc.tumblerState(t, t - HOUR).visible, false);
});

test('the remaining label drops the hours inside the last hour', () => {
  assert.equal(Calc.remainingLabel(9 * HOUR + 12 * 60000), '9h 12m');
  assert.equal(Calc.remainingLabel(12 * 60000), '12m');
  assert.equal(Calc.remainingLabel(0), '0m');
  assert.equal(Calc.remainingLabel(HOUR), '1h 0m');
});

// ── The scrub ───────────────────────────────────────────────────────────────

test('the scrub maps a touch to the nearest point and never past the ends', () => {
  // A 320-unit viewBox drawn into a 640px box: every reading has to survive
  // that 2x scale, which is why offsetX would be wrong here.
  const geom = { boxLeft: 0, boxWidth: 640, viewWidth: 320, padLeft: 24, innerWidth: 286, count: 63 };
  const at_ = x => Calc.scrubIndex({ ...geom, clientX: x });

  assert.equal(at_(48), 0, 'the left edge of the plot is the first point');
  assert.equal(at_(620), 62, 'the right edge is the last');
  assert.equal(at_(-500), 0, 'dragging off the left clamps rather than wrapping');
  assert.equal(at_(5000), 62, 'and off the right');
  assert.equal(at_(334), 31, 'the midpoint is the middle point');
});

test('a single-point series always scrubs to that point', () => {
  assert.equal(Calc.scrubIndex({
    clientX: 999, boxLeft: 0, boxWidth: 640,
    viewWidth: 320, padLeft: 24, innerWidth: 286, count: 1,
  }), 0);
});

// ── Ribbon wording ──────────────────────────────────────────────────────────

// calc.js runs in its own vm realm, so the objects it returns carry that
// realm's Object.prototype and deepStrictEqual fails on prototype identity
// alone. Spreading re-homes the fields here without weakening the comparison.
const words = d => ({ ...Calc.dayWords(d) });

test('a day says what it is, and a slip carries the weight', () => {
  assert.deepEqual(words({ state: 'relapse', count: 1 }),
    { what: 'slip', emphasis: 'strong', confirmed: false });
  assert.deepEqual(words({ state: 'relapse', count: 3, confirmed: true }),
    { what: '3 slips', emphasis: 'strong', confirmed: true });
  assert.deepEqual(words({ state: 'clean', count: 0, confirmed: true }),
    { what: 'reviewed, no slip', emphasis: 'plain', confirmed: false });
  // Absence is de-emphasised for the same reason it is grey in the grid.
  assert.deepEqual(words({ state: 'unknown', count: 0 }),
    { what: 'nothing logged', emphasis: 'dim', confirmed: false });
});

test('an unreviewed day says something was logged, not that nothing was', () => {
  assert.deepEqual(words({ state: 'unknown', count: 0, logged: true }),
    { what: 'logged, not reviewed', emphasis: 'dim', confirmed: false });
});

test('"confirmed" is only spelled out on a slip day, where it adds something', () => {
  // On a blue day it is what blue means; saying it again is noise.
  assert.equal(words({ state: 'clean', count: 0, confirmed: true }).confirmed, false);
  assert.equal(words({ state: 'relapse', count: 1, confirmed: true }).confirmed, true);
});

// ── Notification deep links ─────────────────────────────────────────────────

test('a deep link yields its action and the notification that sent it', () => {
  const O = 'https://cadence.example';
  assert.deepEqual({ ...Calc.readAction('/?action=sweep&n=abc-123', O) },
    { action: 'sweep', notificationId: 'abc-123' });
  assert.deepEqual({ ...Calc.readAction('/?action=morning&n=x', O) },
    { action: 'morning', notificationId: 'x' });
  // Absolute too: a cold open parses location.href, a running app parses a URL
  // posted in by the service worker. Both must read the same.
  assert.deepEqual({ ...Calc.readAction(O + '/?action=relapse&n=q', O) },
    { action: 'relapse', notificationId: 'q' });
});

test('an unrecognised action comes back null rather than being routed', () => {
  // consumePendingAction falls through to openLog(action) for anything it does
  // not recognise, so a stray value must never reach it.
  const O = 'https://cadence.example';
  assert.equal(Calc.readAction('/?action=bogus&n=y', O).action, null);
  assert.equal(Calc.readAction('/?action=&n=y', O).action, null);
  assert.equal(Calc.readAction('/', O).action, null);
  // A notification id can arrive without an action; the open is still recorded.
  assert.equal(Calc.readAction('/?n=only', O).notificationId, 'only');
  assert.equal(Calc.readAction('/', O).notificationId, null);
});

test('every action the push sender emits is one the client accepts', () => {
  // worker/do/daily-push.js sends exactly these two. If either side is renamed
  // without the other, the tap silently lands on whatever screen was open —
  // which is precisely the bug this pairing exists to prevent.
  for (const a of ['sweep', 'morning']) {
    assert.equal(Calc.readAction(`/?action=${a}`, 'https://x').action, a);
  }
});

test('a filed tap is collected while fresh and ignored once stale', () => {
  const TTL = 10 * 60_000;
  const filed = at(2026, 9, 13, 21, 0);
  assert.equal(Calc.inboxIsStale(filed, filed, TTL), false, 'collected immediately');
  assert.equal(Calc.inboxIsStale(filed, filed + TTL, TTL), false, 'the boundary is still fresh');
  assert.equal(Calc.inboxIsStale(filed, filed + TTL + 1, TTL), true);
  // A tap that failed to raise the app is still worth answering on the next
  // launch, which is the whole reason the window is minutes rather than seconds.
  assert.equal(Calc.inboxIsStale(filed, filed + 4 * 60_000, TTL), false);
  // A device whose clock moved backwards must not read as impossibly stale and
  // silently swallow the tap.
  assert.equal(Calc.inboxIsStale(filed, filed - HOUR, TTL), false);
  // Nothing to act on is not the same as something too old, but both refuse.
  assert.equal(Calc.inboxIsStale(null, Date.now(), TTL), true);
  assert.equal(Calc.inboxIsStale(undefined, Date.now(), TTL), true);
});

// ── Attempt lengths ─────────────────────────────────────────────────────────

test('an attempt under two days reads in hours, not as a flattened day', () => {
  // The whole point. Flooring to days made 24h, 28h, 36h and 47h all read "1d",
  // so a cadence that nearly doubled was invisible in the number.
  const L = Calc.attemptLabel;
  assert.equal(L(24 * HOUR), '24h');
  assert.equal(L(28 * HOUR), '28h');
  assert.equal(L(36 * HOUR), '36h');
  assert.equal(L(47 * HOUR), '47h');
  assert.notEqual(L(28 * HOUR), L(47 * HOUR), 'these must not collapse together');
});

test('two days is the switch, and it is exact', () => {
  const L = Calc.attemptLabel;
  assert.equal(L(Calc.HOURS_BELOW_MS - 1), '47h', 'a millisecond under');
  assert.equal(L(Calc.HOURS_BELOW_MS), '2d', 'and at it');
  assert.equal(L(2 * DAY), '2d');
  assert.equal(L(6 * DAY), '6d');
});

test('the label floors in both units, so it never claims time that has not passed', () => {
  const L = Calc.attemptLabel;
  // 47h59m is not two days, and rendering "48h" would read as exactly that.
  assert.equal(L(47 * HOUR + 59 * 60_000), '47h');
  assert.equal(L(HOUR - 1), '0h', 'the first hour is not yet an hour');
  assert.equal(L(0), '0h');
  // Above the switch the same applies: 6d23h is not a week.
  assert.equal(L(6 * DAY + 23 * HOUR), '6d');
});

test('an absent or nonsense length has no label rather than a wrong one', () => {
  // The caller falls back to the floored day field, so returning null has to be
  // distinguishable from returning "0h" — which is a real, different answer.
  for (const v of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(Calc.attemptLabel(v), null, String(v));
  }
  // A clock that went backwards is clamped, not shown as negative time.
  assert.equal(Calc.attemptLabel(-5 * HOUR), '0h');
});

// ── The re-lock window ──────────────────────────────────────────────────────

test('the re-lock window reads every value localStorage can hold', () => {
  const FALLBACK = 60;
  const r = v => Calc.relockAfter(v, FALLBACK);

  // Never set: the configured default, not zero.
  assert.equal(r(null), FALLBACK);
  assert.equal(r(undefined), FALLBACK);

  // The ordinary choices. Strings, because that is what localStorage returns.
  assert.equal(r('0'), 0, 'immediately');
  assert.equal(r('300'), 300);
  assert.equal(r('7200'), 7200);

  // "When I close the app" — Infinity so `away > window` is never true, which
  // is what lets onShow() stay a single comparison.
  assert.equal(r('-1'), Infinity);
  assert.ok(!(Number.MAX_SAFE_INTEGER > r('-1')), 'no elapsed time re-locks');
});

test('a corrupted re-lock window fails closed, never open', () => {
  // This is the one direction that matters. Locking sooner than asked is a
  // nuisance; not locking when asked is the failure the lock exists to prevent,
  // so anything unreadable must collapse to "immediately" and not to the
  // never-lock sentinel.
  for (const junk of ['', 'abc', '{}', 'Infinity-ish', 'NaN']) {
    assert.equal(Calc.relockAfter(junk, 60), 0, JSON.stringify(junk));
  }
  // Neither is a value the UI can produce, but both parse as numbers, so the
  // behaviour is pinned rather than left to chance. '-Infinity' is the sharp
  // one: it is negative, and a naive sign check would hand it the never-lock
  // sentinel — failing open on unreadable input, the exact inversion.
  assert.equal(Calc.relockAfter('Infinity', 60), 0);
  assert.equal(Calc.relockAfter('-Infinity', 60), 0);
  // The sentinel is only ever a finite negative.
  assert.equal(Calc.relockAfter('-1', 60), Infinity);
});

// ── The loader itself ───────────────────────────────────────────────────────

test('calc.js reaches for no browser-only globals', () => {
  // The vm context is given only APIs that exist in Node as well as a browser
  // (URL and friends). document, window, localStorage and navigator are absent,
  // so any use of one throws on load rather than reaching this line. Asserting
  // it explicitly keeps the guarantee visible: this file is testable precisely
  // because it has no DOM in it.
  assert.equal(typeof Calc.tumblerState, 'function');
  assert.doesNotThrow(() => loadCalc());
});

// ── The gap chart ───────────────────────────────────────────────────────────

test('a touch lands on the band it is in, edges included', () => {
  // 10 bars across 286 units starting at 28, drawn at 2x.
  const g = { boxLeft: 0, boxWidth: 640, viewWidth: 320, padLeft: 28, innerWidth: 286, count: 10 };
  const at = x => Calc.bandIndex({ ...g, clientX: x });
  assert.equal(at(2 * 28 + 1), 0, 'just inside the first band');
  assert.equal(at(2 * (28 + 28.6) - 1), 0, 'its far edge is still the first bar');
  assert.equal(at(2 * (28 + 28.6) + 1), 1);
  assert.equal(at(2 * (28 + 286) - 1), 9, 'the last band');
  assert.equal(at(-100), 0, 'off the left clamps');
  assert.equal(at(9999), 9, 'off the right clamps');
});

test('bands and points disagree, which is why bars need their own mapping', () => {
  // A touch in the right half of the first band. Bars: still bar 0. Points:
  // rounds to point 1 out of 10 — the wrong bar.
  const g = { boxLeft: 0, boxWidth: 320, viewWidth: 320, padLeft: 0, innerWidth: 300, count: 10 };
  assert.equal(Calc.bandIndex({ ...g, clientX: 25 }), 0);
  assert.equal(Calc.scrubIndex({ ...g, clientX: 25 }), 1);
});

// Spread for the same reason as words(): an array made in calc.js's vm realm
// carries that realm's Array.prototype, and deepEqual fails on identity alone.
const ticksH = ms => [...Calc.gapTicks(ms)].map(t => t / HOUR);

test('gap ticks fall on whole days and always clear the tallest bar', () => {
  const ticks = ticksH;
  assert.deepEqual(ticks(62.5 * HOUR), [0, 24, 48, 72], 'your current longest');
  assert.deepEqual(ticks(48 * HOUR), [0, 24, 48]);
  assert.deepEqual(ticks(20 * DAY).filter((_, i) => i).every(h => h % 120 === 0), true,
    'a long gap steps by 5 days, not 24 gridlines');
  assert.ok(Calc.gapTicks(20 * DAY).length <= 6);
  for (const ms of [1, 30 * HOUR, 62.5 * HOUR, 9 * DAY, 40 * DAY]) {
    assert.ok(Calc.gapTicks(ms).at(-1) >= ms, `top tick clears ${ms / HOUR}h`);
  }
});

test('sub-day gaps get half-day ticks rather than one gridline', () => {
  assert.deepEqual(ticksH(10 * HOUR), [0, 12]);
  assert.deepEqual(ticksH(20 * HOUR), [0, 12, 24]);
  assert.deepEqual(ticksH(0), [0, 12], 'never a single tick');
});

test('the gap tooltip keeps every hour, where the stats row drops them', () => {
  assert.equal(Calc.preciseSpan(62.5 * HOUR), '2d 14h', 'attemptLabel would say "2d"');
  assert.equal(Calc.attemptLabel(62.5 * HOUR), '2d');
  assert.equal(Calc.preciseSpan(31 * HOUR), '31h', 'under two days it reads the same as the row');
  assert.equal(Calc.preciseSpan(48 * HOUR), '2d 0h');
  assert.equal(Calc.preciseSpan(47 * HOUR + 59 * 60_000), '47h', 'floors, never rounds up');
  assert.equal(Calc.preciseSpan(19 * DAY + 5 * HOUR), '19d 5h');
  assert.equal(Calc.preciseSpan(null), null);
});
