import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRebuild, updateStatements } from '../scripts/rebuild-derived.ts';
import { generate, insertStatements, SYNTHETIC_USER } from '../scripts/seed-synthetic.ts';
import { derive, DAY_MS } from '../worker/lib/time.js';
import { makeDb } from './helpers/d1.js';

const IST = 'Asia/Kolkata';
const U = 'u1';

/** Rows as they would come back from D1, derived at `boundary`. */
function rowsAt(boundary, hours) {
  return hours.map((h, i) => {
    const ts = Date.UTC(2026, 5, 15, 0, 0) + h * 3_600_000;
    const d = derive(ts, IST, boundary);
    return { id: `row-${i}`, user_id: U, ts_utc: ts, tz: IST, ...d };
  });
}

const allHours = Array.from({ length: 24 }, (_, h) => h);

test('rebuild is a no-op when nothing changed', () => {
  const rows = rowsAt(4, allHours);
  assert.equal(planRebuild(rows, () => 4).length, 0);
});

test('rebuild is idempotent: applying it leaves nothing to do', () => {
  const rows = rowsAt(4, allHours);
  const updates = planRebuild(rows, () => 3);
  assert.ok(updates.length > 0, 'sanity: the boundary change does something');

  // Apply in place, as the SQL would.
  const byId = new Map(updates.map(u => [u.id, u.to]));
  const after = rows.map(r => (byId.has(r.id) ? { ...r, ...byId.get(r.id) } : r));

  assert.equal(planRebuild(after, () => 3).length, 0, 'second pass changes nothing');
});

test('changing the boundary 4→3 reassigns only the 03:00–03:59 events', () => {
  // The rows are stored in IST, so build them from IST wall-clock hours.
  const rows = allHours.map((h, i) => {
    // 18:30 UTC on the 14th is 00:00 IST on the 15th.
    const ts = Date.UTC(2026, 5, 14, 18, 30) + h * 3_600_000;
    return { id: `row-${i}`, user_id: U, ts_utc: ts, tz: IST, ...derive(ts, IST, 4) };
  });

  const updates = planRebuild(rows, () => 3);
  assert.equal(updates.length, 1);

  const moved = rows.find(r => r.id === updates[0].id);
  assert.equal(derive(moved.ts_utc, IST).local_hour, 3);
  // It moves forward one day: at a 3am boundary, 03:xx is the new day.
  const [y, m, d] = updates[0].from.logical_day.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  assert.equal(updates[0].to.logical_day, next);
});

test('each user gets their own boundary', () => {
  const at3 = Date.UTC(2026, 5, 14, 21, 30);   // 03:00 IST on the 15th
  const rows = [
    { id: 'a', user_id: 'alice', ts_utc: at3, tz: IST, ...derive(at3, IST, 4) },
    { id: 'b', user_id: 'bob', ts_utc: at3, tz: IST, ...derive(at3, IST, 4) },
  ];
  const updates = planRebuild(rows, u => (u === 'alice' ? 3 : 4));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'a');
});

test('generated SQL escapes quotes rather than breaking out of the string', () => {
  const sql = updateStatements([{
    id: "o'brien",
    from: { logical_day: '2026-06-14', local_hour: 3, bucket: 'late' },
    to: { logical_day: '2026-06-15', local_hour: 3, bucket: 'morning' },
  }])[0];
  assert.ok(sql.includes("'o''brien'"));
  assert.equal((sql.match(/;/g) || []).length, 1, 'no statement injection');
});

// ── Synthetic data ──────────────────────────────────────────────────────────

test('the generator is deterministic for a seed', () => {
  const end = Date.UTC(2026, 5, 15);
  assert.deepEqual(generate({ days: 30, seed: 7, endTs: end }),
                   generate({ days: 30, seed: 7, endTs: end }));
  assert.notDeepEqual(generate({ days: 30, seed: 7, endTs: end }),
                      generate({ days: 30, seed: 8, endTs: end }));
});

