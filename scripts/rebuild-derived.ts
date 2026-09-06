#!/usr/bin/env node
/**
 * Recompute logical_day / local_hour / bucket for every event from its stored
 * (ts_utc, tz).
 *
 * This script is what makes the 04:00 day boundary a *setting* rather than a
 * permanent commitment, and what makes the derived columns a cache rather than
 * data. If it stops working, the schema quietly becomes immutable.
 *
 * Usage:
 *   node scripts/rebuild-derived.ts                    # dry run against remote
 *   node scripts/rebuild-derived.ts --apply
 *   node scripts/rebuild-derived.ts --local --apply
 *   node scripts/rebuild-derived.ts --boundary=3 --apply
 *   node scripts/rebuild-derived.ts --user=synthetic --apply
 *
 * With no --boundary it reads each user's own day_boundary_hour, so a rebuild
 * after changing the setting in the app needs no arguments beyond --apply.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derive } from '../worker/lib/time.js';

const DB = 'cadence-db';
// wrangler resolves the D1 binding from wrangler.toml, which lives in worker/.
// Running it from the repo root finds no config and reports the database as
// missing rather than as misconfigured, which is a confusing five minutes.
const WORKER_DIR = fileURLToPath(new URL('../worker', import.meta.url));

export type Row = {
  id: string;
  user_id: string;
  ts_utc: number;
  tz: string;
  logical_day: string;
  local_hour: number;
  bucket: string;
};

export type Update = {
  id: string;
  from: { logical_day: string; local_hour: number; bucket: string };
  to: { logical_day: string; local_hour: number; bucket: string };
};

/**
 * The pure half: what would change, given rows and a boundary per user.
 * Separated so it can be tested without a database — the SQL below is
 * mechanical, this is where a mistake would be silent.
 */
export function planRebuild(rows: Row[], boundaryFor: (userId: string) => number): Update[] {
  const updates: Update[] = [];
  for (const row of rows) {
    const next = derive(row.ts_utc, row.tz, boundaryFor(row.user_id));
    if (
      next.logical_day !== row.logical_day ||
      next.local_hour !== row.local_hour ||
      next.bucket !== row.bucket
    ) {
      updates.push({
        id: row.id,
        from: { logical_day: row.logical_day, local_hour: row.local_hour, bucket: row.bucket },
        to: next,
      });
    }
  }
  return updates;
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function updateStatements(updates: Update[]): string[] {
  return updates.map(u =>
    `UPDATE events SET logical_day = ${sqlString(u.to.logical_day)}, ` +
    `local_hour = ${u.to.local_hour}, bucket = ${sqlString(u.to.bucket)} ` +
    `WHERE id = ${sqlString(u.id)};`
  );
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function d1(args: string[], where: string): any {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DB, where, '--json', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: WORKER_DIR,
  });
  // wrangler prints a banner before the JSON on some versions.
  const start = out.indexOf('[');
  return JSON.parse(start >= 0 ? out.slice(start) : out);
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const where = argv.includes('--local') ? '--local' : '--remote';
  const boundaryArg = argv.find(a => a.startsWith('--boundary='));
  const userArg = argv.find(a => a.startsWith('--user='));
  const forcedBoundary = boundaryArg ? Number(boundaryArg.split('=')[1]) : null;
  const onlyUser = userArg ? userArg.split('=')[1] : null;

  const filter = onlyUser ? ` WHERE user_id = ${sqlString(onlyUser)}` : '';
  const rows: Row[] = d1(
    ['--command', `SELECT id, user_id, ts_utc, tz, logical_day, local_hour, bucket FROM events${filter}`],
    where
  )[0].results;

  const settings: { user_id: string; day_boundary_hour: number }[] =
    d1(['--command', 'SELECT user_id, day_boundary_hour FROM settings'], where)[0].results;
  const perUser = new Map(settings.map(s => [s.user_id, s.day_boundary_hour ?? 4]));
  const boundaryFor = (u: string) => forcedBoundary ?? perUser.get(u) ?? 4;

  const updates = planRebuild(rows, boundaryFor);
  console.log(`${rows.length} event(s) read, ${updates.length} would change.`);

  for (const u of updates.slice(0, 20)) {
    console.log(`  ${u.id}  ${u.from.logical_day}/${u.from.bucket} → ${u.to.logical_day}/${u.to.bucket}`);
  }
  if (updates.length > 20) console.log(`  … and ${updates.length - 20} more`);

  if (!updates.length) return;
  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write these.');
    return;
  }

  const file = join(mkdtempSync(join(tmpdir(), 'cadence-rebuild-')), 'rebuild.sql');
  writeFileSync(file, updateStatements(updates).join('\n') + '\n');
  execFileSync('npx', ['wrangler', 'd1', 'execute', DB, where, '--file', file], { stdio: 'inherit', cwd: WORKER_DIR });
  console.log(`\nApplied ${updates.length} update(s). Re-run without --apply to confirm it is now a no-op.`);
}

if (import.meta.filename === process.argv[1]) main();
