-- Backfill leaderboard entries for players whose best_score was saved but never
-- recorded on the leaderboard (e.g. game-over move not synced to server).

INSERT INTO leaderboard_entries (
  player_id,
  game_session_id,
  wallet_address,
  player_did,
  score,
  highest_tile,
  period_type,
  weekly_round_id
)
SELECT
  p.id,
  gs.id,
  p.wallet_address,
  p.did,
  p.best_score,
  gs.highest_tile,
  'global'::leaderboard_period,
  NULL
FROM players p
JOIN LATERAL (
  SELECT id, highest_tile, score
  FROM game_sessions
  WHERE player_id = p.id
    AND score > 0
  ORDER BY score DESC, ended_at DESC NULLS LAST, created_at DESC
  LIMIT 1
) gs ON true
WHERE p.best_score > 0
  AND NOT EXISTS (
    SELECT 1
    FROM leaderboard_entries le
    WHERE le.player_id = p.id
      AND le.period_type = 'global'
      AND le.score >= p.best_score
  )
ON CONFLICT (game_session_id, period_type) DO UPDATE
SET score = GREATEST(leaderboard_entries.score, EXCLUDED.score),
    highest_tile = GREATEST(leaderboard_entries.highest_tile, EXCLUDED.highest_tile),
    recorded_at = now();

-- Weekly entries for the current open round.
INSERT INTO leaderboard_entries (
  player_id,
  game_session_id,
  wallet_address,
  player_did,
  score,
  highest_tile,
  period_type,
  weekly_round_id
)
SELECT
  p.id,
  gs.id,
  p.wallet_address,
  p.did,
  p.best_score,
  gs.highest_tile,
  'weekly'::leaderboard_period,
  wr.id
FROM players p
JOIN weekly_rounds wr ON wr.status = 'active'
JOIN LATERAL (
  SELECT id, highest_tile, score, weekly_round_id
  FROM game_sessions
  WHERE player_id = p.id
    AND score > 0
    AND weekly_round_id = wr.id
  ORDER BY score DESC, ended_at DESC NULLS LAST, created_at DESC
  LIMIT 1
) gs ON true
WHERE p.best_score > 0
  AND NOT EXISTS (
    SELECT 1
    FROM leaderboard_entries le
    WHERE le.player_id = p.id
      AND le.period_type = 'weekly'
      AND le.weekly_round_id = wr.id
      AND le.score >= p.best_score
  )
ON CONFLICT (game_session_id, period_type) DO UPDATE
SET score = GREATEST(leaderboard_entries.score, EXCLUDED.score),
    highest_tile = GREATEST(leaderboard_entries.highest_tile, EXCLUDED.highest_tile),
    recorded_at = now();