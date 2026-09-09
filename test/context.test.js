import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../worker/lib/context.js';
import { DAY_MS } from '../worker/lib/time.js';

const NOW = Date.UTC(2026, 7, 31, 12, 0);
const ago = d => NOW - d * DAY_MS;

const STATS = {
  has_data: true,
  streak_days: 12,
  days_tracked: 90,
  best_days: 31,
  median_attempt_days: 9,
  attempt_count: 7,
  relapses_30d: 3,
  urges_30d: 40,
  confidence: { unverified: false, unverified_days: 0 },
};

const urge = (over = {}) => ({
  kind: 'urge', ts_utc: ago(2), bucket: 'late', context: ['alone', 'in_bed'], ...over,
});
const relapse = (over = {}) => ({
  kind: 'relapse', ts_utc: ago(12), bucket: 'late', context: ['alone', 'tired'], ...over,
});

const EVENTS = [
  ...Array.from({ length: 12 }, () => urge()),
  ...Array.from({ length: 4 }, () => urge({ bucket: 'evening', context: ['bored'] })),
  relapse({ ts_utc: ago(40) }),
  relapse({ ts_utc: ago(25), satisfaction: 3 }),
  relapse({ ts_utc: ago(12), satisfaction: 1 }),
];

const build = (over = {}) =>
  buildContext({ mode: 'reflect', stats: STATS, events: EVENTS, now: NOW, ...over });

// ── The naming rule ─────────────────────────────────────────────────────────

