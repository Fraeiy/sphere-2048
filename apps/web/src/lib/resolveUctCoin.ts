import { UCT_TESTNET2_COIN_ID } from '@sphere-2048/shared';

interface WalletAsset {
  symbol?: string;
  coinId?: string;
}

type QueryClient = { query: (method: string) => Promise<unknown> };

/** Resolve lowercase hex coin id for UCT — env override, then wallet assets, then testnet2 default. */
export async function resolveUctCoinId(client: QueryClient): Promise<string> {
  const fromEnv = import.meta.env.VITE_UCT_COIN_ID?.toLowerCase();
  if (fromEnv) return fromEnv;

  try {
    const assets = await client.query('sphere_getAssets');
    if (Array.isArray(assets)) {
      const uct = (assets as WalletAsset[]).find((a) => a.symbol === 'UCT');
      if (uct?.coinId) return uct.coinId.toLowerCase();
    }
  } catch (err) {
    console.warn('[resolveUctCoin] sphere_getAssets failed, using testnet2 default', err);
  }

  return UCT_TESTNET2_COIN_ID;
}