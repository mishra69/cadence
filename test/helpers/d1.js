// A D1-shaped facade over node:sqlite, so the Worker's queries are exercised
// against the real schema.js file in tests rather than a hand-written mock.
//
// This covers only the slice of the D1 API the Worker actually uses. If a query
// here passes and production fails, the difference is SQLite-version behaviour,
// which is the one thing a mock could never have caught either.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA = fileURLToPath(new URL('../../worker/schema.sql', import.meta.url));

class Stmt {
  constructor(db, sql, params = []) {
    this.db = db; this.sql = sql; this.params = params;
  }
  bind(...params) {
    // D1 accepts undefined for an absent value; node:sqlite throws on it.
    return new Stmt(this.db, this.sql, params.map(p => (p === undefined ? null : p)));
  }
  run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return Promise.resolve({
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    });
  }
  first(col) {
    const row = this.db.prepare(this.sql).get(...this.params) ?? null;
    return Promise.resolve(col && row ? row[col] : row);
  }
  all() {
    return Promise.resolve({ success: true, results: this.db.prepare(this.sql).all(...this.params) });
  }
}

export function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA, 'utf8'));
  return {
    prepare: sql => new Stmt(db, sql),
    batch: stmts => Promise.all(stmts.map(s => s.all())),
    _raw: db,
  };
}
