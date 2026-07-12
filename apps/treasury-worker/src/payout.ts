import {
  resolvePayoutRecipient,
  weeklyWinnerDmMessage,
} from '@sphere-2048/shared';
import { config } from './config.js';
import type { TreasurySphere } from './sphere.js';
import { resolveUctCoinId, sphereErrorInfo } from './sphere.js';
import type { Db } from './supabase.js';

interface PayoutRow {
  id: string;
  weekly_round_id: string;
  player_id: string;
  rank: number;
  amount_atomic: string | number;
  wallet_address: string;
  status: string;
  tx_hash: string | null;
  attempt_count: number | null;
  dm_sent_at: string | null;
  recipient: string | null;
}

interface PlayerRow {
  id: string;
  did: string;
  display_name: string | null;
}

interface RoundRow {
  id: string;
  round_number: number;
}

export interface PaySummary {
  paid: number;
  failed: number;
  skipped: number;
  dmsSent: number;
  dmsFailed: number;
}

function amountString(atomic: string | number): string {
  // Avoid scientific notation; keep integer string for Sphere amount.
  if (typeof atomic === 'number') {
    return BigInt(Math.trunc(atomic)).toString();
  }
  return String(atomic).split('.')[0] ?? '0';
}

async function loadPlayerMap(db: Db, playerIds: string[]): Promise<Map<string, PlayerRow>> {
  const map = new Map<string, PlayerRow>();
  if (!playerIds.length) return map;
  const { data, error } = await db
    .from('players')
    .select('id, did, display_name')
    .in('id', playerIds);
  if (error) throw error;
  for (const p of data ?? []) map.set(p.id, p as PlayerRow);
  return map;
}

async function loadRoundMap(db: Db, roundIds: string[]): Promise<Map<string, RoundRow>> {
  const map = new Map<string, RoundRow>();
  if (!roundIds.length) return map;
  const { data, error } = await db
    .from('weekly_rounds')
    .select('id, round_number')
    .in('id', roundIds);
  if (error) throw error;
  for (const r of data ?? []) map.set(r.id, r as RoundRow);
  return map;
}

/**
 * Pay pending/failed payouts from the treasury Sphere wallet, then send congrats DMs.
 * Idempotent: never re-sends when status is already `sent` with a tx_hash.
 */
