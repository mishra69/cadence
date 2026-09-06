#!/usr/bin/env node
/**
 * Generate ~6 months of plausible events so phases 3–4 can be built and
 * eyeballed before real data exists (plan §9).
 *
 * The data lives under its own user_id and must never reach the real stats
 * path. That isolation is structural rather than a convention: every query in
 * the Worker is scoped to the authenticated user's Google `sub`, which is a
 * numeric string and can never equal 'synthetic'.
 *
 * Usage:
 *   node scripts/seed-synthetic.ts --local --apply
 *   node scripts/seed-synthetic.ts --remote --apply
 *   node scripts/seed-synthetic.ts --purge --local --apply
 *   node scripts/seed-synthetic.ts --days=180 --seed=7
 *   node scripts/seed-synthetic.ts --local --apply --user=<sub>   # eyeball the UI
 *
 * --user is refused against --remote: seeding a real user id there is exactly
 * the leak into the real stats path this separation exists to prevent.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derive, localParts, fromLocal, DAY_MS } from '../worker/lib/time.js';

const DB = 'cadence-db';
// wrangler resolves the D1 binding from wrangler.toml, which lives in worker/.
// Running it from the repo root finds no config and reports the database as
// missing rather than as misconfigured, which is a confusing five minutes.
const WORKER_DIR = fileURLToPath(new URL('../worker', import.meta.url));
export const SYNTHETIC_USER = 'synthetic';

// Three zones, so charts and the phase 4 is_traveling feature get exercised.
// The trip is what makes tz a feature rather than metadata (§3).
const ZONES = [
  { tz: 'America/Los_Angeles', weight: 0.6 },
  { tz: 'Asia/Kolkata', weight: 0.3 },
  { tz: 'America/New_York', weight: 0.1 },
];

/** Deterministic PRNG, so a bug found while eyeballing a chart is reproducible. */
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SyntheticEvent = {
  id: string; kind: string; ts_utc: number; tz: string;
  intensity: number | null; satisfaction: number | null;
  context: string[]; note: string | null; recalled: number;
};

/**
 * The generator encodes the shape the phase 4 model is supposed to find: urges
 * cluster late at night, relapses are a biased draw from urge contexts (heavier
 * on 'alone', 'in_bed' and 'tired'), and travel raises the rate. If a model
 * cannot recover that from this data, the model is wrong — that is the point of
 * generating it rather than using noise.
 */
export function generate({ days = 180, seed = 42, endTs = Date.now() } = {}): SyntheticEvent[] {
  const rnd = mulberry32(seed);
  const events: SyntheticEvent[] = [];
  const start = endTs - days * DAY_MS;

  // One trip, so the zone change is a discrete event rather than noise.
  const tripStart = start + Math.floor(days * 0.55) * DAY_MS;
  const tripEnd = tripStart + 16 * DAY_MS;

  const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];

  let uid = 0;
  const nextId = () => {
    uid++;
    // Stable, obviously-fake UUIDs: a synthetic row is recognisable at a glance
    // in the database.
    return `5eed0000-0000-4000-8000-${String(uid).padStart(12, '0')}`;
  };

  let lastRelapse = start;

  for (let d = 0; d < days; d++) {
    const dayStart = start + d * DAY_MS;
    const traveling = dayStart >= tripStart && dayStart < tripEnd;
    const tz = traveling ? ZONES[1].tz : (rnd() < 0.9 ? ZONES[0].tz : ZONES[2].tz);

    // Hours below are LOCAL hours. Placing them by epoch arithmetic instead
    // would scatter the late-night cluster across whatever the zone's offset
    // happens to be — the exact mistake the "group by local_hour, never UTC
    // hour" rule in §3 exists to prevent, and invisible in the raw data.
    const { year, month, day: dayOfMonth } = localParts(dayStart, tz);
    const atLocal = (h: number, m: number) => fromLocal(tz, year, month, dayOfMonth, h, m);

    // Urges per day: mostly 0–3, more when travelling, more as the streak ages.
    const streakDays = (dayStart - lastRelapse) / DAY_MS;
    const base = 1.4 + (traveling ? 1.0 : 0) + Math.min(streakDays / 30, 1.2);
    const count = Math.max(0, Math.round(base + (rnd() - 0.5) * 2.2));

    for (let i = 0; i < count; i++) {
      // Bimodal: a small late-morning bump, a much heavier late-night one.
      const lateNight = rnd() < 0.62;
      // 22:00–01:59 local; hours ≥ 24 roll into the next calendar day, which
      // still belongs to this logical day under the 04:00 boundary.
      const hour = lateNight
        ? 22 + Math.floor(rnd() * 4)
        : 9 + Math.floor(rnd() * 8);               // 09:00–16:59 local
      const ts = atLocal(hour, Math.floor(rnd() * 60));
      if (ts > endTs) continue;

      const context = new Set<string>();
      if (lateNight) { context.add('alone'); if (rnd() < 0.7) context.add('in_bed'); }
      if (rnd() < 0.55) context.add('phone');
      if (lateNight && rnd() < 0.5) context.add('tired');
      if (rnd() < 0.25) context.add('bored');
      if (rnd() < (traveling ? 0.45 : 0.22)) context.add('stressed');
      if (!lateNight && rnd() < 0.4) context.add('alone');

      const intensity = Math.min(5, Math.max(0,
        Math.round((lateNight ? 3.1 : 2.1) + (rnd() - 0.5) * 2.4)));

      // Recalled events come in through the nightly sweep, are systematically
      // milder, and must stay distinguishable — phase 4 would be biased if they
      // were mixed in silently.
      const recalled = rnd() < 0.18;

      events.push({
        id: nextId(), kind: 'urge', ts_utc: ts, tz,
        intensity: recalled ? Math.max(0, intensity - 1) : intensity,
        satisfaction: null,
        context: [...context].sort(),
        note: rnd() < 0.08 ? pick(['long day', 'couldn’t sleep', 'nothing much', 'bad meeting']) : null,
        recalled: recalled ? 1 : 0,
      });
    }

    // Relapse: rare, and drawn from the high-risk corner of the same space, so
    // the urge/relapse context contrast in §7 has something real to find.
    // Calibrated to the 4–8 relapses/month the plan assumes in §7 — that rate
    // is what makes a paired outcome model overfit and the aggregate contrast
    // the right call, so the synthetic data has to actually sit there.
    const relapseChance = (traveling ? 0.34 : 0.20) * (streakDays > 3 ? 1 : 0.3);
    if (rnd() < relapseChance) {
      const hour = rnd() < 0.8 ? 23 + Math.floor(rnd() * 3) : 14;
      const ts = atLocal(hour, Math.floor(rnd() * 60));
      if (ts <= endTs) {
        const context = new Set(['alone']);
        if (rnd() < 0.85) context.add('in_bed');
        if (rnd() < 0.90) context.add('tired');
        if (rnd() < 0.6) context.add('phone');
        if (rnd() < 0.35) context.add('stressed');
        // Satisfaction falls as the gap it ended grows. The DIRECTION HERE IS
        // INVENTED — it is a plausible shape to build charts against, not a
        // finding. Phase 3 must be read against real data only; if a chart
        // built on this looks convincing, that is the generator talking.
        const gap = Math.min(streakDays, 45) / 45;
        const satisfaction = Math.min(5, Math.max(0,
          Math.round(3.6 - gap * 2.2 + (rnd() - 0.5) * 2)));
        events.push({
          id: nextId(), kind: 'relapse', ts_utc: ts, tz,
          intensity: null, satisfaction, context: [...context].sort(), note: null, recalled: 0,
        });
        lastRelapse = ts;
      }
    }

    // Daily check-ins: frequent but not perfect, so coverage is below 100%.
    if (rnd() < 0.78) {
      const ts = atLocal(20 + Math.floor(rnd() * 3), Math.floor(rnd() * 60));
      if (ts <= endTs) {
        events.push({
          id: nextId(), kind: 'daily', ts_utc: ts, tz,
          intensity: null, satisfaction: null, context: [], note: null, recalled: 0,
        });
      }
    }
  }

  return events.sort((a, b) => a.ts_utc - b.ts_utc);
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const sqlValue = (v: string | number | null) =>
  v == null ? 'NULL' : (typeof v === 'number' ? String(v) : sqlString(v));

