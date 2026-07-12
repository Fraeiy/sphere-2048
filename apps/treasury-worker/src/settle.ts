import { WEEKLY_PAYOUT_SHARES_BPS } from '@sphere-2048/shared';
import type { Db } from './supabase.js';

interface WeeklyEntry {
  player_id: string;
  wallet_address: string;
  score: number;
  highest_tile: number;
}

function topUniquePlayers(entries: WeeklyEntry[], limit: number): WeeklyEntry[] {
  const bestByPlayer = new Map<string, WeeklyEntry>();
  for (const entry of entries) {
    const existing = bestByPlayer.get(entry.player_id);
    if (!existing || entry.score > existing.score) {
      bestByPlayer.set(entry.player_id, entry);
    }
  }
  return [...bestByPlayer.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface SettleResult {
  settled: boolean;
  message?: string;
  roundId?: string;
  roundNumber?: number;
  payoutsCreated: number;
  winners: WeeklyEntry[];
}

/**
 * Close expired active weekly round(s): write top-5 payout_records, open next week.
 * Safe to call when no round is due — returns settled: false.
 */
export async function settleExpiredRound(db: Db): Promise<SettleResult> {
  const { data: rounds, error: roundsErr } = await db
    .from('weekly_rounds')
    .select('*')
    .eq('status', 'active')
    .lt('ends_at', new Date().toISOString())
    .order('round_number', { ascending: true })
    .limit(1);

  if (roundsErr) throw roundsErr;

  const round = rounds?.[0];
  if (!round) {
    return { settled: false, message: 'No round ready for settlement', payoutsCreated: 0, winners: [] };
  }

  console.log(
    `[settle] Closing round #${round.round_number} (${round.id}), pool=${round.prize_pool_atomic}`,
  );

  const { error: settlingErr } = await db
    .from('weekly_rounds')
    .update({ status: 'settling' })
    .eq('id', round.id)
    .eq('status', 'active');
  if (settlingErr) throw settlingErr;

  const { data: entries, error: entriesErr } = await db
    .from('leaderboard_entries')
    .select('player_id, wallet_address, score, highest_tile')
    .eq('period_type', 'weekly')
    .eq('weekly_round_id', round.id)
    .order('score', { ascending: false })
    .limit(100);
  if (entriesErr) throw entriesErr;

  const winners = topUniquePlayers((entries ?? []) as WeeklyEntry[], WEEKLY_PAYOUT_SHARES_BPS.length);
  const pool = BigInt(String(round.prize_pool_atomic ?? '0'));
  const payouts = [];

  for (let i = 0; i < winners.length; i++) {
    const shareBps = WEEKLY_PAYOUT_SHARES_BPS[i] ?? 0;
    const amount = (pool * BigInt(shareBps)) / 10000n;
    if (amount <= 0n) continue;
    payouts.push({
      weekly_round_id: round.id,
      player_id: winners[i].player_id,
      rank: i + 1,
      amount_atomic: amount.toString(),
      wallet_address: winners[i].wallet_address,
      status: 'pending',
    });
  }

  if (payouts.length) {
    const { error: upsertErr } = await db.from('payout_records').upsert(payouts, {
      onConflict: 'weekly_round_id,rank',
    });
    if (upsertErr) throw upsertErr;
  }

  const { error: completeErr } = await db
    .from('weekly_rounds')
    .update({
      status: 'completed',
      settled_at: new Date().toISOString(),
    })
    .eq('id', round.id);
  if (completeErr) throw completeErr;

  const nextStart = new Date(round.ends_at);
  const nextEnd = new Date(nextStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { error: nextErr } = await db.from('weekly_rounds').insert({
    round_number: round.round_number + 1,
    starts_at: nextStart.toISOString(),
    ends_at: nextEnd.toISOString(),
    status: 'active',
  });
  // Unique violation if next round already exists is fine.
  if (nextErr && !/duplicate|unique/i.test(nextErr.message)) {
    throw nextErr;
  }

  console.log(
    `[settle] Round #${round.round_number} settled — ${payouts.length} payouts, next week opened`,
  );

  return {
    settled: true,
    roundId: round.id,
    roundNumber: round.round_number,
    payoutsCreated: payouts.length,
    winners,
  };
}