export async function executePendingPayouts(
  db: Db,
  sphere: TreasurySphere | null,
): Promise<PaySummary> {
  const summary: PaySummary = {
    paid: 0,
    failed: 0,
    skipped: 0,
    dmsSent: 0,
    dmsFailed: 0,
  };

  const { data: rows, error } = await db
    .from('payout_records')
    .select(
      'id, weekly_round_id, player_id, rank, amount_atomic, wallet_address, status, tx_hash, attempt_count, dm_sent_at, recipient',
    )
    .in('status', ['pending', 'failed'])
    .order('rank', { ascending: true })
    .limit(50);

  if (error) throw error;

  // Also pick up `sent` rows missing DMs (pay succeeded, DM failed last run).
  const { data: needDm, error: dmErr } = await db
    .from('payout_records')
    .select(
      'id, weekly_round_id, player_id, rank, amount_atomic, wallet_address, status, tx_hash, attempt_count, dm_sent_at, recipient',
    )
    .eq('status', 'sent')
    .is('dm_sent_at', null)
    .limit(50);
  if (dmErr) throw dmErr;

  const payQueue = (rows ?? []) as PayoutRow[];
  const dmOnlyQueue = (needDm ?? []) as PayoutRow[];
  const allForContext = [...payQueue, ...dmOnlyQueue];

  if (!allForContext.length) {
    console.log('[payout] No pending payouts or DMs');
    return summary;
  }

  const players = await loadPlayerMap(
    db,
    [...new Set(allForContext.map((r) => r.player_id))],
  );
  const rounds = await loadRoundMap(
    db,
    [...new Set(allForContext.map((r) => r.weekly_round_id))],
  );

  const coinId = resolveUctCoinId();

  for (const row of payQueue) {
    const attempts = row.attempt_count ?? 0;
    if (attempts >= config.maxPayAttempts) {
      console.warn(`[payout] skip ${row.id} — attempt cap (${attempts})`);
      summary.skipped += 1;
      continue;
    }

    const player = players.get(row.player_id);
    const recipient =
      row.recipient ??
      resolvePayoutRecipient({
        displayName: player?.display_name,
        did: player?.did,
        walletAddress: row.wallet_address,
      });

    const amount = amountString(row.amount_atomic);
    if (amount === '0') {
      summary.skipped += 1;
      continue;
    }

    const now = new Date().toISOString();
    await db
      .from('payout_records')
      .update({
        attempt_count: attempts + 1,
        last_attempt_at: now,
        recipient,
      })
      .eq('id', row.id);

    if (config.dryRun || !sphere) {
      console.log(
        `[payout:dry-run] would pay rank ${row.rank} → ${recipient} amount=${amount}`,
      );
      summary.skipped += 1;
      continue;
    }

    try {
      const result = await sphere.payments.send({
        recipient,
        amount,
        coinId,
        memo: `Sphere 2048 weekly prize rank ${row.rank}`,
      });

      const txRef =
        (result as { id?: string; transferId?: string }).id ??
        (result as { transferId?: string }).transferId ??
        `sphere-${row.id}`;

      const status = (result as { status?: string }).status;
      // completed / deliveryPending both count as paid (token certified).
      if (status && status !== 'completed' && status !== 'delivered' && status !== 'confirmed') {
        // Still treat completed-or-better; if ambiguous completed is success path above
      }

      const { error: updateErr } = await db
        .from('payout_records')
        .update({
          status: 'sent',
          tx_hash: String(txRef),
          sent_at: new Date().toISOString(),
          failure_reason: null,
          recipient,
        })
        .eq('id', row.id)
        .in('status', ['pending', 'failed']);

      if (updateErr) throw updateErr;

      console.log(
        `[payout] sent rank ${row.rank} → ${recipient} amount=${amount} ref=${txRef}` +
          ((result as { deliveryPending?: boolean }).deliveryPending
            ? ' (delivery pending)'
            : ''),
      );
      summary.paid += 1;

      const dmOk = await sendWinnerDm(db, sphere, {
        ...row,
        status: 'sent',
        tx_hash: String(txRef),
        recipient,
      }, players, rounds);
      if (dmOk) summary.dmsSent += 1;
      else summary.dmsFailed += 1;
    } catch (err) {
      const info = sphereErrorInfo(err);

      if (info.certificationUnconfirmed) {
        // Possibly already on-chain — DO NOT re-send next time as a fresh transfer.
        // Mark as sent with placeholder so we don't double-pay; resumeOpenIntents will finish.
        const ref = `unconfirmed-${row.id}`;
        await db
          .from('payout_records')
          .update({
            status: 'sent',
            tx_hash: ref,
            sent_at: new Date().toISOString(),
            failure_reason: 'CERTIFICATION_UNCONFIRMED — resume intents; do not re-send',
            recipient,
          })
          .eq('id', row.id);
        console.warn(
          `[payout] CERTIFICATION_UNCONFIRMED for ${row.id} — marked sent, will not re-issue`,
        );
        summary.paid += 1;
        continue;
      }

      await db
        .from('payout_records')
        .update({
          status: 'failed',
          failure_reason: info.message.slice(0, 500),
          recipient,
        })
        .eq('id', row.id);

      console.error(`[payout] failed rank ${row.rank} → ${recipient}:`, info.message);
      summary.failed += 1;
    }
  }

  // Retry DMs for already-paid winners.
  for (const row of dmOnlyQueue) {
    if (config.dryRun || !sphere) {
      console.log(`[payout:dry-run] would DM ${row.recipient ?? row.wallet_address}`);
      summary.skipped += 1;
      continue;
    }
    const dmOk = await sendWinnerDm(db, sphere, row, players, rounds);
    if (dmOk) summary.dmsSent += 1;
    else summary.dmsFailed += 1;
  }

  return summary;
}

async function sendWinnerDm(
  db: Db,
  sphere: TreasurySphere,
  row: PayoutRow,
  players: Map<string, PlayerRow>,
  rounds: Map<string, RoundRow>,
): Promise<boolean> {
  if (row.dm_sent_at) return true;

  const player = players.get(row.player_id);
  const recipient =
    row.recipient ??
    resolvePayoutRecipient({
      displayName: player?.display_name,
      did: player?.did,
      walletAddress: row.wallet_address,
    });

  const round = rounds.get(row.weekly_round_id);
  const amountAtomic = BigInt(amountString(row.amount_atomic));
  // Prefer full precision string without float junk when possible.
  const amountUct = formatUct(amountAtomic);

  const message = weeklyWinnerDmMessage({
    rank: row.rank,
    amountUct,
    roundNumber: round?.round_number ?? 0,
  });

  try {
    await sphere.communications.sendDM(recipient, message);
    await db
      .from('payout_records')
      .update({
        dm_sent_at: new Date().toISOString(),
        dm_error: null,
        recipient,
      })
      .eq('id', row.id);
    console.log(`[dm] sent congrats → ${recipient} (rank ${row.rank})`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .from('payout_records')
      .update({
        dm_error: msg.slice(0, 500),
        recipient,
      })
      .eq('id', row.id);
    console.error(`[dm] failed → ${recipient}:`, msg);
    return false;
  }
}

function formatUct(amountAtomic: bigint): string {
  // UCT_DECIMALS = 18 in shared; avoid huge float errors for display.
  const whole = amountAtomic / 10n ** 18n;
  const frac = amountAtomic % 10n ** 18n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}
