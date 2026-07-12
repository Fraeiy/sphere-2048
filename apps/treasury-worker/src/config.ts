import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(process.cwd(), '.env') });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export const config = {
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),

  treasuryMnemonic: process.env.TREASURY_MNEMONIC?.trim() || '',
  treasuryPassword: process.env.TREASURY_PASSWORD?.trim() || undefined,
  treasuryNametag: optional('TREASURY_NAMETAG', '2048game'),

  dataDir: optional('TREASURY_DATA_DIR', './data/wallet'),
  tokensDir: optional('TREASURY_TOKENS_DIR', './data/tokens'),
  deviceId: optional('TREASURY_DEVICE_ID', 'sphere-2048-treasury-worker'),

  network: optional('SPHERE_NETWORK', 'testnet2') as 'testnet' | 'testnet2' | 'mainnet' | 'dev',
  oracleApiKey: optional(
    'SPHERE_ORACLE_API_KEY',
    'sk_ddc3cfcc001e4a28ac3fad7407f99590',
  ),
  walletApiUrl: optional('SPHERE_WALLET_API_URL', 'https://wallet-api.unicity.network'),
  uctCoinId: process.env.UCT_COIN_ID?.trim().toLowerCase() || undefined,

  maxPayAttempts: Math.max(1, parseInt(optional('MAX_PAY_ATTEMPTS', '5'), 10) || 5),
  dryRun: /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? ''),
};

export function assertTreasurySecrets(forPayments: boolean): void {
  if (!forPayments) return;
  if (config.dryRun) return;
  if (!config.treasuryMnemonic) {
    throw new Error(
      'TREASURY_MNEMONIC is required for live payouts (or set DRY_RUN=true)',
    );
  }
}