export function insertStatements(events: SyntheticEvent[], userId = SYNTHETIC_USER): string[] {
  return events.map(e => {
    const { logical_day, local_hour, bucket } = derive(e.ts_utc, e.tz);
    // Recalled events were received later than they happened; live ones were not.
    const createdAt = e.recalled ? e.ts_utc + 8 * 3_600_000 : e.ts_utc;
    const cols = [
      sqlString(e.id), sqlString(userId), sqlString(e.kind), e.ts_utc, sqlString(e.tz),
      sqlString(logical_day), local_hour, sqlString(bucket),
      sqlValue(e.intensity), sqlValue(e.satisfaction),
      e.context.length ? sqlString(JSON.stringify(e.context)) : 'NULL',
      sqlValue(e.note), e.recalled, createdAt,
    ];
    return `INSERT OR REPLACE INTO events (id, user_id, kind, ts_utc, tz, logical_day, local_hour, bucket, intensity, satisfaction, context, note, recalled, created_at) VALUES (${cols.join(', ')});`;
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const where = argv.includes('--remote') ? '--remote' : '--local';
  const apply = argv.includes('--apply');
  const purge = argv.includes('--purge');
  const num = (flag: string, dflt: number) => {
    const a = argv.find(x => x.startsWith(`--${flag}=`));
    return a ? Number(a.split('=')[1]) : dflt;
  };

  // Seeding under a real user id is only ever legitimate for eyeballing the UI
  // against a local sqlite file. Allowing it against --remote would be exactly
  // the "synthetic data reaching the real stats path" the plan rules out, so it
  // is refused rather than warned about.
  const userArg = argv.find(a => a.startsWith('--user='));
  const userId = userArg ? userArg.split('=')[1] : SYNTHETIC_USER;
  if (userId !== SYNTHETIC_USER && where === '--remote') {
    console.error(`refusing to seed user '${userId}' against --remote. Use ${SYNTHETIC_USER}, or --local.`);
    process.exit(1);
  }

  const statements: string[] = [];
  if (purge) statements.push(`DELETE FROM events WHERE user_id = ${sqlString(userId)};`);

  let events: SyntheticEvent[] = [];
  if (!purge || argv.some(a => a.startsWith('--days'))) {
    events = generate({ days: num('days', 180), seed: num('seed', 42) });
    statements.push(...insertStatements(events, userId));
  }

  const urges = events.filter(e => e.kind === 'urge').length;
  const relapses = events.filter(e => e.kind === 'relapse').length;
  const dailies = events.filter(e => e.kind === 'daily').length;
  console.log(`${events.length} events: ${urges} urges, ${relapses} relapses, ${dailies} check-ins`);
  console.log(`user_id = ${userId}, target ${where}`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }

  const file = join(mkdtempSync(join(tmpdir(), 'cadence-seed-')), 'seed.sql');
  writeFileSync(file, statements.join('\n') + '\n');
  execFileSync('npx', ['wrangler', 'd1', 'execute', DB, where, '--file', file], { stdio: 'inherit', cwd: WORKER_DIR });
  console.log('\nDone.');
}

if (import.meta.filename === process.argv[1]) main();
