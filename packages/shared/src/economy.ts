/** UCT uses 18 decimal places (same as current production). */
export const UCT_DECIMALS = 18;
export const UCT_ATOMIC_PER_TOKEN = 10n ** 18n;

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

/** Prize pool contribution: 10% of deposit to weekly pool (configurable constant). */
export const PRIZE_POOL_CONTRIBUTION_BPS = 1000; // 10.00%

export function prizePoolContribution(amountAtomic: bigint): bigint {
  return (amountAtomic * BigInt(PRIZE_POOL_CONTRIBUTION_BPS)) / 10000n;
}