-- Cadence schema (plan §2). Event-sourced: nothing here is mutable state, and
-- there is deliberately no `streak` column — every metric is derived at read
-- time from ts_utc. See §3 for why logical_day is a cache and not a source.

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,      -- client-generated UUID → idempotent retries
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,         -- 'urge' | 'relapse' | 'daily' | 'note'

  -- source of truth
  ts_utc       INTEGER NOT NULL,      -- epoch ms — when it happened
  tz           TEXT NOT NULL,         -- IANA, e.g. 'Asia/Kolkata'. NEVER an offset.

  -- derived cache (rebuildable — scripts/rebuild-derived.ts)
  logical_day  TEXT NOT NULL,         -- 'YYYY-MM-DD', 4am-shifted, in tz
  local_hour   INTEGER NOT NULL,      -- 0–23
  bucket       TEXT NOT NULL,         -- 'morning'|'afternoon'|'evening'|'late'

  intensity    INTEGER,               -- 0–5, urge only
  satisfaction INTEGER,               -- 0–5, relapse only. The mirror of intensity:
                                      -- how much it was actually worth. Kept to
                                      -- correlate against the gap it ended.
  context      TEXT,                  -- JSON array: ['alone','in_bed','phone','tired','bored','stressed']
                                      -- recorded on BOTH urge and relapse events — comparing the
                                      -- two distributions is what replaces per-urge outcome
  morning_wood INTEGER,               -- 0–3, 'daily' only. A property of the day rather
                                      -- than a moment, so it lives on the check-in.
                                      -- NULL = not answered, which is not the same as 0.
  note         TEXT,                  -- free text, readable server-side by design (Appendix A)
  recalled     INTEGER NOT NULL DEFAULT 0,  -- 1 = backfilled via nightly sweep
  created_at   INTEGER NOT NULL       -- server receive time; differs from ts_utc when recalled
);

CREATE INDEX IF NOT EXISTS idx_events_user_ts  ON events(user_id, ts_utc);
CREATE INDEX IF NOT EXISTS idx_events_user_day ON events(user_id, logical_day);
CREATE INDEX IF NOT EXISTS idx_events_kind     ON events(user_id, kind, ts_utc);

CREATE TABLE IF NOT EXISTS push_subs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  tz TEXT, created_at INTEGER NOT NULL, last_ok_at INTEGER, fail_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'daily_sweep' | 'risk' | 'milestone'
  body TEXT NOT NULL,
  source TEXT NOT NULL,            -- 'llm' | 'fallback'
  risk_score REAL,
  logical_day TEXT,               -- the logical day this was planned for; one per (user, kind, day)
  scheduled_for INTEGER, sent_at INTEGER, opened_at INTEGER,
  suppressed_reason TEXT,          -- NULL if sent; 'cap' | 'gap' | 'unsane_hour'
  outcome_90m TEXT                 -- notification attribution only, unrelated to urge outcome:
                                   -- 'none' | 'urge_logged' | 'relapse' in the 90 min after send
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_sent ON notifications(user_id, sent_at);

CREATE TABLE IF NOT EXISTS message_pool (   -- phase 5: pre-generated, never generated at send time
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
  body TEXT NOT NULL, generated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, used_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY,
  daily_checkin_hour INTEGER DEFAULT 21,
  -- A second push, for the morning marker only. See migrations/005 for why this
  -- is a defensible exception to "one scheduled push per day".
  morning_checkin_hour INTEGER DEFAULT 10,
  morning_checkin_enabled INTEGER DEFAULT 1,
  daily_jitter_minutes INTEGER DEFAULT 25,   -- ± around daily_checkin_hour
  min_push_gap_minutes INTEGER DEFAULT 120,
  day_boundary_hour INTEGER DEFAULT 4,
  backfill_window_days INTEGER DEFAULT 3,
  risk_notifs_enabled INTEGER DEFAULT 0,
  max_pushes_per_day INTEGER DEFAULT 3,

  -- Activity, for streak staleness. Opening the app counts as activity for that
  -- day even if nothing is logged — that is itself a statement.
  last_seen_at INTEGER,
  -- Set when a gap is noticed, cleared when the user accounts for it. Persisted
  -- because last_seen_at is bumped on the very open that spots the gap, so
  -- without this the prompt would appear once and never again.
  pending_gap_start INTEGER,
  stale_after_days INTEGER DEFAULT 3,

  -- NULL = never asked, 'wanted' = a lock was set up, 'declined' = turned down.
  -- Kept server-side so a localStorage wipe cannot erase the fact that a lock
  -- was ever wanted — which is what separates a loss from a choice.
  lock_intent TEXT
);
