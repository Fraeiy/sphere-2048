-- Persist per-player best score across game sessions.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS best_score INTEGER NOT NULL DEFAULT 0 CHECK (best_score >= 0);

UPDATE players p
SET best_score = COALESCE((
  SELECT MAX(gs.score)
  FROM game_sessions gs
  WHERE gs.player_id = p.id
    AND gs.status = 'completed'
    AND gs.score > 0
), 0)
WHERE best_score = 0;

CREATE OR REPLACE FUNCTION update_best_score_if_higher(p_player_id UUID, p_score INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_best INTEGER;
BEGIN
  IF p_score IS NULL OR p_score <= 0 THEN
    SELECT best_score INTO v_best FROM players WHERE id = p_player_id;
    RETURN COALESCE(v_best, 0);
  END IF;

  UPDATE players
  SET best_score = p_score, updated_at = now()
  WHERE id = p_player_id AND p_score > best_score
  RETURNING best_score INTO v_best;

  IF v_best IS NULL THEN
    SELECT best_score INTO v_best FROM players WHERE id = p_player_id;
  END IF;

  RETURN COALESCE(v_best, 0);
END;
$$;