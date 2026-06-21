-- Fix ambiguous column reference in deduct_move_credit (PostgreSQL 42702)
CREATE OR REPLACE FUNCTION deduct_move_credit(p_player_id UUID)
RETURNS TABLE (
  success BOOLEAN,
  credits_remaining INTEGER,
  new_version INTEGER
) AS $$
DECLARE
  v_row move_balances%ROWTYPE;
  v_remaining INTEGER;
  v_version INTEGER;
BEGIN
  SELECT * INTO v_row FROM move_balances WHERE player_id = p_player_id FOR UPDATE;

  IF NOT FOUND OR v_row.credits_remaining <= 0 THEN
    RETURN QUERY SELECT false, COALESCE(v_row.credits_remaining, 0), COALESCE(v_row.version, 0);
    RETURN;
  END IF;

  UPDATE move_balances
  SET credits_remaining = move_balances.credits_remaining - 1,
      version = move_balances.version + 1,
      updated_at = now()
  WHERE player_id = p_player_id
  RETURNING move_balances.credits_remaining, move_balances.version
  INTO v_remaining, v_version;

  RETURN QUERY SELECT true, v_remaining, v_version;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;