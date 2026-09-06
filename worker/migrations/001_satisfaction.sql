-- schema.sql uses CREATE TABLE IF NOT EXISTS, so it describes the shape a NEW
-- database gets and does nothing to one that already exists. Any column added
-- after the first deploy needs a migration like this, run once per database.
--
--   npx wrangler d1 execute cadence-db --local  --file=migrations/001_satisfaction.sql
--   npx wrangler d1 execute cadence-db --remote --file=migrations/001_satisfaction.sql
--
-- Re-running errors with "duplicate column name", which is harmless and is the
-- signal that it has already been applied.
ALTER TABLE events ADD COLUMN satisfaction INTEGER;
