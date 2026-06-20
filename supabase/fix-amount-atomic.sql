-- Run once in Supabase SQL Editor if process-deposit returns 500 on 10 UCT deposits.
-- Fixes: BIGINT overflow when storing 10 UCT atomic (10^19 > 2^63-1).

ALTER TABLE deposits
  ALTER COLUMN amount_atomic TYPE NUMERIC(38,0) USING amount_atomic::NUMERIC(38,0);

ALTER TABLE prize_pool_records
  ALTER COLUMN amount_atomic TYPE NUMERIC(38,0) USING amount_atomic::NUMERIC(38,0);

ALTER TABLE weekly_rounds
  ALTER COLUMN prize_pool_atomic TYPE NUMERIC(38,0) USING prize_pool_atomic::NUMERIC(38,0);

ALTER TABLE payout_records
  ALTER COLUMN amount_atomic TYPE NUMERIC(38,0) USING amount_atomic::NUMERIC(38,0);