test('six months of synthetic data is the right order of magnitude', () => {
  const events = generate({ days: 180, seed: 42, endTs: Date.UTC(2026, 5, 15) });
  const urges = events.filter(e => e.kind === 'urge');
  const relapses = events.filter(e => e.kind === 'relapse');

  // Phase 4's gate is ~200 urge events; six months should clear it comfortably.
  assert.ok(urges.length > 250, `urges: ${urges.length}`);
  // Plan §7 assumes 4–8 relapses a month.
  const perMonth = relapses.length / 6;
  assert.ok(perMonth >= 2 && perMonth <= 10, `relapses/month: ${perMonth}`);
  // And enough check-ins that coverage is high but visibly imperfect.
  const dailies = events.filter(e => e.kind === 'daily').length;
  assert.ok(dailies > 100 && dailies < 180, `check-ins: ${dailies}`);
});

test('the generated pattern is the one phase 4 is meant to recover', () => {
  const events = generate({ days: 180, seed: 42, endTs: Date.UTC(2026, 5, 15) });
  const urges = events.filter(e => e.kind === 'urge');
  const relapses = events.filter(e => e.kind === 'relapse');

  const rate = (list, tag) => list.filter(e => e.context.includes(tag)).length / list.length;

  // Relapse contexts must be a biased draw from urge contexts, or the §7
  // likelihood-ratio approach has nothing to find.
  for (const tag of ['alone', 'in_bed', 'tired']) {
    assert.ok(rate(relapses, tag) > rate(urges, tag) + 0.15,
      `${tag}: relapses ${rate(relapses, tag).toFixed(2)} vs urges ${rate(urges, tag).toFixed(2)}`);
  }

  // Urges cluster late; that is the whole premise of the hour-of-day chart.
  const late = urges.filter(e => derive(e.ts_utc, e.tz).bucket === 'late').length / urges.length;
  assert.ok(late > 0.4, `late-bucket share: ${late.toFixed(2)}`);

  // Three zones appear, so is_traveling and the tz-change feature are exercised.
  assert.ok(new Set(events.map(e => e.tz)).size >= 2);
});

test('recalled events are present, milder, and marked', () => {
  const events = generate({ days: 180, seed: 42, endTs: Date.UTC(2026, 5, 15) });
  const urges = events.filter(e => e.kind === 'urge');
  const recalled = urges.filter(e => e.recalled);
  const live = urges.filter(e => !e.recalled);
  assert.ok(recalled.length > 20, `recalled: ${recalled.length}`);
  const mean = xs => xs.reduce((a, e) => a + e.intensity, 0) / xs.length;
  assert.ok(mean(recalled) < mean(live), 'recalled urges must be systematically milder');
});

test('seeded rows load into the real schema and stay out of a real user’s scope', async () => {
  const db = makeDb();
  const events = generate({ days: 20, seed: 3, endTs: Date.UTC(2026, 5, 15) });
  for (const sql of insertStatements(events)) db._raw.exec(sql);

  const mine = db._raw.prepare('SELECT COUNT(*) AS n FROM events WHERE user_id = ?').get('1029384756');
  const synth = db._raw.prepare('SELECT COUNT(*) AS n FROM events WHERE user_id = ?').get(SYNTHETIC_USER);
  assert.equal(mine.n, 0);
  assert.equal(synth.n, events.length);

  // Derived columns are populated, so charts built on synthetic data exercise
  // the same code path as real data.
  const row = db._raw.prepare('SELECT * FROM events LIMIT 1').get();
  assert.match(row.logical_day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(['morning', 'afternoon', 'evening', 'late'].includes(row.bucket));
});

test('reseeding the same seed does not duplicate rows', async () => {
  const db = makeDb();
  const events = generate({ days: 10, seed: 5, endTs: Date.UTC(2026, 5, 15) });
  for (const pass of [1, 2]) {
    for (const sql of insertStatements(events)) db._raw.exec(sql);
    const { n } = db._raw.prepare('SELECT COUNT(*) AS n FROM events').get();
    assert.equal(n, events.length, `after pass ${pass}`);
  }
});

test('synthetic timestamps stay inside the requested window', () => {
  const end = Date.UTC(2026, 5, 15);
  const events = generate({ days: 60, seed: 11, endTs: end });
  for (const e of events) {
    assert.ok(e.ts_utc <= end, 'no event in the future');
    assert.ok(e.ts_utc >= end - 61 * DAY_MS, 'no event before the window');
  }
});
