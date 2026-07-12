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

/** Human-readable place labels for DMs / UI. */
export const WEEKLY_PLACE_LABELS = ['1st', '2nd', '3rd', '4th', '5th'] as const;

/**
 * Format a player identity as a Sphere send/DM recipient.
 * Prefer nametag (@handle); fall back to raw L1 / DIRECT address.
 */
export function resolvePayoutRecipient(input: {
  nametag?: string | null;
  displayName?: string | null;
  did?: string | null;
  walletAddress: string;
}): string {
  const candidates = [input.nametag, input.displayName, input.did];
  for (const raw of candidates) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Skip DID-looking or address-like values that are not nametags.
    if (trimmed.startsWith('did:') || trimmed.startsWith('DIRECT://') || trimmed.startsWith('alpha1')) {
      continue;
    }
    // Long hex keys are not nametags.
    if (/^[0-9a-fA-F]{40,}$/.test(trimmed)) continue;
    if (trimmed.startsWith('@')) return trimmed;
    // Plain nametag (alphanumeric / underscore / hyphen)
    if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(trimmed)) {
      return `@${trimmed}`;
    }
  }
  return input.walletAddress.trim();
}

/** Congrats copy after a successful weekly prize payout. */
export function weeklyWinnerDmMessage(input: {
  rank: number;
  amountUct: string;
  roundNumber: number;
  score?: number;
}): string {
  const place =
    WEEKLY_PLACE_LABELS[input.rank - 1] ?? `#${input.rank}`;
  const scorePart =
    typeof input.score === 'number' ? ` (score ${input.score})` : '';
  return [
    `Congrats! You placed ${place}${scorePart} on Sphere 2048 — weekly round #${input.roundNumber}.`,
    `Your prize of ${input.amountUct} UCT has been sent from the weekly prize pool (1–2 transfers).`,
    `Thanks for playing — good luck next week!`,
  ].join(' ');
}