test('by default the shared text never names the behaviour', () => {
  // §0: the word should not appear outside the app's locked interior, and this
  // text lands permanently in another app's history.
  const out = build();
  assert.match(out, /track a habit I'm working on\./);
  assert.ok(!/porn|masturbat|drink|smok/i.test(out), 'must not name anything');
});

test('a term opts into naming it, and only then', () => {
  const out = build({ term: 'my drinking' });
  assert.match(out, /my drinking/);
  assert.ok(!out.includes("a habit I'm working on"));
});

test('notes are withheld unless notes were opted into', () => {
  // A note is the most likely place the behaviour gets named in the user's own
  // words, so it rides with the explicit setting rather than the default.
  const events = [...EVENTS, urge({ note: 'the thing I do not want written down' })];
  assert.ok(!build({ events }).includes('do not want written down'));
  assert.ok(build({ events, includeNotes: true }).includes('do not want written down'));
});

// ── The tone rules ──────────────────────────────────────────────────────────

test('the prompt states the tone constraints rather than assuming them', () => {
  const out = build();
  // Left to itself a chatbot reaches for exactly the register §0 rejects.
  assert.match(out, /Curious and matter-of-fact/);
  assert.match(out, /Shame makes this worse/);
  assert.match(out, /data, not to my character/);
  assert.match(out, /questions before offering advice/);
  assert.match(out, /throw away/, 'must name streak-loss framing as unwanted');
});

test('the text works pasted into an existing chat, not just a new one', () => {
  // There is no way to know which from here, so the line has to be true either
  // way — and it has to establish that these numbers supersede any already in
  // the conversation, or a second paste leaves two sets with no ordering.
  const out = build();
  assert.match(out, /If we have talked about this earlier in this conversation/);
  assert.match(out, /keep everything I\ntold you then/);
  assert.match(out, /figures below replace any\nyou already have/);
});

test('in-the-moment asks for something short; reflection does not', () => {
  const now = build({ mode: 'now' });
  assert.match(now, /difficult moment/);
  assert.match(now, /Keep your first\nreply short/);

  const reflect = build({ mode: 'reflect' });
  assert.match(reflect, /reflecting, not in a difficult moment/);
  assert.ok(!/Keep your first/.test(reflect));
});

// ── The data ────────────────────────────────────────────────────────────────

test('the summary carries the numbers worth talking about', () => {
  const out = build();
  assert.match(out, /12 days since the last slip/);
  assert.match(out, /Longest stretch so far: 31 days/);
  assert.match(out, /Typical stretch: 9 days/);
  assert.match(out, /3 slips, 40 urges logged/);
});

test('an unverified streak says so rather than presenting a clean number', () => {
  const out = build({
    stats: { ...STATS, confidence: { unverified: true, unverified_days: 6 } },
  });
  assert.match(out, /unconfirmed for 6 of them/);
});

test('the dominant time-of-day cluster is called out', () => {
  const out = build();
  assert.match(out, /late night: 12/);
  assert.match(out, /The late night cluster is the obvious one/);
});

test('risk tags are the ones over-represented in slips, not the common ones', () => {
  const out = build();
  // 'alone' is on nearly every urge too, so it carries little signal; 'tired'
  // appears on slips and not on urges, which is the §7 contrast.
  assert.match(out, /when I slip, more than when I just get an urge: tired/);
});

test('satisfaction is paired with the gap it ended', () => {
  const out = build();
  assert.match(out, /after 15 days: 3\/5/);
  assert.match(out, /after 13 days: 1\/5/);
});

test('morning readings appear once there are enough to mean anything', () => {
  const few = [...EVENTS, { kind: 'daily', ts_utc: ago(1), morning_wood: 1, context: [] }];
  assert.ok(!/Morning erections/.test(build({ events: few })));

  const enough = [...EVENTS,
    { kind: 'daily', ts_utc: ago(1), morning_wood: 1, context: [] },
    { kind: 'daily', ts_utc: ago(2), morning_wood: 1, context: [] },
    { kind: 'daily', ts_utc: ago(3), morning_wood: 0, context: [] },
    { kind: 'daily', ts_utc: ago(4), morning_wood: 1, context: [] },
  ];
  assert.match(build({ events: enough }), /Morning erections: 3 of the last 4 mornings/);
});

test('a forgotten morning is excluded, not counted as a no', () => {
  // "Don't recall" is an answer about memory, not about the morning. Folding it
  // in either direction would invent a trend out of forgetfulness.
  const events = [...EVENTS,
    { kind: 'daily', ts_utc: ago(1), morning_wood: 3, context: [] },
    { kind: 'daily', ts_utc: ago(2), morning_wood: 2, context: [] },
    { kind: 'daily', ts_utc: ago(3), morning_wood: 0, context: [] },
    { kind: 'daily', ts_utc: ago(4), morning_wood: 4, context: [] },
    { kind: 'daily', ts_utc: ago(5), morning_wood: 4, context: [] },
  ];
  assert.match(build({ events }), /Morning erections: 2 of the last 3 mornings I could remember\./);
});

test('strength is reported only where strength was asked', () => {
  const graded = [...EVENTS,
    { kind: 'daily', ts_utc: ago(1), morning_wood: 3, context: [] },
    { kind: 'daily', ts_utc: ago(2), morning_wood: 2, context: [] },
    { kind: 'daily', ts_utc: ago(3), morning_wood: 0, context: [] },
  ];
  assert.match(build({ events: graded }), /Of those: 1 strong, 1 mild\./);

  // The legacy binary "yes" counts as present but has no strength. Reporting it
  // as either would manufacture the distinction this question was added to make.
  const legacy = [...EVENTS,
    { kind: 'daily', ts_utc: ago(1), morning_wood: 1, context: [] },
    { kind: 'daily', ts_utc: ago(2), morning_wood: 1, context: [] },
    { kind: 'daily', ts_utc: ago(3), morning_wood: 0, context: [] },
  ];
  const out = build({ events: legacy });
  assert.match(out, /Morning erections: 2 of the last 3 mornings/);
  assert.ok(!/Of those:/.test(out), 'legacy rows must not be given a strength');
});

// ── Degenerate cases ────────────────────────────────────────────────────────

test('a brand new user still produces something shareable', () => {
  const out = buildContext({
    mode: 'reflect',
    stats: {
      has_data: false, streak_days: null, days_tracked: 0, best_days: null,
      median_attempt_days: null, attempt_count: 0, relapses_30d: 0, urges_30d: 0,
      confidence: { unverified: false, unverified_days: 0 },
    },
    events: [],
    now: NOW,
  });
  assert.match(out, /Curious and matter-of-fact/);
  assert.match(out, /Last 30 days: 0 slips/);
  assert.ok(!out.includes('undefined') && !out.includes('NaN'));
});

test('no slip on record reports days tracked instead of a streak', () => {
  const out = build({ stats: { ...STATS, streak_days: null } });
  assert.match(out, /Tracking for 90 days; no slip logged yet/);
});

test('the text stays short enough to paste comfortably', () => {
  // A share sheet and a chat input both get unwieldy past a couple of thousand
  // characters, and the point is to start a conversation, not deliver a report.
  assert.ok(build().length < 2500, `length ${build().length}`);
});

test('mode tags are both counted and contrasted', () => {
  // Recorded on urges as well as relapses, so the lift is a real comparison
  // rather than the tautology it would be if they were relapse-only.
  const events = [
    ...Array.from({ length: 8 }, () => urge()),
    ...Array.from({ length: 2 }, () => urge({ context: ['alone', 'porn'] })),
    relapse({ ts_utc: ago(40), context: ['alone', 'tired', 'porn'] }),
    relapse({ ts_utc: ago(25), context: ['alone', 'tired', 'porn'], satisfaction: 3 }),
    relapse({ ts_utc: ago(12), context: ['alone', 'imagination'], satisfaction: 1 }),
  ];
  const out = buildContext({ mode: 'reflect', stats: STATS, events, now: NOW });

  assert.match(out, /Of 3 slips where I noted what was involved: 2 involved porn, 1 involved imagination\./);
  const contrast = out.match(/more than when I just get an urge: (.+)\./);
  assert.ok(contrast, 'the contrast line should still be produced');
  // 67% of slips against 20% of urges is genuine signal, so it belongs here.
  assert.match(contrast[1], /porn/, 'a real lift should surface');
  assert.match(contrast[1], /tired/, 'alongside the situational signals');
});

test('slips from before the field was required are excluded, not counted as no', () => {
  // The field became required partway through, so earlier slips carry no mode
  // tag. Counting them in the denominator would report a rate that is wrong in
  // a way that looks like a finding rather than like missing data.
  const events = [
    ...Array.from({ length: 8 }, () => urge()),
    relapse({ ts_utc: ago(60), context: ['alone'] }),            // before
    relapse({ ts_utc: ago(50), context: ['alone', 'tired'] }),   // before
    relapse({ ts_utc: ago(10), context: ['alone', 'porn'] }),    // after
    relapse({ ts_utc: ago(5), context: ['alone', 'porn'] }),     // after
  ];
  const out = buildContext({ mode: 'reflect', stats: STATS, events, now: NOW });

  assert.match(out, /Of 2 slips where I noted what was involved/);
  assert.match(out, /the other 2 predate my recording this/);
  assert.match(out, /2 involved porn/);
  assert.ok(!/Of 4 slips/.test(out), 'unanswered slips must not pad the denominator');
});
