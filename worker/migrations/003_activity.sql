-- Streak staleness. The streak is elapsed time since the last relapse, which is
-- only meaningful while relapses are actually being logged — stop using the app
-- and it grows forever, rewarding abandonment. These three columns let it say
-- "unconfirmed" instead of asserting something nothing backs up.
--
-- Never a reset: §3 rejected that for a good reason, and still does. Pausing is
-- a different thing from punishing.
ALTER TABLE settings ADD COLUMN last_seen_at INTEGER;
ALTER TABLE settings ADD COLUMN pending_gap_start INTEGER;
ALTER TABLE settings ADD COLUMN stale_after_days INTEGER DEFAULT 3;
