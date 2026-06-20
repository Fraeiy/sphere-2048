/** Default game treasury nametag on testnet2. */
export const DEFAULT_TREASURY_NAMETAG = '2048game';

/**
 * Format recipient for Sphere send intent.
 * Nametags must use @ prefix; raw alpha1/DIRECT addresses are passed through.
 */
export function formatTreasuryRecipient(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('@') || trimmed.startsWith('DIRECT://') || trimmed.startsWith('alpha1')) {
    return trimmed;
  }
  return `@${trimmed}`;
}

export function getTreasuryRecipient(): string {
  const nametag = import.meta.env.VITE_GAME_TREASURY_NAMETAG ?? DEFAULT_TREASURY_NAMETAG;
  return formatTreasuryRecipient(nametag);
}