-- Configurable deposit → move credit tiers
-- token_amount in whole UCT tokens; moves_granted per tier

INSERT INTO credit_tiers (token_symbol, token_amount, moves_granted, label, sort_order) VALUES
  ('UCT', 1,  50,  'Starter — 1 UCT',   1),
  ('UCT', 5,  300, 'Standard — 5 UCT',  2),
  ('UCT', 10, 700, 'Pro — 10 UCT',      3)
ON CONFLICT (token_symbol, token_amount) DO UPDATE
SET moves_granted = EXCLUDED.moves_granted,
    label = EXCLUDED.label,
    is_active = true,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();

-- Bootstrap first weekly round
INSERT INTO weekly_rounds (round_number, starts_at, ends_at, status)
SELECT 1,
       date_trunc('week', now()),
       date_trunc('week', now()) + interval '7 days',
       'active'
WHERE NOT EXISTS (SELECT 1 FROM weekly_rounds);