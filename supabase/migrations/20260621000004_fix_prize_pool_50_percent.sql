-- Recalculate prize pool contributions at 50% of deposits (previous deploy used 10%).

UPDATE prize_pool_records p
SET amount_atomic = (d.amount_atomic * 5000) / 10000
FROM deposits d
WHERE p.deposit_id = d.id
  AND p.amount_atomic = (d.amount_atomic * 1000) / 10000;

UPDATE weekly_rounds wr
SET prize_pool_atomic = COALESCE((
  SELECT SUM(p.amount_atomic)
  FROM prize_pool_records p
  WHERE p.weekly_round_id = wr.id
), 0)
WHERE wr.status = 'active';