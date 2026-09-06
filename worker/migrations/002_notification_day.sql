-- The planner needs to answer "has today's check-in already been planned?"
-- idempotently, so the target drawn at rollover stays stable across every
-- safety-net tick. Re-drawing the jitter each tick would slide the target
-- forward all evening and it might never arrive.
ALTER TABLE notifications ADD COLUMN logical_day TEXT;
CREATE INDEX IF NOT EXISTS idx_notifications_user_day
  ON notifications(user_id, kind, logical_day);
