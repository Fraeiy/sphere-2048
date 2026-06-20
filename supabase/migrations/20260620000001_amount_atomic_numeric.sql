-- UCT uses 18 decimals: 10 UCT = 10^19 atomic units, which exceeds BIGINT max (~9.22e18).
-- Store atomic amounts as NUMERIC(38,0) across deposit/prize tables.

ALTER TABLE deposits
  ALTER COLUMN amount_atomic TYPE NUMERIC(38,0) USING amount_atomic::NUMERIC(38,0);

ALTER TABLE prize_pool_records
  ALTER COLUMN amount_atomic TYPE NUMERIC(38,0) USING amount_atomic::NUMERIC(38,0);

ALTER TABLE weekly_rounds
  ALTER COLUMN prize_pool_atomic TYPE NUMERIC(38,0) USING prize_pool_atomic::NUMERIC(38,0);

ALTER TABLE payout_records
  ALTER COLUMN amount_atomic TYPE NUMERIC(38,0) USING amount_atomic::NUMERIC(38,0);