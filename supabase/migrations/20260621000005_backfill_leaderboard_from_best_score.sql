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
  w.address,
  p.did,
  p.best_score,
  gs.highest_tile,
  'global'::leaderboard_period,
  NULL
FROM players p
JOIN wallets w ON w.player_id = p.id AND w.is_primary = true
JOIN LATERAL (
  SELECT gs_inner.id, gs_inner.highest_tile, gs_inner.score
  FROM game_sessions gs_inner
  WHERE gs_inner.player_id = p.id
    AND gs_inner.score > 0
  ORDER BY gs_inner.score DESC, gs_inner.ended_at DESC NULLS LAST, gs_inner.started_at DESC
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
  w.address,
  p.did,
  p.best_score,
  gs.highest_tile,
  'weekly'::leaderboard_period,
  wr.id
FROM players p
JOIN wallets w ON w.player_id = p.id AND w.is_primary = true
JOIN weekly_rounds wr ON wr.status = 'active'
JOIN LATERAL (
  SELECT gs_inner.id, gs_inner.highest_tile, gs_inner.score, gs_inner.weekly_round_id
  FROM game_sessions gs_inner
  WHERE gs_inner.player_id = p.id
    AND gs_inner.score > 0
    AND gs_inner.weekly_round_id = wr.id
  ORDER BY gs_inner.score DESC, gs_inner.ended_at DESC NULLS LAST, gs_inner.started_at DESC
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