-- Reclassify pre-split morning answers.
--
-- Until today both check-ins wrote kind='daily', so a morning tap at 09:00
-- marked the whole day confirmed before it had happened. Leaving these rows
-- alone would be worse than rewriting them: confirmed_days would keep counting
-- five days that were never reviewed, and every week before today would be
-- overstated relative to every week after, making a trend across the change
-- look like a decline that never happened.
--
-- The rule is deliberately narrow — a reading, no note, and a morning hour.
-- Rows that could plausibly be either (2026-09-10 at 14:00, 2026-08-31 at
-- 21:00) are left as `daily`, which errs toward keeping a day confirmed rather
-- than removing one on a guess.
--
-- Rollback: scripts/migrations/2026-09-15-morning-check.rollback.sql, which
-- names the nine ids explicitly rather than re-running this predicate.
UPDATE events SET kind = 'morning_check'
WHERE kind = 'daily'
  AND morning_wood IS NOT NULL
  AND note IS NULL
  AND local_hour BETWEEN 4 AND 12;
