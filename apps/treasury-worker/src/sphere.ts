import { Sphere, isSphereError } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';
import { UCT_TESTNET2_COIN_ID } from '@sphere-2048/shared';
import { mkdir } from 'node:fs/promises';
import { config } from './config.js';

export type TreasurySphere = Awaited<ReturnType<typeof initTreasurySphere>>['sphere'];

export async function initTreasurySphere() {
  await mkdir(config.dataDir, { recursive: true });

  const network = config.network === 'testnet2' ? 'testnet' : config.network;

  // SDK 0.14+: createNodeProviders only takes dataDir (tokens live in wallet-api inventory).
  const base = createNodeProviders({
    network,
    dataDir: config.dataDir,
    oracle: {
      apiKey: config.oracleApiKey,
    },
  });

  const providers = createWalletApiProviders(base, {
    baseUrl: config.walletApiUrl,
    network: 'testnet2',
    deviceId: config.deviceId,
  });

  const initOpts: Parameters<typeof Sphere.init>[0] = {
    ...providers,
    network: 'testnet2',
    communications: { cacheMessages: false },
  };

  if (config.treasuryMnemonic) {
    initOpts.mnemonic = config.treasuryMnemonic;
  } else {
    initOpts.autoGenerate = true;
  }
  if (config.treasuryPassword) {
    initOpts.password = config.treasuryPassword;
  }

  const { sphere, created, generatedMnemonic } = await Sphere.init(initOpts);

  // Resume any indeterminate sends from prior runs (money-safety).
  // SDK 0.14 renamed resumeOpenIntents → resumeNow.
  try {
    await sphere.payments.resumeNow();
    console.log('[sphere] resumeNow completed');
  } catch (err) {
    console.warn('[sphere] resumeNow failed (continuing)', err);
  }

  // Drain mailbox so balance is current before pays.
  try {
    await sphere.payments.receive();
  } catch (err) {
    console.warn('[sphere] receive() failed (continuing)', err);
  }

  return { sphere, created, generatedMnemonic };
}

export function resolveUctCoinId(): string {
  return config.uctCoinId ?? UCT_TESTNET2_COIN_ID;
}

export function sphereErrorInfo(err: unknown): {
  message: string;
  code?: string;
  certificationUnconfirmed: boolean;
} {
  if (isSphereError(err)) {
    const code = String((err as { code?: string }).code ?? '');
    return {
      message: err.message,
      code,
      certificationUnconfirmed: code === 'CERTIFICATION_UNCONFIRMED',
    };
  }
  return {
    message: err instanceof Error ? err.message : String(err),
    certificationUnconfirmed: false,
  };
}
