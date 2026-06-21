/** UCT uses 18 decimal places on testnet2. */
export const UCT_DECIMALS = 18;
export const UCT_ATOMIC_PER_TOKEN = 10n ** 18n;

/** Canonical UCT coin id on Unicity testnet2 (from unicity-ids.testnet2.json). */
export const UCT_TESTNET2_COIN_ID = 'f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0';

export function uctToAtomic(amount: number | string): bigint {
  const [whole, frac = ''] = String(amount).split('.');
  const padded = (frac + '0'.repeat(UCT_DECIMALS)).slice(0, UCT_DECIMALS);
  return BigInt(whole + padded);
}

export function atomicToUct(amount: bigint | number): number {
  const value = typeof amount === 'bigint' ? amount : BigInt(amount);
  return Number(value) / Number(UCT_ATOMIC_PER_TOKEN);
}

export interface CreditTierInput {
  token_amount: string;
  moves_granted: number;
}

/**
 * Resolves moves for a deposit amount using exact tier match first,
 * then proportional fallback based on the smallest active tier ratio.
 */
export function resolveMovesFromDeposit(
  amountAtomic: bigint,
  tiers: CreditTierInput[],
): { moves: number; matchedTier: CreditTierInput | null } {
  const sorted = [...tiers].sort(
    (a, b) => Number(b.token_amount) - Number(a.token_amount),
  );

  const amountUct = atomicToUct(amountAtomic);

  for (const tier of sorted) {
    if (amountUct === Number(tier.token_amount)) {
      return { moves: tier.moves_granted, matchedTier: tier };
    }
  }

  const base = sorted.at(-1);
  if (!base) return { moves: 0, matchedTier: null };

  const ratio = base.moves_granted / Number(base.token_amount);
  return {
    moves: Math.floor(amountUct * ratio),
    matchedTier: null,
  };
}

/** Prize pool contribution: 50% of weekly deposits go to the weekly prize pool. */
export const PRIZE_POOL_CONTRIBUTION_BPS = 5000; // 50.00%

export function prizePoolContribution(amountAtomic: bigint): bigint {
  return (amountAtomic * BigInt(PRIZE_POOL_CONTRIBUTION_BPS)) / 10000n;
}

/** Top 5 weekly winners: 35% / 25% / 20% / 15% / 5% of the prize pool. */
export const WEEKLY_PAYOUT_SHARES_BPS = [3500, 2500, 2000, 1500, 500] as const;