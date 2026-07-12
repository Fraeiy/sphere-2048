-- Track partial multi-chunk UCT sends (Unicity may need several token transfers per prize).

ALTER TABLE payout_records
  ADD COLUMN IF NOT EXISTS amount_paid_atomic NUMERIC(38,0) NOT NULL DEFAULT 0;

COMMENT ON COLUMN payout_records.amount_paid_atomic IS
  'Atomic UCT already delivered when a prize is paid in multiple token chunks';
