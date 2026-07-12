/**
 * Sphere 2048 treasury worker
 *
 * Single cron pipeline:
 *   1. Settle expired weekly round → top-5 payout_records + open new week
 *   2. Auto-pay pending UCT prizes from treasury Sphere wallet
 *   3. Send Sphere DMs with congrats / payment confirmation
 *
 * Schedule (example): hourly
 *   cd apps/treasury-worker && npm run settle-and-pay
 */
import { assertTreasurySecrets, config } from './config.js';
import { executePendingPayouts } from './payout.js';
import { settleExpiredRound } from './settle.js';
import { initTreasurySphere } from './sphere.js';
import { createDb } from './supabase.js';

async function main() {
  console.log('[worker] Sphere 2048 weekly settle + pay starting', {
    dryRun: config.dryRun,
    network: config.network,
  });

  const db = createDb();

  // 1) Settle last week if ends_at has passed
  const settle = await settleExpiredRound(db);
  console.log('[worker] settle result', {
    settled: settle.settled,
    message: settle.message,
    roundNumber: settle.roundNumber,
    payoutsCreated: settle.payoutsCreated,
  });

  // 2–3) Pay + DM (also retries failed pays / missing DMs from prior weeks)
  assertTreasurySecrets(!config.dryRun);

  let sphereHandle: Awaited<ReturnType<typeof initTreasurySphere>> | null = null;
  try {
    if (!config.dryRun) {
      sphereHandle = await initTreasurySphere();
      const { sphere, created, generatedMnemonic } = sphereHandle;
      if (created && generatedMnemonic) {
        console.warn(
          '[worker] NEW treasury wallet generated — save this mnemonic immediately:',
          generatedMnemonic,
        );
      }
      console.log('[worker] treasury identity', {
        nametag: sphere.identity?.nametag,
        directAddress: sphere.identity?.directAddress,
      });
    }

    const pay = await executePendingPayouts(db, sphereHandle?.sphere ?? null);
    console.log('[worker] pay/dm summary', pay);

    console.log('[worker] done');
  } finally {
    if (sphereHandle?.sphere) {
      try {
        await sphereHandle.sphere.destroy();
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exitCode = 1;
});
