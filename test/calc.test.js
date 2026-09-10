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
  assert.deepEqual(words({ state: 'clean', count: 0 }),
    { what: 'logged, no slip', emphasis: 'plain', confirmed: false });
  // Absence is de-emphasised for the same reason it is grey in the grid.
  assert.deepEqual(words({ state: 'unknown', count: 0 }),
    { what: 'nothing logged', emphasis: 'dim', confirmed: false });
});

// ── The loader itself ───────────────────────────────────────────────────────

test('calc.js reaches for no browser globals', () => {
  // It runs in a bare vm context, so any use of document, window or localStorage
  // would have thrown on load rather than reaching this line. Asserting it
  // explicitly keeps the guarantee visible: this file is testable precisely
  // because it has no DOM in it.
  assert.equal(typeof Calc.tumblerState, 'function');
  assert.doesNotThrow(() => loadCalc());
});
