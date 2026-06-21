-- Leaderboard reads: one row per player (their best score), not one row per game session.

CREATE OR REPLACE FUNCTION get_leaderboard(
  p_period leaderboard_period,
  p_weekly_round_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 50
)
RETURNS SETOF leaderboard_entries
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM (
    SELECT DISTINCT ON (player_id) *
    FROM leaderboard_entries
    WHERE period_type = p_period
      AND (
        p_period = 'global'
        OR (p_period = 'weekly' AND weekly_round_id = p_weekly_round_id)
      )
    ORDER BY player_id, score DESC, recorded_at DESC
  ) best_per_player
  ORDER BY score DESC, recorded_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;