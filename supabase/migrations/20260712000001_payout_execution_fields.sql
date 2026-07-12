-- Track auto-payout attempts and Sphere DM confirmation for weekly winners.

ALTER TABLE payout_records
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recipient TEXT,
  ADD COLUMN IF NOT EXISTS dm_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dm_error TEXT;

COMMENT ON COLUMN payout_records.recipient IS 'Resolved Sphere recipient used for pay/DM (@nametag or address)';
COMMENT ON COLUMN payout_records.dm_sent_at IS 'When congrats DM was successfully sent via Sphere communications';
COMMENT ON COLUMN payout_records.failure_reason IS 'Last pay failure message (cleared on success)';
COMMENT ON COLUMN payout_records.attempt_count IS 'Number of pay attempts (for retry backoff/caps)';

CREATE INDEX IF NOT EXISTS idx_payout_records_pending
  ON payout_records(status, created_at)
  WHERE status IN ('pending', 'failed');
