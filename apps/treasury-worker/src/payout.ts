import {
  resolvePayoutRecipient,
  weeklyWinnerDmMessage,
  UCT_ATOMIC_PER_TOKEN,
} from '@sphere-2048/shared';
import { config } from './config.js';
import type { TreasurySphere } from './sphere.js';
import { resolveUctCoinId, sphereErrorInfo } from './sphere.js';
import type { Db } from './supabase.js';

/** Hard cap: each prize is at most this many `payments.send` calls (never 1-UCT spam). */
const MAX_SEND_SPLITS = 2;

interface PayoutRow {
  id: string;
  weekly_round_id: string;
  player_id: string;
  rank: number;
  amount_atomic: string | number;
  amount_paid_atomic?: string | number | null;
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
  if (typeof atomic === 'number') {
    return BigInt(Math.trunc(atomic)).toString();
  }
  return String(atomic).split('.')[0] ?? '0';
}

function toBig(atomic: string | number | null | undefined): bigint {
  if (atomic == null) return 0n;
  return BigInt(amountString(atomic));
}

function isEnvelopeError(message: string): boolean {
  return /envelope exceeds|VALIDATION_FAILED|too large|4096/i.test(message);
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
 *
 * Unicity note: one send may still unpack to multiple small token deliveries in the
 * wallet UI. We only issue at most {@link MAX_SEND_SPLITS} SDK send() calls per prize.
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
      'id, weekly_round_id, player_id, rank, amount_atomic, amount_paid_atomic, wallet_address, status, tx_hash, attempt_count, dm_sent_at, recipient',
    )
    .in('status', ['pending', 'failed'])
    .order('rank', { ascending: true })
    .limit(50);

  if (error) throw error;

  const { data: needDm, error: dmErr } = await db
    .from('payout_records')
    .select(
      'id, weekly_round_id, player_id, rank, amount_atomic, amount_paid_atomic, wallet_address, status, tx_hash, attempt_count, dm_sent_at, recipient',
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

    const total = toBig(row.amount_atomic);
    let paid = toBig(row.amount_paid_atomic);
    if (total <= 0n) {
      summary.skipped += 1;
      continue;
    }
    if (paid >= total) {
      // Already fully delivered but status not flipped — heal row.
      await db
        .from('payout_records')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          failure_reason: null,
          recipient,
        })
        .eq('id', row.id);
      summary.paid += 1;
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

    const remaining = total - paid;
    const totalUct = formatUct(total);

    if (config.dryRun || !sphere) {
      console.log(
        `[payout:dry-run] would pay rank ${row.rank} → ${recipient} remaining=${remaining} / total=${total} (${totalUct} UCT)`,
      );
      summary.skipped += 1;
      continue;
    }

    try {
      const refs: string[] = [];

      // Prefer a single send for the remainder; fall back to 1-UCT chunks if envelope is too big.
      const sendResult = await sendPrizeAmount(sphere, {
        recipient,
        coinId,
        remaining,
        alreadyPaid: paid,
        total,
        rank: row.rank,
        totalUct,
      });

      paid = sendResult.paidTotal;
      refs.push(...sendResult.refs);

      await db
        .from('payout_records')
        .update({
          amount_paid_atomic: paid.toString(),
          recipient,
        })
        .eq('id', row.id);

      if (paid < total) {
        throw new Error(
          `Partial pay ${paid}/${total} atomic — will retry remaining on next run`,
        );
      }

      const txRef = refs[0] ?? `sphere-${row.id}`;
      const { error: updateErr } = await db
        .from('payout_records')
        .update({
          status: 'sent',
          tx_hash: String(txRef),
          sent_at: new Date().toISOString(),
          failure_reason: null,
          amount_paid_atomic: total.toString(),
          recipient,
        })
        .eq('id', row.id)
        .in('status', ['pending', 'failed']);

      if (updateErr) throw updateErr;

      console.log(
        `[payout] sent rank ${row.rank} → ${recipient} total=${totalUct} UCT refs=${refs.length}`,
      );
      summary.paid += 1;

      const dmOk = await sendWinnerDm(
        db,
        sphere,
        {
          ...row,
          status: 'sent',
          tx_hash: String(txRef),
          recipient,
        },
        players,
        rounds,
      );
      if (dmOk) summary.dmsSent += 1;
      else summary.dmsFailed += 1;
    } catch (err) {
      const info = sphereErrorInfo(err);

      if (info.certificationUnconfirmed) {
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
          amount_paid_atomic: paid.toString(),
          recipient,
        })
        .eq('id', row.id);

      console.error(`[payout] failed rank ${row.rank} → ${recipient}:`, info.message);
      summary.failed += 1;
    }
  }

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

/**
 * Pay remaining prize amount with at most {@link MAX_SEND_SPLITS} sends:
 * 1) one full send, or
 * 2) if that fails envelope size → exactly two halves (part 1/2 + part 2/2).
 * No 1-UCT micro-chunks.
 */
async function sendPrizeAmount(
  sphere: TreasurySphere,
  opts: {
    recipient: string;
    coinId: string;
    remaining: bigint;
    alreadyPaid: bigint;
    total: bigint;
    rank: number;
    totalUct: string;
  },
): Promise<{ paidTotal: bigint; refs: string[] }> {
  const refs: string[] = [];
  let paid = opts.alreadyPaid;
  const remaining = opts.remaining;

  if (remaining <= 0n) {
    return { paidTotal: paid, refs };
  }

  const memoFor = (part: number, parts: number) => {
    const base = `Sphere 2048 weekly prize rank ${opts.rank} · ${opts.totalUct} UCT total`;
    return parts <= 1 ? base : `${base} · part ${part}/${parts}`;
  };

  const doSend = async (amount: bigint, part: number, parts: number) => {
    const result = await sphere.payments.send({
      recipient: opts.recipient,
      amount: amount.toString(),
      coinId: opts.coinId,
      memo: memoFor(part, parts),
    });
    const txRef =
      (result as { id?: string }).id ??
      (result as { transferId?: string }).transferId ??
      `pay-${part}-${Date.now()}`;
    refs.push(String(txRef));
    paid += amount;
    console.log(
      `[payout] send ${part}/${parts} ${formatUct(amount)} UCT → ${opts.recipient} ref=${txRef}` +
        ((result as { deliveryPending?: boolean }).deliveryPending
          ? ' (delivery pending)'
          : ''),
    );
  };

  // 1) Prefer a single send for the full remainder.
  try {
    await doSend(remaining, 1, 1);
    return { paidTotal: paid, refs };
  } catch (err) {
    const info = sphereErrorInfo(err);
    if (info.certificationUnconfirmed) throw err;
    if (!isEnvelopeError(info.message)) throw err;
    console.warn(
      `[payout] full send hit envelope limit — retrying as exactly ${MAX_SEND_SPLITS} splits: ${info.message}`,
    );
  }

  // 2) At most two splits: ceil(half) then remainder.
  if (MAX_SEND_SPLITS < 2) {
    throw new Error('Full send failed and MAX_SEND_SPLITS < 2 — cannot split further');
  }

  const first = (remaining + 1n) / 2n; // ceil(remaining / 2)
  const second = remaining - first;
  await doSend(first, 1, 2);
  if (second > 0n) {
    await doSend(second, 2, 2);
  }

  return { paidTotal: paid, refs };
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
  const amountAtomic = toBig(row.amount_atomic);
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
  const whole = amountAtomic / UCT_ATOMIC_PER_TOKEN;
  const frac = amountAtomic % UCT_ATOMIC_PER_TOKEN;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}
