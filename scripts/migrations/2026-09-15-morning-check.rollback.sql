-- Rollback for 2026-09-15 morning_check migration.
-- Restores these 9 rows to kind=daily. Generated before the UPDATE ran;
-- the ids are the authority, not the heuristic that selected them.

-- 2026-09-04  10:00  mw=0
-- 2026-09-05   9:00  mw=1
-- 2026-09-06  10:00  mw=0
-- 2026-09-07  10:00  mw=0
-- 2026-09-08  10:00  mw=1
-- 2026-09-09  11:00  mw=4
-- 2026-09-11  10:00  mw=2
-- 2026-09-14   9:00  mw=0
-- 2026-09-15  10:00  mw=0

UPDATE events SET kind = 'daily' WHERE id IN (
  '3b0822aa-282f-45b8-96f5-588fe8200240',
  '6e399446-490e-4663-8d88-440bb0e133d3',
  'f15b0cc2-541b-4da8-a93c-0e58c3dfb22a',
  '9787dfda-6359-4489-93ab-97cec38dc239',
  '1f48fa72-97fa-4802-aec0-84e40a053fe1',
  '10ddb9d9-75ee-4fa1-9509-ddd81012dcf8',
  '2ab75ea3-8402-49a8-a767-14ca22823c13',
  'df3fe472-70ea-48fd-8317-7aa04c3dfbf1',
  'e112cdcc-76df-430e-82b9-64b7257f0254'
);
